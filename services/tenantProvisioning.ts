// Provisioning tenant (Fase D1) — creazione di un ristorante nuovo.
//
// Tutto in UNA transazione: o il tenant nasce completo (riga tenants, matrice
// permessi, orari, entitlement, utente OWNER) o non nasce affatto. Un tenant
// a metà — per esempio senza OWNER perché l'email era già presa — sarebbe
// irraggiungibile e andrebbe ripulito a mano.
//
// Chi chiama (POST /admin/tenants) riceve la password temporanea dell'OWNER
// e la mostra UNA volta: qui non si invia nessuna email di invito, perché la
// casella SMTP del nuovo tenant non esiste ancora — l'invito via email arriva
// quando il tenant ha una casella configurata (integration_settings).
import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import pool from '../db.js';
import { TENANT_FEATURES, type TenantFeature } from './entitlements.js';

// Stessa CHECK della colonna tenants.slug (migration tenants-e-tenant-id):
// validare prima dell'INSERT dà un errore tipizzato invece del 23514 anonimo.
const SLUG_REGEX = /^[a-z0-9][a-z0-9-]*$/;

export type ProvisioningErrorCode =
    | 'invalid_slug'
    | 'invalid_name'
    | 'invalid_email'
    | 'slug_conflict'
    | 'email_conflict';

// Errore tipizzato: il codice distingue input malformato (→ 400) da
// conflitto di unicità (→ 409) senza fare pattern-matching sui messaggi.
export class ProvisioningError extends Error {
    constructor(public readonly code: ProvisioningErrorCode, message: string) {
        super(message);
        this.name = 'ProvisioningError';
    }
}

export interface ProvisionTenantInput {
    slug: string;
    name: string;
    timezone?: string;
    owner_email: string;
    owner_full_name?: string;
    features?: Partial<Record<TenantFeature, boolean>>;
}

export interface ProvisionedTenant {
    id: number;
    slug: string;
    name: string;
    status: string;
    timezone: string;
    created_at: string;
}

export interface ProvisionTenantResult {
    tenant: ProvisionedTenant;
    // Password temporanea dell'OWNER: esiste solo qui, in chiaro, per essere
    // mostrata una volta al provisioning. A DB va solo l'hash bcrypt.
    ownerTempPassword: string;
    tokens: {
        webhook_token: string;
        print_agent_token: string;
    };
}

export async function provisionTenant(input: ProvisionTenantInput): Promise<ProvisionTenantResult> {
    const slug = String(input.slug ?? '').trim().toLowerCase();
    const name = String(input.name ?? '').trim();
    const timezone = String(input.timezone ?? 'Europe/Rome').trim();
    const ownerEmail = String(input.owner_email ?? '').trim().toLowerCase();
    const ownerFullName = String(input.owner_full_name ?? '').trim() || 'Owner';

    if (!slug || slug.length > 60 || !SLUG_REGEX.test(slug)) {
        throw new ProvisioningError('invalid_slug', 'Slug non valido: minuscole, cifre e trattini, deve iniziare con lettera o cifra.');
    }
    if (!name || name.length > 120) {
        throw new ProvisioningError('invalid_name', 'Nome mancante o troppo lungo (max 120).');
    }
    // Validazione email minima (una @ con qualcosa intorno): il filtro vero è
    // l'unicità globale — l'email è la chiave di login su tutta la piattaforma.
    if (!ownerEmail || ownerEmail.length > 255 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(ownerEmail)) {
        throw new ProvisioningError('invalid_email', 'Email OWNER non valida.');
    }

    // Token in JS (crypto.randomBytes), NON pgcrypto: stessa forma dei token
    // del tenant 1 (24 byte → 48 hex) ma generati qui, così il provisioning
    // non dipende dall'estensione e i token esistono già prima dell'INSERT.
    const webhookToken = crypto.randomBytes(24).toString('hex');
    const printAgentToken = crypto.randomBytes(24).toString('hex');
    // Password temporanea: 16 byte → 32 hex. Non indovinabile, e abbastanza
    // scomoda da spingere l'OWNER a cambiarla al primo accesso.
    const ownerTempPassword = crypto.randomBytes(16).toString('hex');
    // Stesso costo bcrypt del seed di db.ts (genSalt(12)).
    const passwordHash = await bcrypt.hash(ownerTempPassword, await bcrypt.genSalt(12));

    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        // Pre-check dentro la transazione per un 409 tipizzato leggibile; il
        // vincolo UNIQUE resta la difesa vera contro la race (catch 23505 sotto).
        const slugTaken = await client.query('SELECT 1 FROM tenants WHERE slug = $1 LIMIT 1', [slug]);
        if (slugTaken.rows.length > 0) {
            throw new ProvisioningError('slug_conflict', `Slug già in uso: ${slug}`);
        }
        // Email unica GLOBALE (scelta di Fase B: una persona = un login sulla
        // piattaforma), quindi si controlla su tutti i tenant.
        const emailTaken = await client.query('SELECT 1 FROM users WHERE email = $1 LIMIT 1', [ownerEmail]);
        if (emailTaken.rows.length > 0) {
            throw new ProvisioningError('email_conflict', `Email già registrata: ${ownerEmail}`);
        }

        const tenantRes = await client.query(
            `INSERT INTO tenants (slug, name, timezone, webhook_token, print_agent_token)
             VALUES ($1, $2, $3, $4, $5)
             RETURNING id, slug, name, status, timezone, created_at`,
            [slug, name, timezone, webhookToken, printAgentToken]
        );
        const tenant = tenantRes.rows[0] as ProvisionedTenant;
        const tenantId = Number(tenant.id);

        // Matrice permessi: si COPIA quella del tenant 1, che è la default
        // canonica della piattaforma — è l'unica mantenuta viva in produzione
        // (il pannello ruoli la aggiorna lì), mentre l'elenco hardcoded in
        // db.ts è solo il seed del primo boot e invecchia. Quando nascerà una
        // matrice "template" di piattaforma (D2), si copierà quella.
        await client.query(
            `INSERT INTO role_permissions (tenant_id, role, permission)
             SELECT $1, role, permission FROM role_permissions WHERE tenant_id = 1`,
            [tenantId]
        );

        // Orari di apertura: default NEUTRI (pranzo 12:30–14:00, cena
        // 19:30–22:30, slot 30'), NON quelli del Frantoio — gli orari sono
        // configurazione del singolo ristorante, non un default di piattaforma;
        // il wizard di onboarding li farà correggere al primo accesso.
        await client.query(
            `INSERT INTO opening_hours (tenant_id, weekday, lunch_open, lunch_close, dinner_open, dinner_close, slot_minutes)
             SELECT $1, g.weekday, '12:30'::time, '14:00'::time, '19:30'::time, '22:30'::time, 30
             FROM generate_series(0, 6) AS g(weekday)`,
            [tenantId]
        );

        // Entitlement: tutti spenti se non richiesti esplicitamente — gli
        // add-on si vendono, non si regalano. Le righe nascono comunque tutte
        // e tre, così il pannello le vede e i toggle sono UPDATE, non INSERT.
        for (const feature of TENANT_FEATURES) {
            await client.query(
                `INSERT INTO tenant_features (tenant_id, feature, enabled) VALUES ($1, $2, $3)`,
                [tenantId, feature, input.features?.[feature] === true]
            );
        }

        await client.query(
            `INSERT INTO users (tenant_id, email, password_hash, full_name, role, is_active)
             VALUES ($1, $2, $3, $4, 'OWNER', true)`,
            [tenantId, ownerEmail, passwordHash, ownerFullName]
        );

        await client.query('COMMIT');
        return {
            tenant: { ...tenant, id: tenantId },
            ownerTempPassword,
            tokens: { webhook_token: webhookToken, print_agent_token: printAgentToken },
        };
    } catch (err: any) {
        await client.query('ROLLBACK').catch(() => {});
        // Race persa dopo il pre-check: il 23505 dice quale vincolo, e il
        // chiamante riceve lo stesso errore tipizzato del percorso normale.
        if (err?.code === '23505') {
            if (String(err.constraint || '').includes('slug')) {
                throw new ProvisioningError('slug_conflict', `Slug già in uso: ${slug}`);
            }
            if (String(err.constraint || '').includes('email')) {
                throw new ProvisioningError('email_conflict', `Email già registrata: ${ownerEmail}`);
            }
        }
        throw err;
    } finally {
        client.release();
    }
}

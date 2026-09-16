// Provisioning TLS per il nodo di sala (tappa 3 ibrido, PR 4).
//
// Il nodo serve HTTPS in LAN su un sottodominio per installazione
// (sala.<slug>.sympotia.com) il cui record A punta all'IP PRIVATO del nodo.
// Un certificato per un IP di LAN non esiste: la strada è Let's Encrypt con
// challenge DNS-01 — la sfida sta in un TXT pubblico, quindi non serve che
// il nodo sia raggiungibile da internet (non lo è, per costruzione).
//
// Tutto gira QUI, lato cloud: niente certbot/acme.sh sul PC di sala. Il
// certificato finisce in sala_node_certs e il nodo lo scarica da
// /sala-node/credentials (hot-swap ogni 12h, vedi sala-node/index.ts).
// «Il nodo è bestiame»: se muore, il sostituto riscarica tutto.
//
// DNS via API Cloudflare (sympotia.com è già lì). Il record A è DNS-only
// (proxied:false) OBBLIGATORIAMENTE: un record arancione verso un IP privato
// non instrada nulla. Env richiesti:
//   CLOUDFLARE_API_TOKEN  — token con permesso Zone.DNS:Edit sulla zona
//   ACME_CONTACT_EMAIL    — contatto per l'account Let's Encrypt (opzionale)
//   ACME_STAGING=1        — usa la directory staging (collaudo: cert non fidato
//                           ma niente rate limit di produzione)

import * as acme from 'acme-client';
import { queryWithRetry, runAsPlatform, runWithTenantContext } from '../db.js';

const CF_API = 'https://api.cloudflare.com/client/v4';
const ACME_ACCOUNT_KEY_SETTING = 'sala_node_acme_account_key';
const RENEW_BEFORE_DAYS = 30;
const RENEW_CHECK_MS = 24 * 60 * 60 * 1000;

export class SalaNodeTlsError extends Error {
    constructor(message: string, public readonly code: string) {
        super(message);
        this.name = 'SalaNodeTlsError';
    }
}

export const isSalaNodeTlsConfigured = (): boolean =>
    Boolean((process.env.CLOUDFLARE_API_TOKEN || '').trim());

// ---------------------------------------------------------------------------
// Cloudflare
// ---------------------------------------------------------------------------

async function cfRequest(path: string, init: RequestInit = {}): Promise<any> {
    const res = await fetch(`${CF_API}${path}`, {
        ...init,
        headers: {
            Authorization: `Bearer ${(process.env.CLOUDFLARE_API_TOKEN || '').trim()}`,
            'Content-Type': 'application/json',
            ...(init.headers || {}),
        },
    });
    const body: any = await res.json().catch(() => null);
    if (!res.ok || body?.success !== true) {
        const detail = body?.errors?.map((e: any) => e.message).join('; ') || `HTTP ${res.status}`;
        throw new SalaNodeTlsError(`Cloudflare: ${detail}`, 'cloudflare');
    }
    return body.result;
}

// La zona si trova salendo i suffissi del dominio (sala.frantoio.sympotia.com
// → frantoio.sympotia.com → sympotia.com): così il modulo non cabla la zona
// e domani funziona anche per domini custom dei tenant, se in Cloudflare.
async function findZoneId(domain: string): Promise<string> {
    const parts = domain.split('.');
    for (let i = 0; i <= parts.length - 2; i++) {
        const candidate = parts.slice(i).join('.');
        const zones = await cfRequest(`/zones?name=${encodeURIComponent(candidate)}&status=active`);
        if (Array.isArray(zones) && zones.length > 0) return zones[0].id;
    }
    throw new SalaNodeTlsError(`Nessuna zona Cloudflare per ${domain}`, 'zone_not_found');
}

async function upsertDnsRecord(zoneId: string, record: { type: string; name: string; content: string; ttl?: number; proxied?: boolean }) {
    const existing = await cfRequest(`/zones/${zoneId}/dns_records?type=${record.type}&name=${encodeURIComponent(record.name)}`);
    const payload = { ttl: 60, proxied: false, ...record };
    if (Array.isArray(existing) && existing.length > 0) {
        await cfRequest(`/zones/${zoneId}/dns_records/${existing[0].id}`, { method: 'PUT', body: JSON.stringify(payload) });
    } else {
        await cfRequest(`/zones/${zoneId}/dns_records`, { method: 'POST', body: JSON.stringify(payload) });
    }
}

async function deleteDnsRecord(zoneId: string, type: string, name: string) {
    const existing = await cfRequest(`/zones/${zoneId}/dns_records?type=${type}&name=${encodeURIComponent(name)}`);
    for (const r of Array.isArray(existing) ? existing : []) {
        await cfRequest(`/zones/${zoneId}/dns_records/${r.id}`, { method: 'DELETE' });
    }
}

// ---------------------------------------------------------------------------
// ACME
// ---------------------------------------------------------------------------

// Chiave account per tenant, riusata a ogni rinnovo (creare un account nuovo
// a ogni giro sarebbe legale ma sciupa i rate limit di Let's Encrypt).
async function getOrCreateAccountKey(tenantId: number): Promise<string> {
    const rs = await queryWithRetry(
        `SELECT text_value FROM app_settings WHERE tenant_id = $1 AND key = $2`,
        [tenantId, ACME_ACCOUNT_KEY_SETTING]
    );
    const existing = rs.rows[0]?.text_value;
    if (existing) return existing;
    const key = (await acme.crypto.createPrivateKey()).toString();
    await queryWithRetry(
        `INSERT INTO app_settings (tenant_id, key, text_value, updated_at)
         VALUES ($1, $2, $3, CURRENT_TIMESTAMP)
         ON CONFLICT (tenant_id, key) DO UPDATE SET text_value = EXCLUDED.text_value, updated_at = CURRENT_TIMESTAMP`,
        [tenantId, ACME_ACCOUNT_KEY_SETTING, key]
    );
    return key;
}

async function readNodeSettings(tenantId: number): Promise<{ domain: string | null; lanIp: string | null }> {
    const rs = await queryWithRetry(
        `SELECT key, text_value FROM app_settings WHERE tenant_id = $1 AND key = ANY($2)`,
        [tenantId, ['sala_node_domain', 'sala_node_lan_ip']]
    );
    const byKey = new Map(rs.rows.map((r: any) => [r.key, r.text_value]));
    return { domain: byKey.get('sala_node_domain') || null, lanIp: byKey.get('sala_node_lan_ip') || null };
}

/**
 * Emette (o rinnova) il certificato del nodo per il tenant: allinea il
 * record A al IP LAN, ordina il cert con DNS-01 e lo salva in
 * sala_node_certs. Sincrona e lenta (la validazione DNS prende decine di
 * secondi): chi la espone via HTTP lo dica nel bottone.
 */
export async function provisionSalaNodeCert(tenantId: number): Promise<{ domain: string; expires_at: string }> {
    if (!isSalaNodeTlsConfigured()) {
        throw new SalaNodeTlsError('CLOUDFLARE_API_TOKEN non configurato', 'tls_not_configured');
    }
    const { domain, lanIp } = await readNodeSettings(tenantId);
    if (!domain) throw new SalaNodeTlsError('Dominio del nodo non configurato', 'no_domain');

    const zoneId = await findZoneId(domain);

    // Record A verso l'IP LAN, DNS-only. Senza IP configurato si emette
    // comunque il cert (il record A può già esistere o arrivare dopo).
    if (lanIp) {
        await upsertDnsRecord(zoneId, { type: 'A', name: domain, content: lanIp, proxied: false });
    }

    const accountKey = await getOrCreateAccountKey(tenantId);
    const client = new acme.Client({
        directoryUrl: process.env.ACME_STAGING === '1'
            ? acme.directory.letsencrypt.staging
            : acme.directory.letsencrypt.production,
        accountKey,
    });

    const [certKey, csr] = await acme.crypto.createCsr({ commonName: domain });
    const challengeName = `_acme-challenge.${domain}`;
    const certPem = await client.auto({
        csr,
        email: (process.env.ACME_CONTACT_EMAIL || '').trim() || undefined,
        termsOfServiceAgreed: true,
        challengePriority: ['dns-01'],
        // Per il dns-01 acme-client passa già il DIGEST come keyAuthorization:
        // va nel TXT così com'è.
        challengeCreateFn: async (_authz, _challenge, keyAuthorization) => {
            await upsertDnsRecord(zoneId, { type: 'TXT', name: challengeName, content: keyAuthorization });
        },
        challengeRemoveFn: async () => {
            await deleteDnsRecord(zoneId, 'TXT', challengeName);
        },
    });

    const info = acme.crypto.readCertificateInfo(certPem);
    const expiresAt = info.notAfter.toISOString();
    await queryWithRetry(
        `INSERT INTO sala_node_certs (tenant_id, domain, cert_pem, key_pem, expires_at)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (tenant_id, domain) DO UPDATE
           SET cert_pem = EXCLUDED.cert_pem, key_pem = EXCLUDED.key_pem,
               expires_at = EXCLUDED.expires_at, created_at = CURRENT_TIMESTAMP`,
        [tenantId, domain, certPem.toString(), certKey.toString(), expiresAt]
    );
    console.log(`[sala-node-tls] certificato per ${domain} valido fino a ${expiresAt}`);
    return { domain, expires_at: expiresAt };
}

/**
 * Rinnovo: un giro al giorno sui cert sotto i 30 giorni. Come l'outbox
 * dispatcher: interval unref (non tiene vivo il processo) e partenza a
 * migration riuscite. Un rinnovo fallito si ritenta domani — con 30 giorni
 * di margine c'è tutto il tempo di vedere l'errore nei log.
 */
export function startSalaNodeCertRenewal(): void {
    if (!isSalaNodeTlsConfigured()) return;
    const sweep = async () => {
        let rows: Array<{ tenant_id: number; domain: string }> = [];
        try {
            const rs = await runAsPlatform(() => queryWithRetry(
                `SELECT tenant_id, domain FROM sala_node_certs
                 WHERE expires_at < CURRENT_TIMESTAMP + ($1 || ' days')::interval`,
                [String(RENEW_BEFORE_DAYS)]
            ));
            rows = rs.rows;
        } catch (err: any) {
            console.error('[sala-node-tls] scan rinnovi fallita:', err?.message || err);
            return;
        }
        for (const row of rows) {
            try {
                await runWithTenantContext(Number(row.tenant_id), () => provisionSalaNodeCert(Number(row.tenant_id)));
            } catch (err: any) {
                console.error(`[sala-node-tls] rinnovo ${row.domain} fallito:`, err?.message || err);
            }
        }
    };
    const timer = setInterval(() => { void sweep(); }, RENEW_CHECK_MS);
    (timer as any).unref?.();
    // Primo giro dopo un minuto dal boot: non in mezzo alla partenza.
    const first = setTimeout(() => { void sweep(); }, 60_000);
    (first as any).unref?.();
}

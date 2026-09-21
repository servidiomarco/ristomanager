import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Client } from 'pg';
import { api, ownerToken, bearer } from './helpers';

/* Fuso orario per tenant — rete di sicurezza prima di toccare il SQL.
 *
 * Il fuso è ancora Europe/Rome per tutti: `SET TIME ZONE 'Europe/Rome'` in
 * db.ts vale per ogni connessione, e gli helper SQL lo scrivono a mano. Questo
 * file NON verifica che Londra funzioni — non funziona ancora. Verifica due
 * cose che devono restare vere mentre il fuso diventa per tenant:
 *
 *   1. il tenant 1 non si muove di un millimetro (byte-identity);
 *   2. `tenants.timezone` esiste, si scrive, e getTenantLocale lo legge
 *      rifiutando i fusi inventati.
 *
 * Il tenant londinese nasce qui e resta: i passi successivi ci appenderanno
 * le asserzioni che oggi fallirebbero. È un tenant suo, mai un toggle sul
 * tenant 1 — i file di test condividono il database e l'ordine conta.
 */

const SLUG = 'london-tz-test';
let client: Client;
let tenantId: number;
let token: string;

describe('fuso per tenant — caratterizzazione', () => {
    beforeAll(async () => {
        token = await ownerToken();
        client = new Client({ connectionString: process.env.DATABASE_URL || 'postgresql://localhost/ristotest_api' });
        await client.connect();
        const inserted = await client.query(
            `INSERT INTO tenants (slug, name, timezone, currency, country_code)
             VALUES ($1, 'London TZ Test', 'Europe/London', 'GBP', 'GB')
             RETURNING id`,
            [SLUG]
        );
        tenantId = Number(inserted.rows[0].id);
    });

    afterAll(async () => {
        if (client) {
            try {
                await client.query('DELETE FROM tenant_features WHERE tenant_id = $1', [tenantId]);
                await client.query('DELETE FROM tenants WHERE slug = $1', [SLUG]);
            } finally {
                await client.end();
            }
        }
    });

    it('il tenant nasce col suo fuso, la sua valuta e il suo paese', async () => {
        const row = await client.query(
            'SELECT timezone, currency, country_code FROM tenants WHERE id = $1',
            [tenantId]
        );
        expect(row.rows[0]).toEqual({ timezone: 'Europe/London', currency: 'GBP', country_code: 'GB' });
    });

    it('il tenant 1 resta su Europe/Rome e in euro', async () => {
        const row = await client.query('SELECT timezone, currency, country_code FROM tenants WHERE id = 1');
        expect(row.rows[0]).toEqual({ timezone: 'Europe/Rome', currency: 'EUR', country_code: 'IT' });
    });

    /* Un tenant che non dichiara niente deve nascere romano: è il default
       della colonna, ed è quello che tiene fermo il Frantoio mentre il resto
       diventa per-tenant. */
    it('un tenant senza fuso dichiarato nasce su Europe/Rome', async () => {
        const muto = await client.query(
            `INSERT INTO tenants (slug, name) VALUES ('senza-fuso-test', 'Senza Fuso') RETURNING id, timezone, currency, country_code`
        );
        try {
            expect(muto.rows[0].timezone).toBe('Europe/Rome');
            expect(muto.rows[0].currency).toBe('EUR');
            expect(muto.rows[0].country_code).toBe('IT');
        } finally {
            await client.query('DELETE FROM tenants WHERE slug = $1', ['senza-fuso-test']);
        }
    });

    it('una prenotazione del tenant 1 torna sullo stesso istante che è stata scritta', async () => {
        // Byte-identity: il round-trip di un orario serale non deve spostarsi.
        // 20:30 del 15 gennaio è la prova che conta — d'inverno Roma è UTC+1,
        // e un fuso sbagliato la sposterebbe di un'ora o di un giorno.
        const creata = await api().post('/reservations').set(bearer(token)).send({
            customer_name: 'Prova Fuso',
            phone: '+390000000001',
            guests: 2,
            reservation_time: '2027-01-15T20:30:00',
            shift: 'DINNER',
        });
        expect(creata.status).toBe(201);
        const id = creata.body.id;

        // Non c'è una GET per id: la lista è l'unica lettura, come la usa la SPA.
        const lista = await api().get('/reservations').set(bearer(token));
        expect(lista.status).toBe(200);
        const riletta = (lista.body as any[]).find(r => Number(r.id) === Number(id));
        expect(riletta).toBeDefined();
        // l'ora locale è quella scritta: il giro attraverso il database non la muove
        expect(String(riletta.reservation_time)).toContain('2027-01-15');

        const db = await client.query(
            `SELECT (reservation_time AT TIME ZONE 'Europe/Rome')::text AS locale FROM reservations WHERE id = $1`,
            [id]
        );
        expect(db.rows[0].locale).toContain('2027-01-15 20:30');

        await client.query('DELETE FROM reservations WHERE id = $1', [id]);
    });

    it('un fuso inventato non viene accettato da getTenantLocale', async () => {
        // isValidTimeZone passa da Intl: «Europe/Atlantide» non esiste e il
        // tenant deve ricadere su Roma invece di far esplodere una query.
        await client.query('UPDATE tenants SET timezone = $1 WHERE id = $2', ['Europe/Atlantide', tenantId]);
        const { getTenantLocale, clearTenantLocaleCache } = await import('../../services/tenantLocale.js');
        clearTenantLocaleCache();
        const locale = await getTenantLocale(tenantId);
        expect(locale.timezone).toBe('Europe/Rome');

        await client.query('UPDATE tenants SET timezone = $1 WHERE id = $2', ['Europe/London', tenantId]);
        clearTenantLocaleCache();
        const ok = await getTenantLocale(tenantId);
        expect(ok.timezone).toBe('Europe/London');
    });

    /* sqlTimeZone è l'unico punto dove un fuso entra in una stringa SQL: i tre
       helper (SERVICE_OF, SHIFT_OF, ROME_DAY) compongono per concatenazione e
       un parametro $n sposterebbe la numerazione di venti query. Quindi qui si
       verifica che passi solo ciò che è davvero un fuso. */
    it('sqlTimeZone cita i fusi veri e rifiuta tutto il resto', async () => {
        const { sqlTimeZone } = await import('../../services/tenantLocale.js');

        expect(sqlTimeZone('Europe/London')).toBe("'Europe/London'");
        expect(sqlTimeZone('America/Argentina/Buenos_Aires')).toBe("'America/Argentina/Buenos_Aires'");
        expect(sqlTimeZone('Etc/GMT+3')).toBe("'Etc/GMT+3'");

        // tutto ciò che non è un fuso ricade su Roma, dove l'app è sempre vissuta
        for (const cattivo of [
            null, undefined, '', '   ',
            'Europe/Atlantide',
            "Europe/Rome'; DROP TABLE reservations; --",
            "'; SELECT 1; --",
            'Europe/Rome OR 1=1',
            'Europe/Rome; SET TIME ZONE UTC',
        ]) {
            expect(sqlTimeZone(cattivo as any)).toBe("'Europe/Rome'");
        }
    });

    it('getTenantLocale legge il fuso del tenant, non quello di casa', async () => {
        const { getTenantLocale, clearTenantLocaleCache } = await import('../../services/tenantLocale.js');
        clearTenantLocaleCache();
        expect((await getTenantLocale(1)).timezone).toBe('Europe/Rome');
        expect((await getTenantLocale(tenantId)).timezone).toBe('Europe/London');
        expect((await getTenantLocale(tenantId)).currency).toBe('GBP');
    });
});

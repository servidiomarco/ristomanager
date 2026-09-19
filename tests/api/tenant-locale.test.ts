import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Client } from 'pg';
import { api, ownerToken, bearer } from './helpers';

// Dove sta il ristorante: valuta, fuso e paese. Questa tappa aggiunge le
// colonne e il servizio che le legge — nessun comportamento cambia ancora,
// quindi qui si certifica soprattutto che i default riproducano l'Italia di
// prima e che il payload di login li porti alla SPA.
describe('valuta, fuso e paese del tenant', () => {
    let db: Client;
    let owner: string;

    beforeAll(async () => {
        owner = await ownerToken();
        db = new Client({ connectionString: process.env.DATABASE_URL || 'postgresql://localhost/ristotest_api' });
        await db.connect();
    });

    afterAll(async () => { await db.end(); });

    it('il tenant esistente resta italiano: EUR, Europe/Rome, IT', async () => {
        const r = await db.query('SELECT currency, timezone, country_code FROM tenants WHERE id = 1');
        expect(r.rows[0]).toMatchObject({ currency: 'EUR', timezone: 'Europe/Rome', country_code: 'IT' });
    });

    it('login e /auth/me portano la località alla SPA', async () => {
        const me = await api().get('/auth/me').set(bearer(owner));
        expect(me.status).toBe(200);
        expect(me.body.tenant.currency).toBe('EUR');
        expect(me.body.tenant.timezone).toBe('Europe/Rome');
        expect(me.body.tenant.country_code).toBe('IT');
    });

    it('accetta una valuta a due decimali e rifiuta le altre', async () => {
        // Gli importi sono interi in centesimi: una valuta a zero decimali
        // (JPY) passerebbe il tipo e sbaglierebbe i conti. Il CHECK la ferma.
        await db.query(`UPDATE tenants SET currency = 'GBP' WHERE id = 1`);
        const dopo = await db.query('SELECT currency FROM tenants WHERE id = 1');
        expect(dopo.rows[0].currency).toBe('GBP');

        await expect(db.query(`UPDATE tenants SET currency = 'JPY' WHERE id = 1`)).rejects.toThrow();

        // Si rimette com'era: i file di test condividono il database.
        await db.query(`UPDATE tenants SET currency = 'EUR' WHERE id = 1`);
    });

    it('il paese resta di due lettere', async () => {
        const r = await db.query(`SELECT pg_typeof(country_code)::text AS tipo FROM tenants WHERE id = 1`);
        expect(r.rows[0].tipo).toBe('character');
    });
});

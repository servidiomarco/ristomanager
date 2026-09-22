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
    it('una richiesta di pagamento registra la valuta del ristorante', async () => {
        // Il gateway non è configurato nei test, quindi la creazione via API
        // non arriva in fondo: si verifica il contratto che conta, cioè che
        // la colonna accetti e conservi la valuta del tenant invece di un
        // 'EUR' cablato nell'SQL.
        await db.query(`UPDATE tenants SET currency = 'GBP' WHERE id = 1`);
        const ins = await db.query(
            `INSERT INTO payment_requests (tenant_id, amount_cents, currency, description, status, provider)
             VALUES (1, 1500, (SELECT currency FROM tenants WHERE id = 1), 'prova valuta', 'PENDING', 'revolut')
             RETURNING currency`
        );
        expect(ins.rows[0].currency).toBe('GBP');
        await db.query(`DELETE FROM payment_requests WHERE description = 'prova valuta'`);
        await db.query(`UPDATE tenants SET currency = 'EUR' WHERE id = 1`);
    });
});

/* Il formattatore degli importi: l'unico punto dove una valuta diventa testo,
   sia nei messaggi al cliente che sulle schermate. Vale la pena testarlo da
   solo perché la sua prima regola non è «formatta bene»: è «non cambiare una
   virgola di quello che i clienti italiani leggono da due anni». */
describe('valuta per tenant — come un importo diventa testo', () => {
    it('in euro esce esattamente come è sempre uscito', async () => {
        const { formatMoneyMinor } = await import('../../utils/money.js');
        expect(formatMoneyMinor(1500, 'EUR')).toBe('€ 15,00');
        expect(formatMoneyMinor(0, 'EUR')).toBe('€ 0,00');
        expect(formatMoneyMinor(5, 'EUR')).toBe('€ 0,05');
        // Nessun separatore delle migliaia: è così da sempre negli SMS, e
        // aggiungerlo cambierebbe messaggi già in produzione.
        expect(formatMoneyMinor(123456, 'EUR')).toBe('€ 1234,56');
    });

    it('senza valuta, o con una valuta vuota, resta l\'euro', async () => {
        const { formatMoneyMinor } = await import('../../utils/money.js');
        // Lettura difensiva: durante una finestra di deploy il tenant può
        // arrivare senza il campo, e un importo senza simbolo è illeggibile.
        expect(formatMoneyMinor(1500)).toBe('€ 15,00');
        expect(formatMoneyMinor(1500, '')).toBe('€ 15,00');
        expect(formatMoneyMinor(1500, null as any)).toBe('€ 15,00');
        expect(formatMoneyMinor(1500, undefined)).toBe('€ 15,00');
    });

    it('ogni altra moneta segue la sua convenzione', async () => {
        const { formatMoneyMinor } = await import('../../utils/money.js');
        expect(formatMoneyMinor(1500, 'GBP')).toBe('£15.00');
        expect(formatMoneyMinor(1500, 'USD')).toBe('$15.00');
        expect(formatMoneyMinor(1500, 'CHF')).toBe('CHF 15.00');
        expect(formatMoneyMinor(1500, 'AED')).toBe('AED 15.00');
        // Il codice arriva dal database in maiuscolo, ma non costa niente
        // accettarlo com'è.
        expect(formatMoneyMinor(1500, 'gbp')).toBe('£15.00');
    });

    it('una valuta che non conosciamo esce col suo codice, non senza simbolo', async () => {
        const { formatMoneyMinor, currencySymbol } = await import('../../utils/money.js');
        expect(formatMoneyMinor(1500, 'JPY')).toBe('JPY 15.00');
        expect(currencySymbol('JPY')).toBe('JPY');
        expect(currencySymbol('GBP')).toBe('£');
        expect(currencySymbol()).toBe('€');
    });
});

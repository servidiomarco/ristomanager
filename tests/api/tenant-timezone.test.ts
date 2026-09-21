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

/* Il fuso in azione: lo stesso istante cade in due giorni diversi.
 *
 * 23:30 UTC del 15 gennaio è mezzanotte e mezza del 16 a Roma (UTC+1 in
 * inverno) e le 23:30 del 15 a Londra (UTC+0). Un report che raggruppa per
 * giorno locale deve quindi contarla in giorni diversi nei due tenant — è la
 * prova che il fuso non è più quello del server.
 */
describe('fuso per tenant — il giorno locale segue il ristorante', () => {
    const SLUG_LONDRA = 'londra-report-tz';
    const EMAIL = 'owner.londra.tz@example.com';
    const ADMIN_HEADER = { 'X-Platform-Admin-Token': 'test-platform-token' };
    // 23:30Z del 15/01: giorno 16 a Roma, giorno 15 a Londra.
    const ISTANTE = '2027-01-15T23:30:00.000Z';
    const RANGE = { from: '2027-01-10', to: '2027-01-20' };

    let db: Client;
    let londraId = 0;
    let londraToken = '';
    let ownerRoma = '';

    beforeAll(async () => {
        ownerRoma = await ownerToken();
        db = new Client({ connectionString: process.env.DATABASE_URL || 'postgresql://localhost/ristotest_api' });
        await db.connect();

        const creato = await api().post('/admin/tenants').set(ADMIN_HEADER).send({
            slug: SLUG_LONDRA,
            name: 'The Old Mill',
            timezone: 'Europe/London',
            owner_email: EMAIL,
            owner_full_name: 'London Owner',
        });
        expect(creato.status).toBe(201);
        londraId = Number(creato.body.tenant?.id ?? creato.body.id);
        expect(londraId).toBeGreaterThan(0);
        // La password temporanea esce solo da questa risposta, come in produzione.
        const PASSWORD = String(creato.body.owner_temp_password);

        // Il provisioning può non propagare il fuso: quello che conta qui è
        // che la colonna sia Europe/London quando la query lo legge.
        await db.query('UPDATE tenants SET timezone = $1 WHERE id = $2', ['Europe/London', londraId]);

        /* La Reportistica è dietro un'allowlist di email più il permesso
           reports:view; l'owner londinese non è nell'allowlist, quindi gli si
           dà il permesso come farebbe il titolare dalla pagina Utenti. */
        await db.query(
            `INSERT INTO role_permissions (tenant_id, role, permission)
             VALUES ($1, 'OWNER', 'reports:view')
             ON CONFLICT DO NOTHING`,
            [londraId]
        );

        const login = await api().post('/auth/login').send({ email: EMAIL, password: PASSWORD });
        expect(login.status).toBe(200);
        londraToken = login.body.accessToken;

        // La stessa prenotazione, lo stesso istante, nei due tenant.
        for (const tid of [1, londraId]) {
            await db.query(
                `INSERT INTO reservations (tenant_id, customer_name, phone, guests, reservation_time, shift, payment_status, reservation_status)
                 VALUES ($1, 'Mezzanotte Fuso', '+390000000009', 2, $2::timestamptz, 'DINNER', 'NONE', 'CONFIRMED')`,
                [tid, ISTANTE]
            );
        }
    });

    afterAll(async () => {
        if (!db) return;
        try {
            await db.query(`DELETE FROM reservations WHERE customer_name = 'Mezzanotte Fuso'`);
            // Il provisioning lascia dietro di sé righe con FK sul tenant:
            // vanno via prima, o la DELETE finale viola il vincolo.
            for (const tabella of ['activity_logs', 'user_sessions', 'app_settings', 'tenant_tokens', 'users', 'tenant_features']) {
                await db.query(`DELETE FROM ${tabella} WHERE tenant_id = $1`, [londraId]).catch(() => {});
            }
            await db.query('DELETE FROM tenants WHERE id = $1', [londraId]);
        } finally {
            await db.end();
        }
    });

    it('il report del tenant romano la conta il 16, quello londinese il 15', async () => {
        const roma = await api().get('/reports/reservations').query(RANGE).set(bearer(ownerRoma));
        expect(roma.status).toBe(200);
        const londra = await api().get('/reports/reservations').query(RANGE).set(bearer(londraToken));
        expect(londra.status).toBe(200);

        const giornoCon = (body: any, nome: string) => {
            const serie = (body.per_giorno ?? []) as any[];
            const righe = serie.filter(g => Number(g.prenotazioni ?? 0) > 0);
            return righe.length ? righe.map(g => String(g.giorno)).join(',') : `(nessuna riga in ${nome})`;
        };

        // Il confronto che conta: lo stesso istante, due giorni diversi.
        expect(giornoCon(roma.body, 'roma')).toContain('2027-01-16');
        expect(giornoCon(londra.body, 'londra')).toContain('2027-01-15');
    });
});

/* Gli helper su cui poggia lo scheduler.
 *
 * Il tick dei promemoria e quello delle recensioni decidono «è l'ora?»
 * leggendo l'orologio del ristorante: getTimePartInTz è quella lettura. Le
 * funzioni del tick vivono in server.ts e non sono esportate — qui si prova
 * il mattone, e che il mattone regga anche un fuso inventato.
 */
describe('fuso per tenant — leggere l\'orologio del ristorante', () => {
    it('lo stesso istante dà ore diverse nei due fusi', async () => {
        const { getTimePartInTz, getDatePartInTz, getRomeTimePart } = await import('../../utils/reservationTime.js');
        // 23:30Z del 15 gennaio: Roma UTC+1, Londra UTC+0, Dubai UTC+4.
        const istante = new Date('2027-01-15T23:30:00.000Z');

        expect(getTimePartInTz(istante, 'Europe/Rome')).toBe('00:30');
        expect(getTimePartInTz(istante, 'Europe/London')).toBe('23:30');
        expect(getTimePartInTz(istante, 'Asia/Dubai')).toBe('03:30');

        // e il giorno cambia con l'ora: è quello che spostava i report
        expect(getDatePartInTz(istante, 'Europe/Rome')).toBe('2027-01-16');
        expect(getDatePartInTz(istante, 'Europe/London')).toBe('2027-01-15');
        expect(getDatePartInTz(istante, 'Asia/Dubai')).toBe('2027-01-16');

        // il fuso di casa resta quello che era
        expect(getRomeTimePart(istante)).toBe('00:30');
    });

    it('in luglio il confronto Roma-Londra resta di un ora, DST compresa', async () => {
        const { getTimePartInTz } = await import('../../utils/reservationTime.js');
        // d'estate Roma è UTC+2 e Londra UTC+1: un'ora di differenza, come
        // d'inverno, ma su offset diversi. È il caso che un calcolo a mano
        // con un offset fisso sbaglierebbe.
        const luglio = new Date('2027-07-15T22:30:00.000Z');
        expect(getTimePartInTz(luglio, 'Europe/Rome')).toBe('00:30');
        expect(getTimePartInTz(luglio, 'Europe/London')).toBe('23:30');
    });

    it('un fuso inventato ricade su Roma invece di far esplodere la lista', async () => {
        const { getTimePartInTz, getDatePartInTz } = await import('../../utils/reservationTime.js');
        const istante = new Date('2027-01-15T23:30:00.000Z');
        expect(getTimePartInTz(istante, 'Europe/Atlantide')).toBe('00:30');
        expect(getDatePartInTz(istante, 'Europe/Atlantide')).toBe('2027-01-16');
    });
});

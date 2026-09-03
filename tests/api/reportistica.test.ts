import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Client } from 'pg';
import { api, ownerToken, bearer } from './helpers';

// Reportistica: quattro endpoint di sola lettura su un range di date, uno per
// area (prenotazioni, incassi, piatti, comunicazioni). Il seed vive in una
// finestra futura tutta sua (giugno 2027) così i numeri sono deterministici
// anche se altri file di test hanno scritto date "di oggi".

const WAITER_EMAIL = 'cameriere.report@example.com';
const WAITER_PASSWORD = 'password-cameriere-report';
const RANGE = { from: '2027-06-01', to: '2027-06-30' };
const OTHER_TENANT_ID = 9;

const ROUTES = ['/reports/reservations', '/reports/revenue', '/reports/dishes', '/reports/communications'];

const dbClient = async () => {
    const client = new Client({ connectionString: process.env.DATABASE_URL || 'postgresql://localhost/ristotest_api' });
    await client.connect();
    return client;
};

describe('reportistica — endpoint aggregati', () => {
    let owner = '';
    let waiterToken = '';
    let reservationId = 0;
    let billId = 0;

    beforeAll(async () => {
        owner = await ownerToken();

        // Un cameriere non ha reports:view: serve per il test dei 403.
        const created = await api().post('/auth/users').set(bearer(owner)).send({
            email: WAITER_EMAIL, password: WAITER_PASSWORD, full_name: 'Test Cameriere Report', role: 'WAITER',
        });
        expect(created.status).toBe(201);
        const login = await api().post('/auth/login').send({ email: WAITER_EMAIL, password: WAITER_PASSWORD });
        expect(login.status).toBe(200);
        waiterToken = login.body.accessToken;

        // Prenotazione nel range, creata dall'API come farebbe lo staff
        // (source MANUAL implicito).
        const res = await api().post('/reservations').set(bearer(owner)).send({
            customer_name: 'Report Seed',
            phone: '340 555 0177',
            reservation_time: '2027-06-10T17:00:00.000Z', // le 19:00 di Roma in estate
            shift: 'DINNER',
            guests: 4,
        });
        expect(res.status).toBe(201);
        reservationId = res.body.id;

        // Libro cassa seminato diretto: il flusso cassa completo è già coperto
        // dai suoi test, qui servono solo righe con date note.
        const db = await dbClient();
        try {
            const bill = await db.query(
                `INSERT INTO table_bills (tenant_id, reservation_id, total_cents, covers, status, opened_at, closed_at, tip_cents)
                 VALUES (1, $1, 10000, 4, 'CLOSED', '2027-06-10T18:00:00Z', '2027-06-10T20:00:00Z', 500)
                 RETURNING id`, [reservationId]);
            billId = bill.rows[0].id;
            await db.query(
                `INSERT INTO table_bill_payments (tenant_id, table_bill_id, method, amount_cents, recorded_at, voided_at)
                 VALUES (1, $1, 'CONTANTI',   6000, '2027-06-10T20:05:00Z', NULL),
                        (1, $1, 'OMAGGIO',    2000, '2027-06-10T20:05:00Z', NULL),
                        (1, $1, 'POS_FISICO', 4000, '2027-06-10T20:06:00Z', '2027-06-10T20:10:00Z')`,
                [billId]);

            // Due chiamate di Sofia: una convertita in prenotazione, una no.
            await db.query(
                `INSERT INTO voice_calls (tenant_id, conversation_id, phone, duration_seconds, reservation_id, created_at)
                 VALUES (1, 'conv-report-1', '+393405550177', 120, $1, '2027-06-10T15:00:00Z'),
                        (1, 'conv-report-2', '+393405550178',  60, NULL, '2027-06-11T15:00:00Z')`,
                [reservationId]);

            // Messaggi: uno in uscita consegnato, uno in entrata che NON deve
            // sporcare i tassi di consegna.
            await db.query(
                `INSERT INTO outbound_messages (tenant_id, provider, channel, direction, to_phone, to_phone_digits, body, sent_at, delivered_at)
                 VALUES (1, 'twilio', 'whatsapp', 'outbound', '+393405550177', '393405550177', 'seed report', '2027-06-10T16:00:00Z', '2027-06-10T16:00:05Z')`);
            await db.query(
                `INSERT INTO outbound_messages (tenant_id, provider, channel, direction, from_phone, from_phone_digits, body, sent_at)
                 VALUES (1, 'twilio', 'whatsapp', 'inbound', '+393405550177', '393405550177', 'risposta cliente', '2027-06-10T16:10:00Z')`);

            // Righe di un ALTRO tenant nello stesso range: non devono apparire.
            await db.query(
                `INSERT INTO tenants (id, slug, name) VALUES ($1, 'trattoria-report', 'Trattoria Report')
                 ON CONFLICT (id) DO NOTHING`, [OTHER_TENANT_ID]);
            await db.query(`SELECT setval(pg_get_serial_sequence('tenants','id'), (SELECT MAX(id) FROM tenants))`);
            await db.query(
                `INSERT INTO voice_calls (tenant_id, conversation_id, phone, duration_seconds, created_at)
                 VALUES ($1, 'conv-report-altro-tenant', '+393900000000', 999, '2027-06-10T15:00:00Z')`,
                [OTHER_TENANT_ID]);
            await db.query(
                `INSERT INTO reservations (tenant_id, customer_name, reservation_time, shift, guests, payment_status)
                 VALUES ($1, 'Fantasma Altro Tenant', '2027-06-10T17:00:00Z', 'DINNER', 40, 'PENDING')`,
                [OTHER_TENANT_ID]);
        } finally {
            await db.end();
        }
    });

    afterAll(async () => {
        const db = await dbClient();
        try {
            await db.query(`DELETE FROM table_bill_payments WHERE table_bill_id = $1`, [billId]);
            await db.query(`DELETE FROM table_bills WHERE id = $1`, [billId]);
            await db.query(`DELETE FROM voice_calls WHERE conversation_id LIKE 'conv-report-%'`);
            await db.query(`DELETE FROM outbound_messages WHERE body IN ('seed report', 'risposta cliente')`);
            await db.query(`DELETE FROM reservations WHERE tenant_id = $1`, [OTHER_TENANT_ID]);
            await db.query(`DELETE FROM reservations WHERE id = $1`, [reservationId]);
            await db.query(`DELETE FROM role_permissions WHERE tenant_id = $1`, [OTHER_TENANT_ID]);
            await db.query(`DELETE FROM tenants WHERE id = $1`, [OTHER_TENANT_ID]);
            await db.query(`DELETE FROM users WHERE email = $1`, [WAITER_EMAIL]);
        } finally {
            await db.end();
        }
    });

    it('richiedono autenticazione', async () => {
        for (const route of ROUTES) {
            const res = await api().get(route);
            expect(res.status, route).toBe(401);
        }
    });

    it('lancio ristretto: reports:* fuori dalla matrice, l\'owner passa dall\'allowlist', async () => {
        // La migration reportistica-solo-allowlist spazza reports:* dal
        // tenant 1: i 200 dell'owner in questo file provano quindi la via
        // dell'allowlist (REPORTS_ADMIN_EMAILS, default = l'admin di test),
        // non quella del permesso.
        for (const role of ['OWNER', 'GENERAL_MANAGER', 'MANAGER', 'WAITER']) {
            const res = await api().get(`/auth/permissions/roles/${role}`).set(bearer(owner));
            expect(res.status).toBe(200);
            expect(res.body.permissions, role).not.toContain('reports:view');
            expect(res.body.permissions, role).not.toContain('reports:full');
        }
    });

    it('un cameriere non li vede (403)', async () => {
        for (const route of ROUTES) {
            const res = await api().get(route).set(bearer(waiterToken));
            expect(res.status, route).toBe(403);
        }
    });

    it('range invalido: inizio dopo la fine → 400', async () => {
        const res = await api().get('/reports/reservations?from=2027-06-30&to=2027-06-01').set(bearer(owner));
        expect(res.status).toBe(400);
        expect(res.body.error).toBe('range_non_valido');
    });

    it('range oltre 366 giorni → 400', async () => {
        const res = await api().get('/reports/reservations?from=2026-01-01&to=2027-06-30').set(bearer(owner));
        expect(res.status).toBe(400);
        expect(res.body.error).toBe('range_troppo_ampio');
    });

    it('senza parametri: ultimi 30 giorni e finestra precedente di pari ampiezza', async () => {
        const res = await api().get('/reports/reservations').set(bearer(owner));
        expect(res.status).toBe(200);
        const widthDays = (a: string, b: string) => (Date.parse(b) - Date.parse(a)) / 86400000 + 1;
        expect(widthDays(res.body.from, res.body.to)).toBe(30);
        expect(widthDays(res.body.precedente_range.from, res.body.precedente_range.to)).toBe(30);
        // La finestra precedente finisce il giorno prima dell'inizio.
        expect(Date.parse(res.body.from) - Date.parse(res.body.precedente_range.to)).toBe(86400000);
    });

    it('prenotazioni: totali, canali e serie riflettono il seed (solo tenant 1)', async () => {
        const res = await api().get(`/reports/reservations?from=${RANGE.from}&to=${RANGE.to}`).set(bearer(owner));
        expect(res.status).toBe(200);
        expect(res.body.totali.prenotazioni).toBe(1);
        expect(res.body.totali.coperti).toBe(4); // i 40 dell'altro tenant non contano
        const manual = res.body.per_canale.find((c: any) => c.canale === 'MANUAL');
        expect(manual?.prenotazioni).toBe(1);
        const giorno = res.body.per_giorno.find((g: any) => g.giorno === '2027-06-10');
        expect(giorno?.coperti).toBe(4);
    });

    it('incassi: storni e omaggi fuori dal totale, mance e scontrino dal conto', async () => {
        const res = await api().get(`/reports/revenue?from=${RANGE.from}&to=${RANGE.to}`).set(bearer(owner));
        expect(res.status).toBe(200);
        // 6000 CONTANTI vivi; il POS stornato e l'OMAGGIO non sono incasso.
        expect(res.body.totali.incassato_cents).toBe(6000);
        expect(res.body.totali.mance_cents).toBe(500);
        expect(res.body.totali.scontrino_medio_cents).toBe(10000);
        expect(res.body.totali.coperto_medio_cents).toBe(2500);
        const omaggio = res.body.per_metodo.find((m: any) => m.metodo === 'OMAGGIO');
        expect(omaggio?.non_cash).toBe(true);
        const pos = res.body.per_metodo.find((m: any) => m.metodo === 'POS_FISICO');
        expect(pos).toBeUndefined(); // era stornato
    });

    it('piatti: risposta piatta se il modulo comande è spento, dati se acceso', async () => {
        const res = await api().get(`/reports/dishes?from=${RANGE.from}&to=${RANGE.to}`).set(bearer(owner));
        expect(res.status).toBe(200);
        if (res.body.enabled === false) {
            expect(res.body.top_piatti).toBeUndefined();
        } else {
            expect(Array.isArray(res.body.top_piatti)).toBe(true);
            expect(Array.isArray(res.body.partite)).toBe(true);
            expect(Array.isArray(res.body.scarti)).toBe(true);
        }
    });

    it('comunicazioni: conversione chiamate e messaggi solo in uscita, solo tenant 1', async () => {
        const res = await api().get(`/reports/communications?from=${RANGE.from}&to=${RANGE.to}`).set(bearer(owner));
        expect(res.status).toBe(200);
        expect(res.body.voce.chiamate).toBe(2); // la chiamata dell'altro tenant non conta
        expect(res.body.voce.con_prenotazione).toBe(1);
        expect(res.body.voce.secondi).toBe(180);
        const wa = res.body.messaggi.find((m: any) => m.canale === 'whatsapp');
        expect(wa?.inviati).toBe(1); // il messaggio inbound non conta
        expect(wa?.consegnati).toBe(1);
    });
});

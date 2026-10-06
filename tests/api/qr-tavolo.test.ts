import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Client } from 'pg';
import { api, ownerToken, bearer } from './helpers';

// QR unico al tavolo: l'adesivo porta /t/<public_token>. La pagina mostra il
// menu e, solo mentre il tavolo ha un conto aperto nel servizio in corso,
// «Paga il conto» verso /pay/<share_token>. La prima quota presa dall'ospite
// avvisa il cameriere che ha aperto la comanda e la cassa, una volta sola, e
// l'avviso si spegne quando il conto si chiude.

const WAITER_EMAIL = 'qr.tavolo.cameriere@example.com';
const CASSA_EMAIL = 'qr.tavolo.cassa@example.com';
const PASSWORD = 'password-qr-tavolo';
const dbUrl = process.env.DATABASE_URL || 'postgresql://localhost/ristotest_api';

describe('QR unico al tavolo', () => {
    let owner = '';
    let waiterToken = '';
    let waiterId = 0;
    let cassaId = 0;
    let tavolo1 = 0;
    let tavolo2 = 0;
    let token1 = '';
    let token2 = '';
    let billId = 0;
    let shareToken = '';
    let db: Client;
    // I flag com'erano prima del file: i test che vengono dopo (il nodo di
    // sala) li trovano accesi dai file precedenti, e qui si rimettono così.
    let flagsPrima: Record<string, boolean> = {};

    const notificheConto = async () =>
        (await db.query(
            `SELECT recipient_user_id, sent_at, read_at FROM notifications WHERE tag = $1 ORDER BY recipient_user_id`,
            [`bill-paying-${billId}`]
        )).rows;

    // La push parte dopo la risposta (fire-and-forget): si aspetta la riga.
    const aspettaNotifiche = async (almeno: number) => {
        for (let i = 0; i < 30; i++) {
            const rows = await notificheConto();
            if (rows.length >= almeno) return rows;
            await new Promise(r => setTimeout(r, 100));
        }
        return notificheConto();
    };

    beforeAll(async () => {
        owner = await ownerToken();
        db = new Client({ connectionString: dbUrl });
        await db.connect();

        const prima = await api().get('/settings/features').set(bearer(owner));
        flagsPrima = {
            table_orders_enabled: prima.body.table_orders_enabled === true,
            pay_at_table_enabled: prima.body.pay_at_table_enabled === true,
            digital_menu_enabled: prima.body.digital_menu_enabled === true,
        };
        await api().put('/settings/features').set(bearer(owner)).send({
            table_orders_enabled: true,
            pay_at_table_enabled: true,
            digital_menu_enabled: true,
        });

        for (const [email, role] of [[WAITER_EMAIL, 'WAITER'], [CASSA_EMAIL, 'CASSA']]) {
            const created = await api().post('/auth/users').set(bearer(owner)).send({
                email, password: PASSWORD, full_name: `Test QR ${role}`, role,
            });
            expect(created.status).toBe(201);
        }
        const login = await api().post('/auth/login').send({ email: WAITER_EMAIL, password: PASSWORD });
        expect(login.status).toBe(200);
        waiterToken = login.body.accessToken;
        const ids = await db.query(`SELECT id, email FROM users WHERE email = ANY($1)`, [[WAITER_EMAIL, CASSA_EMAIL]]);
        waiterId = ids.rows.find((r: any) => r.email === WAITER_EMAIL).id;
        cassaId = ids.rows.find((r: any) => r.email === CASSA_EMAIL).id;

        const room = await api().post('/rooms').set(bearer(owner)).send({ name: 'Sala QR Tavolo', width: 800, height: 600 });
        expect(room.status).toBe(201);
        for (const name of ['QRT1', 'QRT2']) {
            const table = await api().post('/tables').set(bearer(owner)).send({
                name, shape: 'SQUARE', seats: 4, x: 100, y: 100, room_id: room.body.id, status: 'FREE',
            });
            expect(table.status).toBe(201);
            if (name === 'QRT1') tavolo1 = table.body.id; else tavolo2 = table.body.id;
        }
    });

    afterAll(async () => {
        await api().put('/settings/features').set(bearer(owner)).send(flagsPrima);
        await db.query(`DELETE FROM table_merges WHERE primary_id = $1`, [tavolo1]);
        await db.query(`DELETE FROM notifications WHERE tag LIKE 'bill-paying-%'`);
        await db.query(`DELETE FROM users WHERE email = ANY($1)`, [[WAITER_EMAIL, CASSA_EMAIL]]);
        await db.end();
    });

    it('i token nascono alla stampa, restano stabili e portano al menu', async () => {
        const first = await api().post('/tables/qr-tokens').set(bearer(owner)).send({});
        expect(first.status).toBe(200);
        token1 = first.body.find((r: any) => r.table_id === tavolo1).public_token;
        token2 = first.body.find((r: any) => r.table_id === tavolo2).public_token;
        expect(token1).toMatch(/^[A-Za-z0-9_-]{22}$/);
        expect(token2).not.toBe(token1);

        const again = await api().post('/tables/qr-tokens').set(bearer(owner)).send({});
        expect(again.body.find((r: any) => r.table_id === tavolo1).public_token).toBe(token1);

        const pub = await api().get(`/public/table/${token1}`);
        expect(pub.status).toBe(200);
        expect(pub.body.table.name).toBe('QRT1');
        expect(Array.isArray(pub.body.menu.piatti)).toBe(true);
        expect(pub.body.pay.open).toBe(false);
        expect(pub.body.pay.url).toBeUndefined();

        const page = await api().get(`/t/${token1}`);
        expect(page.status).toBe(200);
        expect(page.headers['content-type']).toMatch(/text\/html/);
    });

    it('un token sconosciuto o malformato è un 404', async () => {
        expect((await api().get('/public/table/AAAAAAAAAAAAAAAAAAAAAA')).status).toBe(404);
        expect((await api().get('/public/table/corto')).status).toBe(404);
        expect((await api().get('/public/table/AAAAAAAAAAAAAAAAAAAAAA/conto')).status).toBe(404);
    });

    it('a conto aperto compare «Paga il conto», col link al conto del tavolo', async () => {
        const dish = await api().post('/dishes').set(bearer(owner)).send({
            name: 'Piatto QR Tavolo', description: null, price: 20, category: 'Primi', allergens: [],
        });
        expect(dish.status).toBe(201);
        // La comanda la apre il cameriere: è lui che riceverà l'avviso.
        const order = await api().post('/orders').set(bearer(waiterToken)).send({ table_id: tavolo1 });
        expect(order.status).toBe(201);
        const orderId = order.body.order.id as number;
        expect((await api().post(`/orders/${orderId}/items`).set(bearer(waiterToken))
            .send({ items: [{ dish_id: dish.body.id, qty: 2 }] })).status).toBe(201);
        expect((await api().post(`/orders/${orderId}/send`).set(bearer(waiterToken)).send({})).status).toBe(200);
        const closed = await api().post(`/orders/${orderId}/close`).set(bearer(owner)).send({});
        expect(closed.status).toBe(200);
        billId = closed.body.bill.id;

        const open = await api().get('/bills/open').set(bearer(owner));
        shareToken = open.body.bills.find((b: any) => b.id === billId).share_token;
        expect(shareToken).toBeTruthy();

        const pub = await api().get(`/public/table/${token1}`);
        expect(pub.body.pay.open).toBe(true);
        expect(pub.body.pay.url).toMatch(new RegExp(`/pay/${shareToken}$`));
        expect(pub.body.pay.residual_cents).toBe(4000);

        const conto = await api().get(`/public/table/${token1}/conto`);
        expect(conto.status).toBe(200);
        expect(conto.body.pay.url).toBe(pub.body.pay.url);
        expect(conto.body.menu).toBeUndefined();

        // L'altro tavolo non ha un conto.
        expect((await api().get(`/public/table/${token2}`)).body.pay.open).toBe(false);
    });

    it('un conto di un altro servizio conta solo se appena aperto', async () => {
        const orig = (await db.query(`SELECT service_date::text AS d, opened_at FROM table_bills WHERE id = $1`, [billId])).rows[0];
        // Comanda appesa da ieri, chiusa adesso: il conto porta la data di
        // ieri ma è appena nato, e il tasto deve comparire.
        await db.query(`UPDATE table_bills SET service_date = service_date - 1 WHERE id = $1`, [billId]);
        expect((await api().get(`/public/table/${token1}`)).body.pay.open).toBe(true);
        // Conto dimenticato aperto da ieri: l'ospite di oggi non lo vede.
        await db.query(`UPDATE table_bills SET opened_at = NOW() - INTERVAL '1 day' WHERE id = $1`, [billId]);
        expect((await api().get(`/public/table/${token1}`)).body.pay.open).toBe(false);
        await db.query(`UPDATE table_bills SET service_date = $2::date, opened_at = $3 WHERE id = $1`, [billId, orig.d, orig.opened_at]);
        expect((await api().get(`/public/table/${token1}`)).body.pay.open).toBe(true);
    });

    it('l\'adesivo del tavolo unito porta al conto del gruppo', async () => {
        const svc = (await db.query(`SELECT service_date::text AS d, shift FROM table_bills WHERE id = $1`, [billId])).rows[0];
        await db.query(
            `INSERT INTO table_merges (tenant_id, date, shift, primary_id, merged_ids) VALUES (1, $1::date, $2, $3, $4)`,
            [svc.d, svc.shift, tavolo1, [tavolo2]]
        );
        const pub = await api().get(`/public/table/${token2}`);
        expect(pub.body.table.name).toBe('QRT2');
        expect(pub.body.pay.open).toBe(true);
        expect(pub.body.pay.url).toMatch(new RegExp(`/pay/${shareToken}$`));
        await db.query(`DELETE FROM table_merges WHERE primary_id = $1`, [tavolo1]);
        expect((await api().get(`/public/table/${token2}`)).body.pay.open).toBe(false);
    });

    it('la prima quota avvisa cameriere e cassa, una volta sola', async () => {
        const claim = await api().post(`/pay/${shareToken}/claim`).send({
            kind: 'fixed_amount', amount_cents: 1000, claimant_label: 'Ospite QR',
        });
        expect(claim.status).toBe(201);
        const rows = await aspettaNotifiche(2);
        const destinatari = rows.map((r: any) => Number(r.recipient_user_id));
        expect(destinatari).toContain(Number(waiterId));
        expect(destinatari).toContain(Number(cassaId));
        const sentAt = new Map(rows.map((r: any) => [Number(r.recipient_user_id), String(r.sent_at)]));

        // Una seconda quota non rimanda niente: nessuna riga nuova, nessuna
        // push ripetuta (il pushService aggiornerebbe sent_at).
        const second = await api().post(`/pay/${shareToken}/claim`).send({ kind: 'fixed_amount', amount_cents: 500 });
        expect(second.status).toBe(201);
        await new Promise(r => setTimeout(r, 500));
        const after = await notificheConto();
        expect(after.length).toBe(rows.length);
        for (const r of after) expect(String(r.sent_at)).toBe(sentAt.get(Number(r.recipient_user_id)));
    });

    it('chiuso il conto, il tasto sparisce e l\'avviso si spegne', async () => {
        const voided = await api().post(`/bills/${billId}/void`).set(bearer(owner)).send({ notes: 'prova QR tavolo' });
        expect(voided.status).toBe(200);
        expect((await api().get(`/public/table/${token1}`)).body.pay.open).toBe(false);
        let rows = await notificheConto();
        for (let i = 0; i < 20 && rows.some((r: any) => r.read_at == null); i++) {
            await new Promise(r => setTimeout(r, 100));
            rows = await notificheConto();
        }
        expect(rows.length).toBeGreaterThan(0);
        for (const r of rows) expect(r.read_at).not.toBeNull();
    });

    it('rigenerare il token spegne il vecchio adesivo', async () => {
        const rotated = await api().post(`/tables/${tavolo1}/qr-token/rotate`).set(bearer(owner)).send({});
        expect(rotated.status).toBe(200);
        expect(rotated.body.public_token).not.toBe(token1);
        expect((await api().get(`/public/table/${token1}`)).status).toBe(404);
        expect((await api().get(`/public/table/${rotated.body.public_token}`)).status).toBe(200);
    });

    it('foglio e frase dei cartellini restano salvati per il ristorante', async () => {
        // Prima volta: A4 e la frase suggerita, col nome del menu pubblico.
        const first = await api().get('/tables/qr-print').set(bearer(owner));
        expect(first.status).toBe(200);
        expect(first.body.paper).toBe('A4');
        expect(first.body.text).toMatch(/menu/i);
        expect(first.body.holder).toBe(false);
        expect(typeof first.body.restaurant).toBe('string');

        // Righe vuote e spazi in più via, al massimo quattro righe.
        const saved = await api().put('/tables/qr-print').set(bearer(owner)).send({
            paper: 'A3', text: '  Inquadra   il QR\r\n\nScan me\nuno\ndue\ntre  ',
        });
        expect(saved.status).toBe(200);
        expect(saved.body).toEqual({ paper: 'A3', text: 'Inquadra il QR\nScan me\nuno\ndue', holder: false });
        const again = await api().get('/tables/qr-print').set(bearer(owner));
        expect(again.body.paper).toBe('A3');
        expect(again.body.text).toBe('Inquadra il QR\nScan me\nuno\ndue');

        // La frase vuota è una scelta, non un ritorno al suggerimento.
        await api().put('/tables/qr-print').set(bearer(owner)).send({ paper: 'A5', text: '' });
        expect((await api().get('/tables/qr-print').set(bearer(owner))).body).toMatchObject({ paper: 'A5', text: '' });

        // Il portaQR in plastica: si accende, resta, e senza il campo si spegne.
        await api().put('/tables/qr-print').set(bearer(owner)).send({ paper: 'A4', text: 'x', holder: true });
        expect((await api().get('/tables/qr-print').set(bearer(owner))).body).toMatchObject({ paper: 'A4', holder: true });
        await api().put('/tables/qr-print').set(bearer(owner)).send({ paper: 'A4', text: 'x' });
        expect((await api().get('/tables/qr-print').set(bearer(owner))).body.holder).toBe(false);
        expect((await api().put('/tables/qr-print').set(bearer(owner)).send({ paper: 'A4', text: 'x', holder: 'si' })).status).toBe(400);

        expect((await api().put('/tables/qr-print').set(bearer(owner)).send({ paper: 'A6', text: 'x' })).status).toBe(400);
        expect((await api().put('/tables/qr-print').set(bearer(owner)).send({ paper: 'A4' })).status).toBe(400);
        // Il cameriere non gestisce la sala: niente impostazioni di stampa.
        expect((await api().get('/tables/qr-print').set(bearer(waiterToken))).status).toBe(403);

        await db.query(`DELETE FROM app_settings WHERE key = 'table_qr_print'`);
    });
});

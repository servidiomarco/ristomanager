import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Client } from 'pg';
import { api, ownerToken, bearer } from './helpers';

// Lettura sincronizzata delle notifiche: per telefonate, messaggi, email,
// tavoli in sala, prenotazioni, pagamenti, sistema e generiche la lettura di
// uno vale per tutti i destinatari della stessa notifica (stesso tag); chat
// staff e fatturazione restano personali.

const MANAGER_EMAIL = 'manager.notifiche@example.com';
const PASSWORD = 'password-notifiche';

const dbUrl = () => process.env.DATABASE_URL || 'postgresql://localhost/ristotest_api';

describe('notifiche · lettura condivisa', () => {
    let owner = '';
    let ownerId = 0;
    let manager = '';
    let managerId = 0;
    let db: Client;

    const insert = async (userId: number, category: string, tag: string): Promise<number> => {
        const r = await db.query(
            `INSERT INTO notifications (tenant_id, recipient_user_id, category, title, body, tag)
             VALUES (1, $1, $2, 'Titolo', 'Corpo', $3) RETURNING id`,
            [userId, category, tag]
        );
        return Number(r.rows[0].id);
    };
    const readAt = async (id: number) =>
        (await db.query(`SELECT read_at FROM notifications WHERE id = $1`, [id])).rows[0]?.read_at ?? null;

    beforeAll(async () => {
        owner = await ownerToken();
        const me = await api().post('/auth/login').send({
            email: process.env.TEST_OWNER_EMAIL,
            password: process.env.TEST_OWNER_PASSWORD,
        });
        ownerId = me.body.user.id;
        const created = await api().post('/auth/users').set(bearer(owner)).send({
            email: MANAGER_EMAIL, password: PASSWORD, full_name: 'Test Manager', role: 'MANAGER',
        });
        expect(created.status).toBe(201);
        const login = await api().post('/auth/login').send({ email: MANAGER_EMAIL, password: PASSWORD });
        expect(login.status).toBe(200);
        manager = login.body.accessToken;
        managerId = login.body.user.id;

        db = new Client({ connectionString: dbUrl() });
        await db.connect();
    });

    afterAll(async () => {
        try {
            await db.query(`DELETE FROM notifications WHERE tag LIKE 'test-condivisa-%'`);
            await db.query(`DELETE FROM users WHERE email = $1`, [MANAGER_EMAIL]);
        } finally {
            await db.end();
        }
    });

    it('telefonate, messaggi e tavoli: letta da uno, letta per tutti', async () => {
        for (const category of ['voice', 'message', 'service']) {
            const tag = `test-condivisa-${category}`;
            const mine = await insert(ownerId, category, tag);
            const theirs = await insert(managerId, category, tag);

            const res = await api().post(`/notifications/${mine}/read`).set(bearer(owner));
            expect(res.status).toBe(200);
            expect(await readAt(mine)).not.toBeNull();
            expect(await readAt(theirs)).not.toBeNull();
        }
        const count = await api().get('/notifications/unread-count').set(bearer(manager));
        expect(count.body.count).toBe(0);
    });

    it('rimossa da uno, per gli altri risulta letta ma resta in lista', async () => {
        const tag = 'test-condivisa-dismiss';
        const mine = await insert(ownerId, 'service', tag);
        const theirs = await insert(managerId, 'service', tag);

        const res = await api().post(`/notifications/${mine}/dismiss`).set(bearer(owner));
        expect(res.status).toBe(200);
        const row = (await db.query(`SELECT read_at, dismissed_at FROM notifications WHERE id = $1`, [theirs])).rows[0];
        expect(row.read_at).not.toBeNull();
        expect(row.dismissed_at).toBeNull();
    });

    it('prenotazioni: letta da uno, letta per tutti', async () => {
        const tag = 'test-condivisa-reservation';
        const mine = await insert(ownerId, 'reservation', tag);
        const theirs = await insert(managerId, 'reservation', tag);

        await api().post(`/notifications/${mine}/read`).set(bearer(owner));
        expect(await readAt(mine)).not.toBeNull();
        expect(await readAt(theirs)).not.toBeNull();
    });

    it('pagamenti: letto da uno, letto per tutti', async () => {
        const tag = 'test-condivisa-payment';
        const mine = await insert(ownerId, 'payment', tag);
        const theirs = await insert(managerId, 'payment', tag);

        await api().post(`/notifications/${mine}/read`).set(bearer(owner));
        expect(await readAt(mine)).not.toBeNull();
        expect(await readAt(theirs)).not.toBeNull();
    });

    it('incassi visti in Pagamenti: «Pagamento ricevuto» si spegne per tutti', async () => {
        const pr = await db.query(
            `INSERT INTO payment_requests (tenant_id, amount_cents, currency, description, status, provider)
             VALUES (1, 2500, 'EUR', 'notifica condivisa', 'COMPLETED', 'revolut') RETURNING id`
        );
        const prId = Number(pr.rows[0].id);
        try {
            const mine = await insert(ownerId, 'payment', `payment-${prId}`);
            const theirs = await insert(managerId, 'payment', `payment-${prId}`);

            const res = await api().post('/payments/mark-seen').set(bearer(owner));
            expect(res.status).toBe(200);
            expect(await readAt(mine)).not.toBeNull();
            expect(await readAt(theirs)).not.toBeNull();
        } finally {
            await db.query(`DELETE FROM notifications WHERE tag = $1`, [`payment-${prId}`]);
            await db.query(`DELETE FROM payment_requests WHERE id = $1`, [prId]);
        }
    });

    it('sistema: letta da uno, letta per tutti', async () => {
        const tag = 'test-condivisa-system';
        const mine = await insert(ownerId, 'system', tag);
        const theirs = await insert(managerId, 'system', tag);

        await api().post(`/notifications/${mine}/read`).set(bearer(owner));
        expect(await readAt(mine)).not.toBeNull();
        expect(await readAt(theirs)).not.toBeNull();
    });

    it('generiche: letta da uno, letta per tutti', async () => {
        const tag = 'test-condivisa-general';
        const mine = await insert(ownerId, 'general', tag);
        const theirs = await insert(managerId, 'general', tag);

        await api().post(`/notifications/${mine}/read`).set(bearer(owner));
        expect(await readAt(mine)).not.toBeNull();
        expect(await readAt(theirs)).not.toBeNull();
    });

    it('email: letta da uno, letta per tutti; e il thread letto la spegne', async () => {
        const tag = 'test-condivisa-email';
        const mine = await insert(ownerId, 'email', tag);
        const theirs = await insert(managerId, 'email', tag);
        await api().post(`/notifications/${mine}/read`).set(bearer(owner));
        expect(await readAt(theirs)).not.toBeNull();

        const from = 'cliente.notifiche@example.com';
        const msg = await db.query(
            `INSERT INTO outbound_messages (tenant_id, provider, channel, direction, from_email, body, status)
             VALUES (1, 'imap', 'email', 'inbound', $1, 'Avete un tavolo per sabato?', 'received') RETURNING id`,
            [from]
        );
        const msgId = Number(msg.rows[0].id);
        try {
            const a = await insert(ownerId, 'email', `email-inbound-${msgId}`);
            const b = await insert(managerId, 'email', `email-inbound-${msgId}`);
            const res = await api().post(`/email/threads/${encodeURIComponent(from)}/read`).set(bearer(manager));
            expect(res.status).toBe(200);
            expect(await readAt(a)).not.toBeNull();
            expect(await readAt(b)).not.toBeNull();
        } finally {
            await db.query(`DELETE FROM notifications WHERE tag = $1`, [`email-inbound-${msgId}`]);
            await db.query(`DELETE FROM outbound_messages WHERE id = $1`, [msgId]);
        }
    });

    it('chat staff e fatturazione restano personali', async () => {
        for (const category of ['staff', 'billing']) {
            const tag = `test-condivisa-${category}`;
            const mine = await insert(ownerId, category, tag);
            const theirs = await insert(managerId, category, tag);

            await api().post(`/notifications/${mine}/read`).set(bearer(owner));
            expect(await readAt(mine)).not.toBeNull();
            expect(await readAt(theirs)).toBeNull();
        }
    });

    it('richiesta confermata o prenotazione eliminata: la campanella si spegne per tutti', async () => {
        const body = {
            customer_name: 'Notifica Condivisa Test',
            phone: '3390000998',
            reservation_time: '2027-08-12T20:00:00',
            shift: 'DINNER',
            guests: 2,
            children: 0,
        };
        const created = await api().post('/reservations').set(bearer(owner)).send(body);
        expect(created.status).toBe(201);
        const id = Number(created.body.id);
        try {
            // Come una richiesta arrivata dal sito, in attesa di conferma.
            await db.query(`UPDATE reservations SET reservation_status = 'PENDING' WHERE id = $1`, [id]);
            // La push di creazione è fire-and-forget: si parte da righe note.
            await db.query(`DELETE FROM notifications WHERE tag IN ($1, $2)`, [`pending-${id}`, `reservation-${id}`]);
            const pending = await insert(managerId, 'reservation', `pending-${id}`);
            const created2 = await insert(managerId, 'reservation', `reservation-${id}`);

            const confirmed = await api().put(`/reservations/${id}`).set(bearer(owner))
                .send({ ...body, reservation_status: 'CONFIRMED' });
            expect(confirmed.status).toBe(200);
            expect(await readAt(pending)).not.toBeNull();
            expect(await readAt(created2)).toBeNull();

            const del = await api().delete(`/reservations/${id}`).set(bearer(owner));
            expect(del.status).toBe(204);
            expect(await readAt(created2)).not.toBeNull();
        } finally {
            await db.query(`DELETE FROM notifications WHERE tag IN ($1, $2)`, [`pending-${id}`, `reservation-${id}`]);
            await db.query(`DELETE FROM reservations WHERE id = $1`, [id]);
        }
    });

    it('tap sulla push: segna letta per tag, e per i colleghi se è di squadra', async () => {
        const tag = 'test-condivisa-tap';
        const mine = await insert(managerId, 'message', tag);
        const theirs = await insert(ownerId, 'message', tag);

        const res = await api().post('/notifications/read-by-tag').set(bearer(manager)).send({ tag });
        expect(res.status).toBe(200);
        expect(res.body.marked).toBe(1);
        expect(await readAt(mine)).not.toBeNull();
        expect(await readAt(theirs)).not.toBeNull();

        const bad = await api().post('/notifications/read-by-tag').set(bearer(manager)).send({});
        expect(bad.status).toBe(400);
    });

    it('chiamata segnata ricontattata: la campanella si spegne per tutti', async () => {
        const ent = await api().put('/settings/entitlements').set(bearer(owner)).send({ voice: true });
        expect(ent.status).toBe(200);
        const conv = 'test-condivisa-conv';
        const call = await db.query(
            `INSERT INTO voice_calls (tenant_id, conversation_id, phone, duration_seconds)
             VALUES (1, $1, '+393390000999', 12) RETURNING id`,
            [conv]
        );
        const callId = Number(call.rows[0].id);
        try {
            const mine = await insert(ownerId, 'voice', `voice-followup-${conv}`);
            const theirs = await insert(managerId, 'voice', `voice-followup-${conv}`);

            const res = await api().patch(`/voice-calls/${callId}/follow-up`).set(bearer(owner)).send({ status: 'CONTACTED' });
            expect(res.status).toBe(200);
            expect(res.body.conversation_id).toBeUndefined();
            expect(await readAt(mine)).not.toBeNull();
            expect(await readAt(theirs)).not.toBeNull();
        } finally {
            await db.query(`DELETE FROM notifications WHERE tag = $1`, [`voice-followup-${conv}`]);
            await db.query(`DELETE FROM voice_calls WHERE id = $1`, [callId]);
        }
    });

    it('segna tutte come lette propaga solo le categorie di squadra', async () => {
        const shared = await insert(ownerId, 'voice', 'test-condivisa-all-voice');
        const sharedTheirs = await insert(managerId, 'voice', 'test-condivisa-all-voice');
        await insert(ownerId, 'billing', 'test-condivisa-all-bill');
        const personalTheirs = await insert(managerId, 'billing', 'test-condivisa-all-bill');

        const res = await api().post('/notifications/read-all').set(bearer(owner));
        expect(res.status).toBe(200);
        expect(await readAt(shared)).not.toBeNull();
        expect(await readAt(sharedTheirs)).not.toBeNull();
        expect(await readAt(personalTheirs)).toBeNull();
    });
});

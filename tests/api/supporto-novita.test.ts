import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import bcrypt from 'bcryptjs';
import { Client } from 'pg';
import { api, ownerToken, bearer } from './helpers';
// Il sorgente: la funzione è pura (testo in, righe out).
import { parseNewsRegistry } from '../../services/supportNews';

// Supporto, fase 4:
// - «Novità» lette dal registro del catalogo, senza le righe interne della
//   piattaforma e senza il markdown;
// - la valutazione di una richiesta risolta, solo di chi l'ha aperta;
// - le metriche della tab Supporto (mediane, valutazioni, categorie).

const ADMIN_HEADER = { 'X-Platform-Admin-Token': 'test-platform-token' };
const WAITER_EMAIL = 'cameriere.valutazione@example.com';
const WAITER_PASSWORD = 'password-valutazione-waiter';
const PA_EMAIL = 'platform.admin.valutazione@example.com';
const PA_PASSWORD = 'password-valutazione-piattaforma';

const pgClient = async (): Promise<Client> => {
    const client = new Client({ connectionString: process.env.DATABASE_URL || 'postgresql://localhost/ristotest_api' });
    await client.connect();
    return client;
};

describe('novità dal registro', () => {
    it('righe più recenti prima, senza markdown e senza le sezioni della piattaforma', () => {
        const md = [
            '# Catalogo', '', '## Registro aggiornamenti', '',
            '| Data | Sezione | Modifica |', '|---|---|---|',
            '| 2026-10-01 | Prenotazioni | La **mappa** mostra i `tavoli` liberi. |',
            '| 2026-10-03 | Piattaforma SaaS | Nuovo pannello interno. |',
            '| 2026-10-03 | Cassa | Lo scontrino si ristampa. |',
            '| 2026-10-02 | Development, Roadmap | Board più veloce. |',
            '| riga | non | valida |',
        ].join('\n');
        expect(parseNewsRegistry(md)).toEqual([
            { date: '2026-10-03', section: 'Cassa', text: 'Lo scontrino si ristampa.' },
            { date: '2026-10-01', section: 'Prenotazioni', text: 'La mappa mostra i tavoli liberi.' },
        ]);
        expect(parseNewsRegistry('# niente registro')).toEqual([]);
    });

    it('GET /support/news legge il registro vero del catalogo', async () => {
        expect((await api().get('/support/news')).status).toBe(401);
        const res = await api().get('/support/news?limit=5').set(bearer(await ownerToken()));
        expect(res.status).toBe(200);
        expect(res.body.entries.length).toBe(5);
        const dates = res.body.entries.map((e: any) => e.date);
        expect([...dates].sort().reverse()).toEqual(dates);
        for (const e of res.body.entries) {
            expect(e.section).not.toMatch(/piattaforma/i);
            expect(e.text).not.toContain('**');
        }
    });
});

describe('valutazione e metriche del supporto', () => {
    let db: Client;
    let owner = '';
    let waiter = '';
    let platform = '';
    let ticketId = 0;

    beforeAll(async () => {
        db = await pgClient();
        owner = await ownerToken();
        const created = await api().post('/auth/users').set(bearer(owner)).send({
            email: WAITER_EMAIL, password: WAITER_PASSWORD, full_name: 'Cameriere Valutazione', role: 'WAITER',
        });
        expect(created.status).toBe(201);
        waiter = (await api().post('/auth/login').send({ email: WAITER_EMAIL, password: WAITER_PASSWORD })).body.accessToken;
        await db.query(
            `INSERT INTO users (email, password_hash, full_name, role, tenant_id, is_active)
             VALUES ($1, $2, 'Admin Valutazione', 'PLATFORM_ADMIN', 1, TRUE)`,
            [PA_EMAIL, bcrypt.hashSync(PA_PASSWORD, 4)]
        );
        platform = (await api().post('/auth/login').send({ email: PA_EMAIL, password: PA_PASSWORD })).body.accessToken;

        const ticket = await api().post('/support/tickets').set(bearer(waiter)).send({
            category: 'stampa', subject: 'Il preconto esce due volte', body: 'Da ieri sera.',
        });
        expect(ticket.status).toBe(201);
        ticketId = ticket.body.id;
    });

    afterAll(async () => {
        await db.query(`DELETE FROM support_messages WHERE ticket_id = $1`, [ticketId]);
        await db.query(`DELETE FROM support_tickets WHERE id = $1`, [ticketId]);
        await db.query(`DELETE FROM notifications WHERE tag IN ($1, $2)`, [`support-${ticketId}`, `support-admin-${ticketId}`]);
        for (const email of [WAITER_EMAIL, PA_EMAIL]) {
            await db.query('DELETE FROM activity_logs WHERE user_email = $1', [email]);
            await db.query('DELETE FROM user_sessions WHERE user_id IN (SELECT id FROM users WHERE email = $1)', [email]);
            await db.query('DELETE FROM users WHERE email = $1', [email]);
        }
        await db.end();
    });

    it('una richiesta aperta non si valuta', async () => {
        const res = await api().post(`/support/tickets/${ticketId}/rating`).set(bearer(waiter)).send({ rating: 1 });
        expect(res.status).toBe(409);
        expect(res.body.error).toBe('not_resolved');
    });

    it('risolta, la valuta solo chi l\'ha aperta', async () => {
        const reply = await api().post(`/admin/support/tickets/${ticketId}/messages`).set(bearer(platform))
            .send({ body: 'Sistemato: era la regola di stampa doppia.', status: 'risolto' });
        expect(reply.status).toBe(201);

        expect((await api().post(`/support/tickets/${ticketId}/rating`).set(bearer(waiter)).send({ rating: 5 })).status).toBe(400);
        const byOwner = await api().post(`/support/tickets/${ticketId}/rating`).set(bearer(owner)).send({ rating: 1 });
        expect(byOwner.status).toBe(403);
        expect(byOwner.body.error).toBe('not_creator');

        const good = await api().post(`/support/tickets/${ticketId}/rating`).set(bearer(waiter)).send({ rating: 1 });
        expect(good.status).toBe(200);
        expect(good.body.rating).toBe(1);
        expect(good.body.rated_at).toBeTruthy();

        // Si può cambiare idea: vale l'ultima, col suo commento.
        const bad = await api().post(`/support/tickets/${ticketId}/rating`).set(bearer(waiter))
            .send({ rating: -1, comment: '  Ci è voluto un giorno intero.  ' });
        expect(bad.status).toBe(200);
        expect(bad.body.rating).toBe(-1);
        expect(bad.body.rating_comment).toBe('Ci è voluto un giorno intero.');

        const panel = await api().get(`/admin/support/tickets/${ticketId}`).set(bearer(platform));
        expect(panel.body.rating).toBe(-1);
        expect(panel.body.rating_comment).toBe('Ci è voluto un giorno intero.');
    });

    it('le metriche contano richieste, risposte, risoluzioni e valutazioni', async () => {
        expect((await api().get('/admin/support/metrics').set(bearer(owner))).status).toBe(401);
        const res = await api().get('/admin/support/metrics?days=30').set(bearer(platform));
        expect(res.status).toBe(200);
        expect(res.body.days).toBe(30);
        expect(res.body.opened).toBeGreaterThanOrEqual(1);
        expect(res.body.resolved).toBeGreaterThanOrEqual(1);
        expect(res.body.rating_down).toBeGreaterThanOrEqual(1);
        expect(typeof res.body.median_first_reply_minutes).toBe('number');
        expect(typeof res.body.median_resolution_hours).toBe('number');
        expect(res.body.by_category.some((c: any) => c.category === 'stampa' && c.n >= 1)).toBe(true);
    });
});

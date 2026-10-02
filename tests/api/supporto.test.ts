import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import bcrypt from 'bcryptjs';
import { Client } from 'pg';
import { io as ioClient, type Socket } from 'socket.io-client';
import { api, ownerToken, bearer } from './helpers';
import { platformSessionFor, dropPlatformSession } from './platformSession';

// Supporto clienti (Aiuto): le richieste dal ristorante al team Sympotia.
// - lato ristorante: chi apre vede le proprie, titolare e direzione tutte;
//   un altro ristorante non vede niente; la piattaforma dentro il tenant
//   (impersonation, «Entra») legge ma non scrive a nome del ristorante;
// - lato piattaforma: coda cross-tenant dietro platformAdminAuth, risposta
//   che notifica chi ha aperto, card del dev board;
// - notifiche: l'avviso agli admin e la risposta al ristorante finiscono in
//   `notifications` (le push vere non partono: nei test VAPID non c'è).

const ADMIN_HEADER = { 'X-Platform-Admin-Token': 'test-platform-token' };
const WAITER_EMAIL = 'cameriere.supporto@example.com';
const WAITER_PASSWORD = 'password-supporto-waiter';
const PA_EMAIL = 'platform.admin.supporto@example.com';
const PA_PASSWORD = 'password-supporto-piattaforma';
const SLUG = 'trattoria-test-supporto';

// PNG 1x1 trasparente: basta per il percorso upload → allegato → download.
const PNG_1x1 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

const pgClient = async (): Promise<Client> => {
    const client = new Client({ connectionString: process.env.DATABASE_URL || 'postgresql://localhost/ristotest_api' });
    await client.connect();
    return client;
};

const connetti = (token: string): Promise<Socket> => new Promise((resolve, reject) => {
    const socket = ioClient(process.env.TEST_BASE_URL as string, {
        transports: ['websocket', 'polling'],
        auth: { token },
        timeout: 10_000,
    });
    const fallisci = (e: Error) => { clearTimeout(t); socket.close(); reject(e); };
    const t = setTimeout(() => fallisci(new Error('socket non connesso')), 10_000);
    socket.on('connect', () => { clearTimeout(t); resolve(socket); });
    socket.on('connect_error', fallisci);
});

// Raccoglie gli eventi di un tipo su un socket, per controllarli dopo.
const ascolta = (socket: Socket, event: string): Array<any> => {
    const seen: any[] = [];
    socket.on(event, (payload: any) => seen.push(payload));
    return seen;
};

const finché = async (cond: () => boolean, ms = 3000): Promise<boolean> => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
        if (cond()) return true;
        await new Promise(res => setTimeout(res, 50));
    }
    return cond();
};

// Le notifiche partono fuori dalla risposta (void): si aspetta la riga.
const waitForNotification = async (tag: string, email: string): Promise<any | null> => {
    const client = await pgClient();
    try {
        for (let i = 0; i < 40; i++) {
            const r = await client.query(
                `SELECT n.* FROM notifications n JOIN users u ON u.id = n.recipient_user_id
                  WHERE n.tag = $1 AND u.email = $2 ORDER BY n.id DESC LIMIT 1`,
                [tag, email]
            );
            if (r.rows[0]) return r.rows[0];
            await new Promise(res => setTimeout(res, 100));
        }
        return null;
    } finally {
        await client.end();
    }
};

describe('supporto clienti (Aiuto)', () => {
    let owner = '';
    let waiter = '';
    let platform = '';
    let otherTenantId = 0;
    let otherTenantToken = '';
    let waiterTicketId = 0;
    let ownerTicketId = 0;
    let urgentTicketId = 0;
    let photoToken = '';

    beforeAll(async () => {
        owner = await ownerToken();
        const created = await api().post('/auth/users').set(bearer(owner)).send({
            email: WAITER_EMAIL, password: WAITER_PASSWORD, full_name: 'Cameriere Supporto', role: 'WAITER',
        });
        expect(created.status).toBe(201);
        const login = await api().post('/auth/login').send({ email: WAITER_EMAIL, password: WAITER_PASSWORD });
        expect(login.status).toBe(200);
        waiter = login.body.accessToken;

        const client = await pgClient();
        try {
            await client.query(
                `INSERT INTO users (email, password_hash, full_name, role, tenant_id, is_active)
                 VALUES ($1, $2, 'Marco Supporto', 'PLATFORM_ADMIN', 1, TRUE)`,
                [PA_EMAIL, bcrypt.hashSync(PA_PASSWORD, 4)]
            );
            // Id alti per il secondo ristorante: nessun riuso di id che altri
            // file inseriscono a mano (vedi impersonation.test.ts).
            await client.query(
                `SELECT setval(pg_get_serial_sequence('tenants','id'), GREATEST((SELECT MAX(id) FROM tenants), 100))`
            );
        } finally {
            await client.end();
        }
        const pa = await api().post('/auth/login').send({ email: PA_EMAIL, password: PA_PASSWORD });
        expect(pa.status).toBe(200);
        platform = pa.body.accessToken;

        const other = await api().post('/admin/tenants').set(ADMIN_HEADER).send({
            slug: SLUG, name: 'Trattoria Test Supporto', owner_email: 'owner.supporto@example.com', owner_full_name: 'Owner Supporto',
        });
        expect(other.status).toBe(201);
        otherTenantId = other.body.tenant.id;
        const imp = await api().post(`/admin/tenants/${otherTenantId}/impersonate`).set(ADMIN_HEADER);
        expect(imp.status).toBe(200);
        otherTenantToken = imp.body.accessToken;
    });

    afterAll(async () => {
        await dropPlatformSession();
        const client = await pgClient();
        try {
            await client.query(`DELETE FROM outbound_media WHERE token IN (
                SELECT jsonb_array_elements(attachments)->>'token' FROM support_messages)`);
            await client.query(`DELETE FROM outbound_media WHERE created_by_user_id IN (SELECT id FROM users WHERE email = $1)`, [WAITER_EMAIL]);
            await client.query('DELETE FROM support_messages');
            await client.query('DELETE FROM support_tickets');
            await client.query(`DELETE FROM dev_board_cards WHERE title LIKE '[Supporto #%'`);
            await client.query(`DELETE FROM notifications WHERE tag LIKE 'support-%'`);
            for (const email of [WAITER_EMAIL, PA_EMAIL]) {
                await client.query('DELETE FROM activity_logs WHERE user_email = $1', [email]);
                await client.query('DELETE FROM user_sessions WHERE user_id IN (SELECT id FROM users WHERE email = $1)', [email]);
                await client.query('DELETE FROM users WHERE email = $1', [email]);
            }
            if (otherTenantId) {
                for (const table of ['activity_logs', 'user_sessions', 'users', 'tenant_features', 'opening_hours', 'role_permissions', 'app_settings']) {
                    await client.query(`DELETE FROM ${table} WHERE tenant_id = $1`, [otherTenantId]).catch(() => {});
                }
                await client.query('DELETE FROM tenants WHERE id = $1', [otherTenantId]);
            }
        } finally {
            await client.end();
        }
    });

    describe('lato ristorante', () => {
        it('valida categoria, oggetto e descrizione', async () => {
            const badCategory = await api().post('/support/tickets').set(bearer(waiter))
                .send({ category: 'inventata', subject: 'x', body: 'y' });
            expect(badCategory.status).toBe(400);
            expect(badCategory.body.error).toBe('invalid_category');
            const noSubject = await api().post('/support/tickets').set(bearer(waiter))
                .send({ category: 'stampa', subject: '   ', body: 'y' });
            expect(noSubject.status).toBe(400);
            expect(noSubject.body.error).toBe('invalid_subject');
        });

        it('il cameriere apre una richiesta: contesto client filtrato, contesto server aggiunto', async () => {
            const res = await api().post('/support/tickets').set(bearer(waiter)).send({
                category: 'stampa',
                subject: 'La comanda non esce in cucina',
                body: 'Da stasera la stampante della cucina non stampa.',
                context: { origin_view: 'COMANDE', app_version: 'abc1234', online: true, segreto: 'non deve passare' },
            });
            expect(res.status).toBe(201);
            waiterTicketId = res.body.id;
            expect(res.body.status).toBe('nuovo');
            expect(res.body.priority).toBe('normale');
            expect(res.body.platform_unread).toBe(true);
            expect(res.body.messages).toHaveLength(1);
            expect(res.body.messages[0].author_type).toBe('utente');
            expect(res.body.messages[0].author_name).toBe('Cameriere Supporto');
            expect(res.body.context.client).toEqual({ origin_view: 'COMANDE', app_version: 'abc1234', online: true });
            expect(res.body.context.server.tenant.id).toBe(1);
            expect(res.body.context.server.user.role).toBe('WAITER');
            expect(typeof res.body.context.server.server_version).toBe('string');
            expect(res.body.context.server.print_jobs_24h).toBeTruthy();
        });

        it("il cameriere vede le proprie richieste, non quelle del titolare", async () => {
            const own = await api().post('/support/tickets').set(bearer(owner)).send({
                category: 'fatturazione', subject: 'Domanda sulla fattura', body: 'Quando arriva la fattura di ottobre?',
            });
            expect(own.status).toBe(201);
            ownerTicketId = own.body.id;

            const list = await api().get('/support/tickets').set(bearer(waiter));
            expect(list.status).toBe(200);
            expect(list.body.sees_all).toBe(false);
            const ids = list.body.tickets.map((t: any) => t.id);
            expect(ids).toContain(waiterTicketId);
            expect(ids).not.toContain(ownerTicketId);

            const peek = await api().get(`/support/tickets/${ownerTicketId}`).set(bearer(waiter));
            expect(peek.status).toBe(404);
        });

        it('il titolare vede tutte le richieste del ristorante', async () => {
            const list = await api().get('/support/tickets').set(bearer(owner));
            expect(list.status).toBe(200);
            expect(list.body.sees_all).toBe(true);
            const ids = list.body.tickets.map((t: any) => t.id);
            expect(ids).toEqual(expect.arrayContaining([waiterTicketId, ownerTicketId]));
        });

        it('un altro ristorante non vede le richieste del tenant 1', async () => {
            const list = await api().get('/support/tickets').set(bearer(otherTenantToken));
            expect(list.status).toBe(200);
            expect(list.body.tickets).toHaveLength(0);
            const peek = await api().get(`/support/tickets/${waiterTicketId}`).set(bearer(otherTenantToken));
            expect(peek.status).toBe(404);
        });

        it("l'impersonation legge ma non apre richieste a nome del ristorante", async () => {
            const res = await api().post('/support/tickets').set(bearer(otherTenantToken))
                .send({ category: 'altro', subject: 'Prova', body: 'Prova' });
            expect(res.status).toBe(403);
            expect(res.body.error).toBe('platform_session');
        });

        it('la sessione «Entra» vede tutte le richieste ma non scrive al posto del ristorante', async () => {
            const scoped = await platformSessionFor(1);
            const list = await api().get('/support/tickets').set(bearer(scoped));
            expect(list.status).toBe(200);
            expect(list.body.sees_all).toBe(true);
            const reply = await api().post(`/support/tickets/${waiterTicketId}/messages`).set(bearer(scoped)).send({ body: 'ciao' });
            expect(reply.status).toBe(403);
        });

        it('il token di pannello non ha un ristorante: 403 sul lato tenant', async () => {
            const res = await api().get('/support/tickets').set(bearer(platform));
            expect(res.status).toBe(403);
            expect(res.body.error).toBe('tenant_session_required');
        });
    });

    describe('lato piattaforma', () => {
        it('un token di ristorante non apre /admin/support', async () => {
            const res = await api().get('/admin/support/tickets').set(bearer(owner));
            expect(res.status).toBe(401);
        });

        it('la coda mostra le richieste aperte di tutti i ristoranti, con i filtri', async () => {
            const res = await api().get('/admin/support/tickets').set(bearer(platform));
            expect(res.status).toBe(200);
            const mine = res.body.tickets.find((t: any) => t.id === waiterTicketId);
            expect(mine).toBeTruthy();
            expect(mine.tenant_id).toBe(1);
            expect(mine.tenant_name).toBeTruthy();
            expect(res.body.counts.nuovo).toBeGreaterThanOrEqual(2);
            expect(res.body.unread).toBeGreaterThanOrEqual(2);

            const otherOnly = await api().get(`/admin/support/tickets?tenant_id=${otherTenantId}`).set(bearer(platform));
            expect(otherOnly.status).toBe(200);
            expect(otherOnly.body.tickets).toHaveLength(0);

            const resolved = await api().get('/admin/support/tickets?status=risolto').set(bearer(platform));
            expect(resolved.status).toBe(200);
            expect(resolved.body.tickets).toHaveLength(0);
        });

        it('una richiesta urgente avvisa i platform admin', async () => {
            const res = await api().post('/support/tickets').set(bearer(waiter)).send({
                category: 'cassa_fiscale', urgent: true, subject: 'Lo scontrino non parte', body: 'Siamo in servizio e la cassa è ferma.',
            });
            expect(res.status).toBe(201);
            urgentTicketId = res.body.id;
            expect(res.body.priority).toBe('urgente');
            // La categoria cassa aggiunge gli scontrini falliti al contesto.
            expect(Array.isArray(res.body.context.server.fiscal_failed_24h)).toBe(true);
            const n = await waitForNotification(`support-admin-${urgentTicketId}`, PA_EMAIL);
            expect(n).toBeTruthy();
            expect(n.category).toBe('support');
            expect(n.url).toBe(`/?view=PLATFORM&support=${urgentTicketId}`);
        });

        it('aprire la richiesta dal pannello la segna letta e chiude l\'avviso', async () => {
            const res = await api().get(`/admin/support/tickets/${urgentTicketId}`).set(bearer(platform));
            expect(res.status).toBe(200);
            expect(res.body.platform_unread).toBe(false);
            expect(res.body.context.server.tenant.id).toBe(1);
            const n = await waitForNotification(`support-admin-${urgentTicketId}`, PA_EMAIL);
            expect(n.read_at).not.toBeNull();
        });

        it('la risposta della piattaforma passa la palla al ristorante e lo notifica', async () => {
            const res = await api().post(`/admin/support/tickets/${waiterTicketId}/messages`).set(bearer(platform))
                .send({ body: 'Ciao, riavvia la stampante e dimmi se riparte.', status: 'attesa_cliente' });
            expect(res.status).toBe(201);
            expect(res.body.status).toBe('attesa_cliente');
            expect(res.body.tenant_unread).toBe(true);
            const last = res.body.messages[res.body.messages.length - 1];
            expect(last.author_type).toBe('piattaforma');
            expect(last.author_name).toBe('Marco Supporto');

            const n = await waitForNotification(`support-${waiterTicketId}`, WAITER_EMAIL);
            expect(n).toBeTruthy();
            expect(n.url).toBe(`/?view=SUPPORTO&ticket=${waiterTicketId}`);
        });

        it('il titolare che sfoglia non spegne il «da leggere» del cameriere; il cameriere sì', async () => {
            const byOwner = await api().get(`/support/tickets/${waiterTicketId}`).set(bearer(owner));
            expect(byOwner.status).toBe(200);
            expect(byOwner.body.tenant_unread).toBe(true);

            const byWaiter = await api().get(`/support/tickets/${waiterTicketId}`).set(bearer(waiter));
            expect(byWaiter.status).toBe(200);
            expect(byWaiter.body.tenant_unread).toBe(false);
            const n = await waitForNotification(`support-${waiterTicketId}`, WAITER_EMAIL);
            expect(n.read_at).not.toBeNull();
        });

        it('la risposta del ristorante rimette la richiesta in corso', async () => {
            const res = await api().post(`/support/tickets/${waiterTicketId}/messages`).set(bearer(waiter))
                .send({ body: 'Riavviata, ora stampa.' });
            expect(res.status).toBe(201);
            expect(res.body.status).toBe('in_corso');
            expect(res.body.platform_unread).toBe(true);
        });

        it('il ristorante chiude la richiesta; scrivere di nuovo la riapre', async () => {
            const closed = await api().patch(`/support/tickets/${waiterTicketId}`).set(bearer(waiter)).send({ status: 'risolto' });
            expect(closed.status).toBe(200);
            expect(closed.body.status).toBe('risolto');
            expect(closed.body.resolved_at).toBeTruthy();

            const reopened = await api().post(`/support/tickets/${waiterTicketId}/messages`).set(bearer(waiter))
                .send({ body: 'Si è fermata di nuovo.' });
            expect(reopened.status).toBe(201);
            expect(reopened.body.status).toBe('nuovo');
            expect(reopened.body.resolved_at).toBeNull();
        });

        it('il ristorante può segnalare urgente una richiesta già aperta', async () => {
            const res = await api().patch(`/support/tickets/${waiterTicketId}`).set(bearer(waiter)).send({ priority: 'urgente' });
            expect(res.status).toBe(200);
            expect(res.body.priority).toBe('urgente');
            const bad = await api().patch(`/support/tickets/${waiterTicketId}`).set(bearer(waiter)).send({ status: 'in_corso' });
            expect(bad.status).toBe(400);
        });

        it('la piattaforma cambia stato senza rispondere', async () => {
            const res = await api().patch(`/admin/support/tickets/${ownerTicketId}`).set(bearer(platform)).send({ status: 'risolto' });
            expect(res.status).toBe(200);
            expect(res.body.status).toBe('risolto');
            const bad = await api().patch(`/admin/support/tickets/${ownerTicketId}`).set(bearer(platform)).send({ status: 'chiuso' });
            expect(bad.status).toBe(400);
        });

        it('la richiesta diventa una card del dev board, una volta sola', async () => {
            const res = await api().post(`/admin/support/tickets/${urgentTicketId}/dev-card`).set(bearer(platform));
            expect(res.status).toBe(201);
            const cardId = res.body.dev_card_id;
            const client = await pgClient();
            try {
                const card = await client.query('SELECT title, tenant_id, labels, description FROM dev_board_cards WHERE id = $1', [cardId]);
                expect(card.rows[0].title).toBe(`[Supporto #${urgentTicketId}] Lo scontrino non parte`);
                expect(Number(card.rows[0].tenant_id)).toBe(1);
                expect(card.rows[0].labels).toEqual(['pagamenti']);
                expect(card.rows[0].description).toContain('Siamo in servizio');
            } finally {
                await client.end();
            }
            const again = await api().post(`/admin/support/tickets/${urgentTicketId}/dev-card`).set(bearer(platform));
            expect(again.status).toBe(409);
        });
    });

    describe('tempo reale', () => {
        const sockets: Socket[] = [];
        afterAll(() => { for (const s of sockets) s.disconnect(); });

        it('il pannello riceve gli eventi del supporto, il ristorante i suoi; nessuno quelli dell\'altro', async () => {
            const panel = await connetti(platform);
            const waiterSock = await connetti(waiter);
            const ownerSock = await connetti(owner);
            sockets.push(panel, waiterSock, ownerSock);
            const panelAdmin = ascolta(panel, 'support:admin-updated');
            const panelTenant = ascolta(panel, 'support:updated');
            const waiterTenant = ascolta(waiterSock, 'support:updated');
            const waiterAdmin = ascolta(waiterSock, 'support:admin-updated');
            const ownerTenant = ascolta(ownerSock, 'support:updated');

            // Il cameriere apre: il pannello lo sa subito, e anche il titolare.
            const created = await api().post('/support/tickets').set(bearer(waiter)).send({
                category: 'altro', subject: 'Tempo reale', body: 'Prova socket',
            });
            expect(created.status).toBe(201);
            const id = created.body.id;
            expect(await finché(() => panelAdmin.some(p => p.id === id))).toBe(true);
            expect(panelAdmin.find(p => p.id === id).tenant_id).toBe(1);
            expect(await finché(() => ownerTenant.some(p => p.id === id))).toBe(true);

            // La piattaforma risponde: arriva al cameriere e al titolare.
            waiterTenant.length = 0;
            ownerTenant.length = 0;
            const reply = await api().post(`/admin/support/tickets/${id}/messages`).set(bearer(platform))
                .send({ body: 'Ci sono', status: 'attesa_cliente' });
            expect(reply.status).toBe(201);
            expect(await finché(() => waiterTenant.some(p => p.id === id))).toBe(true);
            expect(await finché(() => ownerTenant.some(p => p.id === id))).toBe(true);

            // Il cameriere risponde: la conversazione aperta nel pannello si aggiorna.
            panelAdmin.length = 0;
            const back = await api().post(`/support/tickets/${id}/messages`).set(bearer(waiter)).send({ body: 'Grazie' });
            expect(back.status).toBe(201);
            expect(await finché(() => panelAdmin.some(p => p.id === id))).toBe(true);

            // Le due stanze non si mescolano: il pannello non entra in quella
            // del ristorante, il ristorante non sente la stanza del pannello.
            expect(panelTenant).toEqual([]);
            expect(waiterAdmin).toEqual([]);
        });
    });

    describe('foto allegate', () => {
        it('solo immagini, solo token caricati da chi scrive', async () => {
            const pdf = await api().post('/support/attachments').set(bearer(waiter))
                .send({ content_type: 'application/pdf', filename: 'x.pdf', data: PNG_1x1 });
            expect(pdf.status).toBe(415);

            const up = await api().post('/support/attachments').set(bearer(waiter))
                .send({ content_type: 'image/png', filename: 'schermo.png', data: PNG_1x1 });
            expect(up.status).toBe(201);
            photoToken = up.body.token;

            // Il titolare non può allegare la foto caricata dal cameriere.
            const stolen = await api().post('/support/tickets').set(bearer(owner)).send({
                category: 'altro', subject: 'Foto altrui', body: 'x', attachments: [photoToken],
            });
            expect(stolen.status).toBe(400);
            expect(stolen.body.error).toBe('invalid_attachments');

            const res = await api().post('/support/tickets').set(bearer(waiter)).send({
                category: 'menu', subject: 'Prezzo sbagliato', body: 'Vedi foto', attachments: [photoToken],
            });
            expect(res.status).toBe(201);
            expect(res.body.messages[0].attachments).toEqual([
                { token: photoToken, content_type: 'image/png', filename: 'schermo.png' },
            ]);
        });

        it('la foto si scarica solo con login, e solo da chi vede la richiesta', async () => {
            const byWaiter = await api().get(`/support/attachments/${photoToken}`).set(bearer(waiter));
            expect(byWaiter.status).toBe(200);
            expect(byWaiter.headers['content-type']).toBe('image/png');

            const byOwner = await api().get(`/support/attachments/${photoToken}`).set(bearer(owner));
            expect(byOwner.status).toBe(200);

            const byOther = await api().get(`/support/attachments/${photoToken}`).set(bearer(otherTenantToken));
            expect(byOther.status).toBe(404);

            const anonymous = await api().get(`/support/attachments/${photoToken}`);
            expect(anonymous.status).toBe(401);

            const byPlatform = await api().get(`/admin/support/attachments/${photoToken}`).set(bearer(platform));
            expect(byPlatform.status).toBe(200);
        });
    });
});

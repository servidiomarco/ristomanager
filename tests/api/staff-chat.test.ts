import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Client } from 'pg';
import { api, ownerToken, bearer } from './helpers';

// Chat staff (docs/chat-staff-plan.md): canali fissi derivati dal ruolo +
// DM 1-a-1, lettura a cursore. Qui si certifica il contratto delle route:
// membership per ruolo (403 fuori canale), non letti che contano solo i
// messaggi degli altri, cursore monotono.

const KITCHEN_EMAIL = 'cucina.chat@example.com';
const WAITER_EMAIL = 'sala.chat@example.com';
const PASSWORD = 'password-chat-staff';

describe('chat staff', () => {
    let owner = '';
    let ownerId = 0;
    let kitchenToken = '';
    let kitchenId = 0;
    let waiterToken = '';
    let waiterId = 0;

    beforeAll(async () => {
        owner = await ownerToken();
        const me = await api().post('/auth/login').send({
            email: process.env.TEST_OWNER_EMAIL,
            password: process.env.TEST_OWNER_PASSWORD,
        });
        ownerId = me.body.user.id;

        for (const [email, role] of [[KITCHEN_EMAIL, 'KITCHEN'], [WAITER_EMAIL, 'WAITER']] as const) {
            const created = await api().post('/auth/users').set(bearer(owner)).send({
                email, password: PASSWORD, full_name: `Test ${role}`, role,
            });
            expect(created.status).toBe(201);
            const login = await api().post('/auth/login').send({ email, password: PASSWORD });
            expect(login.status).toBe(200);
            if (role === 'KITCHEN') { kitchenToken = login.body.accessToken; kitchenId = login.body.user.id; }
            else { waiterToken = login.body.accessToken; waiterId = login.body.user.id; }
        }
    });

    afterAll(async () => {
        // I file di test condividono il database e girano in sequenza: si
        // rimuove quello che questo file ha creato.
        const dbUrl = process.env.DATABASE_URL || 'postgresql://localhost/ristotest_api';
        const client = new Client({ connectionString: dbUrl });
        await client.connect();
        try {
            await client.query(`DELETE FROM staff_message_reads WHERE TRUE`);
            await client.query(`DELETE FROM staff_messages WHERE TRUE`);
            await client.query(`DELETE FROM users WHERE email IN ($1, $2)`, [KITCHEN_EMAIL, WAITER_EMAIL]);
        } finally {
            await client.end();
        }
    });

    it('un KITCHEN vede solo i suoi canali e non entra in sala', async () => {
        const threads = await api().get('/staff-chat/threads').set(bearer(kitchenToken));
        expect(threads.status).toBe(200);
        const channels = threads.body.threads.filter((t: any) => t.kind === 'channel').map((t: any) => t.channel).sort();
        expect(channels).toEqual(['cucina', 'generale']);

        const read = await api().get('/staff-chat/threads/channel:sala/messages').set(bearer(kitchenToken));
        expect(read.status).toBe(403);
        const write = await api().post('/staff-chat/messages').set(bearer(kitchenToken))
            .send({ threadKey: 'channel:sala', body: 'non dovrei poter scrivere qui' });
        expect(write.status).toBe(403);
    });

    it('messaggio in canale: arriva nel thread, conta come non letto per gli altri e non per il mittente', async () => {
        const sent = await api().post('/staff-chat/messages').set(bearer(owner))
            .send({ threadKey: 'channel:sala', body: 'serve un runner al 12', presetKey: 'serve-runner' });
        expect(sent.status).toBe(201);
        expect(sent.body.kind).toBe('channel');
        expect(sent.body.channel).toBe('sala');
        expect(sent.body.sender_user_id).toBe(ownerId);
        expect(sent.body.preset_key).toBe('serve-runner');

        const page = await api().get('/staff-chat/threads/channel:sala/messages').set(bearer(owner));
        expect(page.status).toBe(200);
        expect(page.body.messages.map((m: any) => m.id)).toContain(sent.body.id);

        const waiterThreads = await api().get('/staff-chat/threads').set(bearer(waiterToken));
        const sala = waiterThreads.body.threads.find((t: any) => t.threadKey === 'channel:sala');
        expect(sala.unreadCount).toBe(1);
        expect(sala.lastMessage.id).toBe(sent.body.id);

        const ownerThreads = await api().get('/staff-chat/threads').set(bearer(owner));
        const salaOwner = ownerThreads.body.threads.find((t: any) => t.threadKey === 'channel:sala');
        expect(salaOwner.unreadCount).toBe(0);

        const count = await api().get('/staff-chat/unread-count').set(bearer(waiterToken));
        expect(count.body.count).toBe(1);
    });

    it('il cursore di lettura azzera i non letti e non torna indietro', async () => {
        const page = await api().get('/staff-chat/threads/channel:sala/messages').set(bearer(waiterToken));
        const lastId = page.body.messages[page.body.messages.length - 1].id;

        const read = await api().post('/staff-chat/threads/channel:sala/read').set(bearer(waiterToken))
            .send({ lastReadMessageId: Number(lastId) });
        expect(read.status).toBe(200);

        const after = await api().get('/staff-chat/threads').set(bearer(waiterToken));
        expect(after.body.threads.find((t: any) => t.threadKey === 'channel:sala').unreadCount).toBe(0);

        // Un device in ritardo che manda un cursore più basso non riapre i
        // non letti (upsert con GREATEST).
        const stale = await api().post('/staff-chat/threads/channel:sala/read').set(bearer(waiterToken))
            .send({ lastReadMessageId: 1 });
        expect(stale.status).toBe(200);
        const still = await api().get('/staff-chat/threads').set(bearer(waiterToken));
        expect(still.body.threads.find((t: any) => t.threadKey === 'channel:sala').unreadCount).toBe(0);
    });

    it('DM: visibile solo ai due capi, threadKey speculare, non letti sul destinatario', async () => {
        const sent = await api().post('/staff-chat/messages').set(bearer(owner))
            .send({ threadKey: `dm:${waiterId}`, body: 'puoi coprire il turno di sabato?' });
        expect(sent.status).toBe(201);
        expect(sent.body.kind).toBe('direct');
        expect(sent.body.recipient_user_id).toBe(waiterId);

        // Il destinatario vede il thread come dm:<mittente>.
        const waiterThreads = await api().get('/staff-chat/threads').set(bearer(waiterToken));
        const dm = waiterThreads.body.threads.find((t: any) => t.threadKey === `dm:${ownerId}`);
        expect(dm).toBeTruthy();
        expect(dm.unreadCount).toBe(1);
        expect(dm.otherUser.id).toBe(ownerId);

        const thread = await api().get(`/staff-chat/threads/dm:${ownerId}/messages`).set(bearer(waiterToken));
        expect(thread.body.messages.map((m: any) => m.id)).toContain(sent.body.id);

        // Un terzo utente non ha il thread né i suoi messaggi.
        const kitchenThreads = await api().get('/staff-chat/threads').set(bearer(kitchenToken));
        expect(kitchenThreads.body.threads.some((t: any) => t.kind === 'direct')).toBe(false);
        const spy = await api().get(`/staff-chat/threads/dm:${ownerId}/messages`).set(bearer(kitchenToken));
        expect(spy.status).toBe(200);
        expect(spy.body.messages.map((m: any) => m.id)).not.toContain(sent.body.id);
    });

    it('validazioni: thread inesistente, corpo vuoto, DM a se stessi', async () => {
        const badKey = await api().post('/staff-chat/messages').set(bearer(owner))
            .send({ threadKey: 'channel:bancone', body: 'ciao' });
        expect(badKey.status).toBe(400);

        const empty = await api().post('/staff-chat/messages').set(bearer(owner))
            .send({ threadKey: 'channel:generale', body: '   ' });
        expect(empty.status).toBe(400);

        const self = await api().post('/staff-chat/messages').set(bearer(owner))
            .send({ threadKey: `dm:${ownerId}`, body: 'monologo' });
        expect(self.status).toBe(400);

        const ghost = await api().post('/staff-chat/messages').set(bearer(owner))
            .send({ threadKey: 'dm:999999', body: 'nessuno qui' });
        expect(ghost.status).toBe(404);
    });

    it('menzioni: valide sui membri del canale, rifiutate su chi non lo è, ignorate nei DM', async () => {
        // Il WAITER è membro di channel:sala: menzione valida, salvata sulla riga.
        const ok = await api().post('/staff-chat/messages').set(bearer(owner))
            .send({ threadKey: 'channel:sala', body: 'passa al 12 appena puoi', mentionedUserIds: [waiterId] });
        expect(ok.status).toBe(201);
        expect(ok.body.mentioned_user_ids).toEqual([waiterId]);

        // Il KITCHEN non può aprire channel:sala: menzionarlo lì è un errore.
        const nonMember = await api().post('/staff-chat/messages').set(bearer(owner))
            .send({ threadKey: 'channel:sala', body: 'chiedi in cucina', mentionedUserIds: [kitchenId] });
        expect(nonMember.status).toBe(400);

        // Nei DM le menzioni non esistono: il campo viene ignorato.
        const dm = await api().post('/staff-chat/messages').set(bearer(owner))
            .send({ threadKey: `dm:${waiterId}`, body: 'a te', mentionedUserIds: [kitchenId] });
        expect(dm.status).toBe(201);
        expect(dm.body.mentioned_user_ids).toBeNull();
    });

    it('preset: default, personalizzazione, invio con key db:, ripristino', async () => {
        // Senza righe a DB rispondono i default hardcoded.
        const def = await api().get('/staff-chat/presets').set(bearer(owner));
        expect(def.status).toBe(200);
        expect(def.body.custom).toBe(false);
        expect(def.body.presets.length).toBeGreaterThan(0);

        // La modifica richiede settings:full: il WAITER non passa.
        const denied = await api().put('/staff-chat/presets').set(bearer(waiterToken))
            .send({ labels: ['ciao'] });
        expect(denied.status).toBe(403);

        const saved = await api().put('/staff-chat/presets').set(bearer(owner))
            .send({ labels: ['manca il pane', 'arrivo tra due minuti'] });
        expect(saved.status).toBe(200);
        expect(saved.body.custom).toBe(true);
        expect(saved.body.presets.map((p: any) => p.label)).toEqual(['manca il pane', 'arrivo tra due minuti']);
        const key = saved.body.presets[0].key;
        expect(key).toMatch(/^db:\d+$/);

        // La key db: viene accettata e salvata sul messaggio.
        const sent = await api().post('/staff-chat/messages').set(bearer(owner))
            .send({ threadKey: 'channel:generale', body: 'manca il pane', presetKey: key });
        expect(sent.status).toBe(201);
        expect(sent.body.preset_key).toBe(key);

        // Lista vuota = tornano i default.
        const reset = await api().put('/staff-chat/presets').set(bearer(owner)).send({ labels: [] });
        expect(reset.status).toBe(200);
        expect(reset.body.custom).toBe(false);
    });

    it('la lista colleghi contiene gli utenti attivi del tenant, senza chi guarda', async () => {
        const threads = await api().get('/staff-chat/threads').set(bearer(owner));
        const ids = threads.body.colleagues.map((c: any) => c.id);
        expect(ids).toContain(kitchenId);
        expect(ids).toContain(waiterId);
        expect(ids).not.toContain(ownerId);
    });
});

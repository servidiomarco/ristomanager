import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Client } from 'pg';
import { io as ioClient, type Socket } from 'socket.io-client';
import { api, ownerToken, bearer } from './helpers';

// Chiamate allineate fra dispositivi: quando una chiamata cambia (segnata
// ricontattata, collegata, recuperata) il server manda 'voiceCall:changed'
// e gli altri dispositivi rileggono lista e badge. Prima il PC della
// reception, fermo sulla stessa schermata, teneva il numero vecchio.

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

const aspetta = (socket: Socket, evento: string, ms = 5_000): Promise<boolean> => new Promise(resolve => {
    const t = setTimeout(() => { socket.off(evento, ok); resolve(false); }, ms);
    const ok = () => { clearTimeout(t); socket.off(evento, ok); resolve(true); };
    socket.on(evento, ok);
});

describe('chiamate · allineate fra dispositivi', () => {
    let db: Client;
    let owner = '';
    let ownerId = 0;
    let altro: Socket;
    let callId = 0;
    const conv = 'test-sync-chiamate';

    beforeAll(async () => {
        db = new Client({ connectionString: process.env.DATABASE_URL || 'postgresql://localhost/ristotest_api' });
        await db.connect();
        owner = await ownerToken();
        const me = await api().post('/auth/login').send({
            email: process.env.TEST_OWNER_EMAIL, password: process.env.TEST_OWNER_PASSWORD,
        });
        ownerId = me.body.user.id;
        const ent = await api().put('/settings/entitlements').set(bearer(owner)).send({ voice: true });
        expect(ent.status).toBe(200);
        const call = await db.query(
            `INSERT INTO voice_calls (tenant_id, conversation_id, phone, duration_seconds, phantom_confirmation)
             VALUES (1, $1, '+393390000777', 12, TRUE) RETURNING id`,
            [conv]
        );
        callId = Number(call.rows[0].id);
        // «L'altro dispositivo»: stesso utente, un socket suo.
        altro = await connetti(owner);
    });

    afterAll(async () => {
        altro?.disconnect();
        await db.query(`DELETE FROM notifications WHERE tag LIKE $1`, [`%-${conv}`]);
        await db.query(`DELETE FROM voice_calls WHERE id = $1`, [callId]);
        await db.end();
    });

    it('segnata ricontattata su un dispositivo: l\'altro riceve il segnale', async () => {
        const arrivato = aspetta(altro, 'voiceCall:changed');
        const res = await api().patch(`/voice-calls/${callId}/follow-up`).set(bearer(owner)).send({ status: 'CONTACTED' });
        expect(res.status).toBe(200);
        expect(await arrivato).toBe(true);
    });

    it('recuperata a mano: si spegne «Prenotazione da recuperare» e arriva il segnale', async () => {
        const r = await db.query(
            `INSERT INTO notifications (tenant_id, recipient_user_id, category, title, body, tag)
             VALUES (1, $1, 'voice', 'Prenotazione da recuperare', 'x', $2) RETURNING id`,
            [ownerId, `voice-phantom-${conv}`]
        );
        const notifId = Number(r.rows[0].id);
        const arrivato = aspetta(altro, 'voiceCall:changed');
        const res = await api().patch(`/voice-calls/${callId}/recover`).set(bearer(owner)).send({});
        expect(res.status).toBe(200);
        expect(res.body.phantom_recovered).toBe(true);
        expect(res.body.conversation_id).toBeUndefined();
        expect(await arrivato).toBe(true);
        const letta = await db.query(`SELECT read_at FROM notifications WHERE id = $1`, [notifId]);
        expect(letta.rows[0].read_at).not.toBeNull();
    });
});

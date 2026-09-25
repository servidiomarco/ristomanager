import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Client } from 'pg';
import { io as ioClient, type Socket } from 'socket.io-client';
import { api, ownerToken, bearer } from './helpers';

// Presenza del palmare comande: chi apre un tavolo vede subito chi ci sta
// già lavorando, per NOME. Il nome si legge da users dentro un handler
// socket, cioè fuori da authenticate e quindi senza contesto tenant: col
// pool nudo, sotto la RLS rigida di produzione, la lettura dava zero righe e
// il palmare mostrava il prefisso dell'email. Il job «Test API (RLS rigida)»
// è quello che vede la differenza.

const PASSWORD = 'presenza-palmare-1';

const connetti = (token: string): Promise<Socket> => new Promise((resolve, reject) => {
    const socket = ioClient(process.env.TEST_BASE_URL as string, {
        transports: ['websocket', 'polling'],
        auth: { token },
        timeout: 10_000,
    });
    const t = setTimeout(() => reject(new Error('socket non connesso')), 10_000);
    socket.on('connect', () => { clearTimeout(t); resolve(socket); });
    socket.on('connect_error', (e) => { clearTimeout(t); reject(e); });
});

const entra = (socket: Socket, tableId: number): Promise<Array<{ name: string }>> =>
    new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error('ack di orderpad:enter mai arrivato')), 10_000);
        socket.emit('orderpad:enter', tableId, (others: Array<{ name: string }>) => { clearTimeout(t); resolve(others); });
    });

describe('presenza sul palmare comande', () => {
    let db: Client;
    let userId: number;
    const sockets: Socket[] = [];

    beforeAll(async () => {
        db = new Client({ connectionString: process.env.DATABASE_URL || 'postgresql://localhost/ristotest_api' });
        await db.connect();
        // Utente nuovo: il nome è in cache nel processo per userId, e un
        // utente già visto da un altro file di test falserebbe la prova.
        const owner = await ownerToken();
        const email = `presenza.palmare.${Date.now()}@test.local`;
        const created = await api().post('/auth/users').set(bearer(owner))
            .send({ email, password: PASSWORD, full_name: 'Giulia Presenza', role: 'WAITER' });
        expect(created.status).toBe(201);
        userId = created.body.id;
        const login = await api().post('/auth/login').send({ email, password: PASSWORD });
        expect(login.status).toBe(200);
        const token = login.body.accessToken as string;
        sockets.push(await connetti(token), await connetti(token));
    });

    afterAll(async () => {
        for (const s of sockets) s.disconnect();
        if (userId) await db.query('DELETE FROM users WHERE id = $1', [userId]);
        await db.end();
    });

    it('chi entra dopo vede il nome di chi c\'è già, non la sua email', async () => {
        const tavolo = 900_001;
        const primi = await entra(sockets[0], tavolo);
        expect(primi).toEqual([]);
        const altri = await entra(sockets[1], tavolo);
        expect(altri.map(o => o.name)).toEqual(['Giulia Presenza']);
    });
});

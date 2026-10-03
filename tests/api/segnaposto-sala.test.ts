import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Client } from 'pg';
import { io as ioClient, type Socket } from 'socket.io-client';
import { api, bearer, ownerToken } from './helpers';

// Segnaposto di sala (Sala dal vivo, PR1): ingresso, pass e accoglienza, uno
// per tipo in ogni sala, più l'interruttore sala_dal_vivo_enabled. Il flag
// decide solo la UI: il test dell'interruttore lo rispegne alla fine, e le
// route si provano tutte a flag spento, così una rotta che un giorno lo
// guardasse fallirebbe qui.
//
// I file condividono server e database IN SEQUENZA: il flag torna spento in
// afterAll, le sale create qui si cancellano (i file della voce e della
// disponibilità, dopo questo, leggono le sale) e il secondo tenant sparisce
// con tutto il suo. Deve passare anche con TEST_STRICT_RLS=1: il client pg
// diretto di questo file resta superuser, quindi seed e pulizia non
// dipendono dalla policy — le route sì.

const WAITER_EMAIL = 'cameriere.segnaposto@test.local';
const WAITER_PASSWORD = 'password-segnaposto-1';
const OTHER_TENANT_ID = 902;

// Un dispositivo: un socket autenticato come la app, nella stanza del suo
// ristorante appena connesso.
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

// Il prossimo payload di un evento, o null se non arriva in tempo.
const prossimo = (socket: Socket, evento: string, ms = 5_000): Promise<Record<string, unknown> | null> =>
    new Promise(resolve => {
        const t = setTimeout(() => { socket.off(evento, ok); resolve(null); }, ms);
        const ok = (payload: Record<string, unknown>) => { clearTimeout(t); socket.off(evento, ok); resolve(payload); };
        socket.on(evento, ok);
    });

describe('segnaposto di sala', () => {
    let owner = '';
    let db: Client;
    const roomIds: number[] = [];
    let roomId = 0;

    const createRoom = async (name: string): Promise<number> => {
        const res = await api().post('/rooms').set(bearer(owner)).send({ name, width: 800, height: 600 });
        expect(res.status).toBe(201);
        roomIds.push(res.body.id);
        return res.body.id as number;
    };

    const putMarker = (body: Record<string, unknown>, token = owner) =>
        api().put('/floor-markers').set(bearer(token)).send(body);

    const listMarkers = async (token = owner): Promise<any[]> => {
        const res = await api().get('/floor-markers').set(bearer(token));
        expect(res.status).toBe(200);
        expect(Array.isArray(res.body)).toBe(true);
        return res.body;
    };

    beforeAll(async () => {
        owner = await ownerToken();
        db = new Client({ connectionString: process.env.DATABASE_URL || 'postgresql://localhost/ristotest_api' });
        await db.connect();
        roomId = await createRoom('Sala Segnaposto');
    });

    afterAll(async () => {
        // Il default di fabbrica è «spento»: si rimette com'era.
        await api().put('/settings/features').set(bearer(owner)).send({ sala_dal_vivo_enabled: false });
        // I segnaposto se ne vanno in cascata con le sale.
        if (roomIds.length > 0) {
            await db.query('DELETE FROM rooms WHERE id = ANY($1::int[])', [roomIds]);
        }
        await db.query('DELETE FROM users WHERE email = $1', [WAITER_EMAIL]);
        await db.end();
    });

    it('richiede autenticazione', async () => {
        expect((await api().get('/floor-markers')).status).toBe(401);
        expect((await api().put('/floor-markers').send({ room_id: roomId, kind: 'ENTRANCE', x: 1, y: 1 })).status).toBe(401);
    });

    it("l'interruttore Sala dal vivo nasce spento e il titolare lo accende", async () => {
        const before = await api().get('/settings/features').set(bearer(owner));
        expect(before.status).toBe(200);
        expect(before.body.sala_dal_vivo_enabled).toBe(false);

        const on = await api().put('/settings/features').set(bearer(owner)).send({ sala_dal_vivo_enabled: true });
        expect(on.status).toBe(200);
        expect(on.body.sala_dal_vivo_enabled).toBe(true);

        const after = await api().get('/settings/features').set(bearer(owner));
        expect(after.body.sala_dal_vivo_enabled).toBe(true);

        // Sta nella allow-list del PUT generico: un valore non booleano è 400.
        const wrong = await api().put('/settings/features').set(bearer(owner)).send({ sala_dal_vivo_enabled: 'si' });
        expect(wrong.status).toBe(400);
        expect(wrong.body.error).toBe('invalid_value');

        // Di nuovo spento: i test qui sotto provano le route a flag spento.
        const off = await api().put('/settings/features').set(bearer(owner)).send({ sala_dal_vivo_enabled: false });
        expect(off.status).toBe(200);
        const spento = await api().get('/settings/features').set(bearer(owner));
        expect(spento.body.sala_dal_vivo_enabled).toBe(false);
    });

    it('il PUT è un upsert: stesso segnaposto, ultima posizione, arrotondata al px', async () => {
        const first = await putMarker({ room_id: roomId, kind: 'ENTRANCE', x: 100, y: 200 });
        expect(first.status).toBe(200);
        expect(first.body).toMatchObject({ room_id: roomId, kind: 'ENTRANCE', x: 100, y: 200 });
        expect(typeof first.body.id).toBe('number');
        expect(typeof first.body.updated_at).toBe('string');

        const second = await putMarker({ room_id: roomId, kind: 'ENTRANCE', x: 120.6, y: 240 });
        expect(second.status).toBe(200);
        expect(second.body.id).toBe(first.body.id);
        expect(second.body.x).toBe(121);
        expect(second.body.y).toBe(240);
        // updated_at avanza: è il criterio con cui un client scarta un'eco
        // più vecchia della copia che ha già.
        expect(new Date(second.body.updated_at).getTime()).toBeGreaterThanOrEqual(new Date(first.body.updated_at).getTime());

        const mine = (await listMarkers()).filter(m => m.room_id === roomId);
        expect(mine).toHaveLength(1);
        expect(mine[0]).toMatchObject({ id: first.body.id, kind: 'ENTRANCE', x: 121, y: 240 });
    });

    it('un segnaposto per tipo: il pass accanto all\'ingresso, ordinati per sala e tipo', async () => {
        const pass = await putMarker({ room_id: roomId, kind: 'PASS', x: 600, y: 40 });
        expect(pass.status).toBe(200);
        const mine = (await listMarkers()).filter(m => m.room_id === roomId);
        expect(mine.map(m => m.kind)).toEqual(['ENTRANCE', 'PASS']);
        expect(new Set(mine.map(m => m.id)).size).toBe(2);
    });

    it('rifiuta tipo, posizione e sala non validi', async () => {
        const base = { room_id: roomId, kind: 'HOST_STAND', x: 300, y: 300 };
        const casi: Array<[string, Record<string, unknown>]> = [
            ['tipo inventato', { ...base, kind: 'BAR' }],
            ['tipo mancante', { ...base, kind: undefined }],
            ['x negativa', { ...base, x: -1 }],
            ['x oltre la tela', { ...base, x: 20001 }],
            ['x non numerica', { ...base, x: 'abc' }],
            ['x come stringa numerica', { ...base, x: '120' }],
            ['y mancante', { ...base, y: undefined }],
            ['x infinita (null in JSON)', { ...base, x: Infinity }],
            ['sala non numerica', { ...base, room_id: 'x' }],
            ['sala zero', { ...base, room_id: 0 }],
            ['sala decimale', { ...base, room_id: 1.5 }],
        ];
        for (const [nome, body] of casi) {
            const res = await putMarker(body);
            expect(res.status, nome).toBe(400);
            expect(typeof res.body.error, nome).toBe('string');
        }

        // Ben formata ma inesistente: 404, e il segnaposto non nasce.
        const missing = await putMarker({ ...base, room_id: 2147483000 });
        expect(missing.status).toBe(404);
        expect(missing.body.error).toBe('Sala non trovata');
        const count = await db.query('SELECT COUNT(*)::int AS n FROM floor_markers WHERE room_id = $1', [2147483000]);
        expect(count.rows[0].n).toBe(0);
    });

    it('anche il database tiene il tetto delle coordinate', async () => {
        // Chi scrive senza passare dalla rotta (uno script, una correzione a
        // mano) trova lo stesso 0–20000. Dentro una transazione annullata:
        // se il vincolo mancasse, la riga non resterebbe ai test dopo.
        await db.query('BEGIN');
        try {
            for (const [x, y] of [[20001, 0], [0, 20001], [-1, 0]]) {
                await db.query('SAVEPOINT tetto');
                await expect(db.query(
                    `INSERT INTO floor_markers (tenant_id, room_id, kind, x, y) VALUES (1, $1, 'HOST_STAND', $2, $3)`,
                    [roomId, x, y]
                ), `${x},${y}`).rejects.toMatchObject({ code: '23514' });
                await db.query('ROLLBACK TO SAVEPOINT tetto');
            }
        } finally {
            await db.query('ROLLBACK');
        }
    });

    it('elimina un segnaposto e lo dice una volta sola', async () => {
        const created = await putMarker({ room_id: roomId, kind: 'HOST_STAND', x: 400, y: 500 });
        expect(created.status).toBe(200);

        const del = await api().delete(`/floor-markers/${created.body.id}`).set(bearer(owner));
        expect(del.status).toBe(200);
        // Solo id, sala e tipo: il nome della sala serve al registro, non esce.
        expect(del.body).toEqual({ id: created.body.id, room_id: roomId, kind: 'HOST_STAND' });

        const again = await api().delete(`/floor-markers/${created.body.id}`).set(bearer(owner));
        expect(again.status).toBe(404);

        for (const id of ['abc', '0', '1.5', '99999999999']) {
            const res = await api().delete(`/floor-markers/${id}`).set(bearer(owner));
            expect(res.status, id).toBe(404);
        }

        const mine = (await listMarkers()).filter(m => m.room_id === roomId);
        expect(mine.map(m => m.kind)).toEqual(['ENTRANCE', 'PASS']);
    });

    it('il registro attività chiama i segnaposto per nome, mai col codice', async () => {
        // Le righe dei test sopra: lo spostamento dell'ingresso e
        // l'eliminazione dell'accoglienza, col nome della sala.
        const attese: Array<[string, string]> = [
            ['UPDATE', 'Segnaposto ingresso · Sala Segnaposto'],
            ['DELETE', 'Segnaposto accoglienza · Sala Segnaposto'],
        ];
        // Il log è fire-and-forget: si aspetta che le righe arrivino.
        let righe: Array<{ action: string; resource_name: string; details: unknown }> = [];
        for (let i = 0; i < 40; i++) {
            const r = await db.query(
                `SELECT action, resource_name, details FROM activity_logs
                  WHERE tenant_id = 1 AND resource_type = 'ROOM' AND resource_id = $1 AND resource_name LIKE 'Segnaposto%'`,
                [roomId]
            );
            righe = r.rows;
            if (attese.every(([a, n]) => righe.some(x => x.action === a && x.resource_name === n))) break;
            await new Promise(resolve => setTimeout(resolve, 50));
        }
        for (const [a, n] of attese) {
            expect(righe.some(x => x.action === a && x.resource_name === n), `${a} ${n}`).toBe(true);
        }
        // Né nel nome né nei dettagli, che il registro mostra così come sono.
        expect(righe.filter(x => /ENTRANCE|PASS|HOST_STAND/.test(`${x.resource_name} ${JSON.stringify(x.details ?? null)}`))).toEqual([]);
    });

    it('un cameriere li legge ma non li sposta né li elimina', async () => {
        const created = await api().post('/auth/users').set(bearer(owner)).send({
            email: WAITER_EMAIL, password: WAITER_PASSWORD, full_name: 'Cameriere Segnaposto', role: 'WAITER',
        });
        expect(created.status).toBe(201);
        const login = await api().post('/auth/login').send({ email: WAITER_EMAIL, password: WAITER_PASSWORD });
        expect(login.status).toBe(200);
        const waiter = login.body.accessToken as string;

        const visibili = (await listMarkers(waiter)).filter(m => m.room_id === roomId);
        expect(visibili.length).toBeGreaterThan(0);

        const put = await putMarker({ room_id: roomId, kind: 'ENTRANCE', x: 0, y: 0 }, waiter);
        expect(put.status).toBe(403);

        const target = visibili[0];
        const del = await api().delete(`/floor-markers/${target.id}`).set(bearer(waiter));
        expect(del.status).toBe(403);

        // Niente è cambiato.
        const dopo = (await listMarkers()).find(m => m.id === target.id);
        expect(dopo).toMatchObject({ x: target.x, y: target.y });
    });

    describe('un altro ristorante', () => {
        let otherRoomId = 0;
        let otherMarkerId = 0;

        beforeAll(async () => {
            await db.query(
                `INSERT INTO tenants (id, slug, name) VALUES ($1, 'trattoria-segnaposto', 'Trattoria Segnaposto')
                 ON CONFLICT (id) DO NOTHING`,
                [OTHER_TENANT_ID]
            );
            await db.query(`SELECT setval(pg_get_serial_sequence('tenants','id'), (SELECT MAX(id) FROM tenants))`);
            const room = await db.query(
                `INSERT INTO rooms (tenant_id, name, width, height) VALUES ($1, 'Sala Altrui', 800, 600) RETURNING id`,
                [OTHER_TENANT_ID]
            );
            otherRoomId = room.rows[0].id;
            const marker = await db.query(
                `INSERT INTO floor_markers (tenant_id, room_id, kind, x, y) VALUES ($1, $2, 'ENTRANCE', 100, 100) RETURNING id`,
                [OTHER_TENANT_ID, otherRoomId]
            );
            otherMarkerId = marker.rows[0].id;
        });

        afterAll(async () => {
            await db.query('DELETE FROM floor_markers WHERE tenant_id = $1', [OTHER_TENANT_ID]);
            await db.query('DELETE FROM rooms WHERE tenant_id = $1', [OTHER_TENANT_ID]);
            await db.query('DELETE FROM role_permissions WHERE tenant_id = $1', [OTHER_TENANT_ID]);
            await db.query('DELETE FROM tenants WHERE id = $1', [OTHER_TENANT_ID]);
        });

        it('la sua sala è 404: l\'upsert non tocca il suo segnaposto', async () => {
            // Senza il controllo di proprietà, ON CONFLICT (room_id, kind)
            // sposterebbe l'ingresso dell'altro ristorante.
            const res = await putMarker({ room_id: otherRoomId, kind: 'ENTRANCE', x: 7, y: 7 });
            expect(res.status).toBe(404);
            const row = await db.query('SELECT tenant_id, x, y FROM floor_markers WHERE id = $1', [otherMarkerId]);
            expect(row.rows[0]).toMatchObject({ x: 100, y: 100 });
            expect(Number(row.rows[0].tenant_id)).toBe(OTHER_TENANT_ID);
        });

        it('il suo segnaposto non si elimina e non si vede', async () => {
            const del = await api().delete(`/floor-markers/${otherMarkerId}`).set(bearer(owner));
            expect(del.status).toBe(404);
            const still = await db.query('SELECT COUNT(*)::int AS n FROM floor_markers WHERE id = $1', [otherMarkerId]);
            expect(still.rows[0].n).toBe(1);

            const all = await listMarkers();
            expect(all.some(m => m.id === otherMarkerId || m.room_id === otherRoomId)).toBe(false);
        });
    });

    it('eliminare la sala elimina i suoi segnaposto', async () => {
        const doomed = await createRoom('Sala Segnaposto Effimera');
        expect((await putMarker({ room_id: doomed, kind: 'ENTRANCE', x: 20, y: 20 })).status).toBe(200);
        expect((await putMarker({ room_id: doomed, kind: 'PASS', x: 40, y: 40 })).status).toBe(200);

        const del = await api().delete(`/rooms/${doomed}`).set(bearer(owner));
        expect(del.status).toBe(204);

        const count = await db.query('SELECT COUNT(*)::int AS n FROM floor_markers WHERE room_id = $1', [doomed]);
        expect(count.rows[0].n).toBe(0);
        const listed = await listMarkers();
        expect(listed.some(m => m.room_id === doomed)).toBe(false);
    });

    describe('in tempo reale', () => {
        // Due dispositivi dello stesso ristorante: A sposta, B guarda.
        let a: Socket;
        let b: Socket;

        beforeAll(async () => {
            a = await connetti(owner);
            b = await connetti(owner);
        });

        afterAll(() => {
            a?.disconnect();
            b?.disconnect();
        });

        it('lo spostamento arriva a tutto il ristorante con la riga della risposta, niente di più', async () => {
            // Senza X-Socket-ID nessuno è escluso: arriva anche ad A, e il
            // silenzio di A nel test dopo vuol dire davvero «escluso».
            const versoA = prossimo(a, 'floorMarker:updated');
            const versoB = prossimo(b, 'floorMarker:updated');
            const res = await putMarker({ room_id: roomId, kind: 'HOST_STAND', x: 260, y: 180 });
            expect(res.status).toBe(200);
            const [suA, suB] = await Promise.all([versoA, versoB]);
            expect(suA).toEqual(res.body);
            expect(suB).toEqual(res.body);
            // Solo i campi del contratto: un RETURNING * ci metterebbe
            // tenant_id e created_at, che fuori dal server non servono.
            expect(Object.keys(suB ?? {}).sort()).toEqual(['id', 'kind', 'room_id', 'updated_at', 'x', 'y']);
        });

        it('chi sposta o elimina non riceve la propria eco', async () => {
            const daA: string[] = [];
            const suA = (evento: string) => () => { daA.push(evento); };
            const updatedSuA = suA('floorMarker:updated');
            const deletedSuA = suA('floorMarker:deleted');
            a.on('floorMarker:updated', updatedSuA);
            a.on('floorMarker:deleted', deletedSuA);
            try {
                const spostato = prossimo(b, 'floorMarker:updated');
                const put = await api().put('/floor-markers').set(bearer(owner)).set('X-Socket-ID', a.id as string)
                    .send({ room_id: roomId, kind: 'HOST_STAND', x: 280, y: 200 });
                expect(put.status).toBe(200);
                expect(await spostato).toEqual(put.body);

                const tolto = prossimo(b, 'floorMarker:deleted');
                const del = await api().delete(`/floor-markers/${put.body.id}`).set(bearer(owner)).set('X-Socket-ID', a.id as string);
                expect(del.status).toBe(200);
                // Id, sala e tipo, esattamente: il nome della sala serve solo
                // al registro attività.
                expect(await tolto).toEqual({ id: put.body.id, room_id: roomId, kind: 'HOST_STAND' });

                // B li ha avuti tutti e due; ad A, partiti nello stesso
                // istante, non arriva niente nemmeno dopo.
                await new Promise(resolve => setTimeout(resolve, 300));
                expect(daA).toEqual([]);
            } finally {
                a.off('floorMarker:updated', updatedSuA);
                a.off('floorMarker:deleted', deletedSuA);
            }
        });
    });
});

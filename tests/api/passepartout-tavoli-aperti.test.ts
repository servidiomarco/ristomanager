import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Client } from 'pg';
import { io as ioClient, type Socket } from 'socket.io-client';
import { api, bearer, ownerToken } from './helpers';

// Tavoli aperti nella cassa Passepartout: un walk-in aperto in cassa occupa
// il tavolo anche per il CRM. La sala li riceve, la disponibilità automatica
// (qui: le sale proposte da /prenota) li esclude finché non si liberano, e
// a interruttore spento o comanda chiusa tutto torna com'era.

const AGENT_TOKEN = 'test-pp-agent-token';
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const oggi = () => new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Rome' }).format(new Date());
const oraRoma = (msFa: number) => {
    const d = new Date(Date.now() - msFa);
    const ora = new Intl.DateTimeFormat('it-IT', { timeZone: 'Europe/Rome', hour: '2-digit', minute: '2-digit', hour12: false }).format(d);
    return `${new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Rome' }).format(d)}T${ora}:00`;
};

describe('tavoli aperti in cassa Passepartout', () => {
    let token: string;
    let db: Client;
    let socket: Socket | null = null;
    let roomId: number;
    let tableId: number;
    let aperte: any[] = [];

    const finoA = async (cond: () => Promise<boolean>, descr: string, timeoutMs = 8_000) => {
        const deadline = Date.now() + timeoutMs;
        for (;;) {
            if (await cond()) return;
            if (Date.now() > deadline) throw new Error(`Timeout: ${descr}`);
            await sleep(150);
        }
    };
    // Un tavolo da 20 in una sala tutta sua: con 19 ospiti è l'unico che va.
    const salaProposta = async () => {
        const r = await api().get(`/public/rooms?date=${oggi()}&shift=DINNER&guests=19`);
        expect(r.status).toBe(200);
        return r.body.rooms.some((x: any) => x.id === roomId);
    };

    beforeAll(async () => {
        token = await ownerToken();
        db = new Client({ connectionString: process.env.DATABASE_URL || 'postgresql://localhost/ristotest_api' });
        await db.connect();
        await api().put('/settings/entitlements').set(bearer(token)).send({ passepartout: true });
        const room = await api().post('/rooms').set(bearer(token)).send({ name: 'Sala Aperti PP', width: 600, height: 400 });
        roomId = room.body.id;
        const table = await api().post('/tables').set(bearer(token)).send({
            name: 'PPA1', shape: 'SQUARE', seats: 20, x: 40, y: 40, room_id: roomId, status: 'FREE',
        });
        tableId = table.body.id;
        await db.query(
            `INSERT INTO passepartout_tavoli (table_id, tenant_id, pp_sala, pp_tavolo, origine, confermato) VALUES ($1, 1, 'FIUME', 'PPA1', 'manuale', true)`,
            [tableId]
        );

        socket = ioClient(`${process.env.TEST_BASE_URL}/pp-agent`, {
            auth: { token: AGENT_TOKEN }, transports: ['websocket'], reconnection: false,
        });
        socket.on('pp:call', (payload: any, ack: (r: unknown) => void) => {
            if (payload?.op === 'comandeAperte') return ack({ ok: true, result: aperte });
            ack({ ok: false, error: `op non prevista: ${payload?.op}`, kind: 'agent' });
        });
        await new Promise<void>((resolve, reject) => {
            socket!.on('connect', () => resolve());
            socket!.on('connect_error', reject);
        });
        socket.emit('agent:hello', { hostname: 'agente-aperti', capabilities: ['tavoli-aperti'] });
        await finoA(async () => ((await api().get('/passepartout/status').set(bearer(token))).body.capabilities ?? []).includes('tavoli-aperti'),
            'agente annunciato');
    });

    afterAll(async () => {
        await api().put('/passepartout/tavoli-aperti/config').set(bearer(token)).send({ enabled: false, disponibilita: true });
        socket?.close();
        await db.query(`DELETE FROM passepartout_tavoli_aperti WHERE tenant_id = 1`);
        await db.query(`DELETE FROM passepartout_tavoli WHERE table_id = $1`, [tableId]);
        await db.end();
    });

    it('acceso: il tavolo aperto in cassa arriva alla sala, con coperti e totale', async () => {
        expect((await api().post('/passepartout/tavoli-aperti/aggiorna').set(bearer(token))).status).toBe(409);
        await api().put('/passepartout/tavoli-aperti/config').set(bearer(token)).send({ enabled: true });

        aperte = [
            { idComanda: 7701, tavolo: 'PPA1', sala: 'FIUME', coperti: 3, idPrenotazione: null, aperta: oraRoma(10 * 60_000), totale: 45.5 },
            // Tavolo della cassa non abbinato a nessun tavolo del CRM: ignorato.
            { idComanda: 7702, tavolo: 'NON-ABBINATO', sala: 'FIUME', coperti: 2, idPrenotazione: null, aperta: oraRoma(0), totale: 10 },
        ];
        const r = await api().post('/passepartout/tavoli-aperti/aggiorna').set(bearer(token));
        expect(r.status).toBe(200);
        expect(r.body.tavoli).toHaveLength(1);
        expect(r.body.tavoli[0]).toMatchObject({ table_id: tableId, coperti: 3, totale_cents: 4550 });
        // Si libera non prima di adesso + 20 minuti.
        expect(Date.parse(r.body.tavoli[0].libero_previsto_at)).toBeGreaterThan(Date.now() + 19 * 60_000);

        const sala = await api().get('/passepartout/tavoli-aperti').set(bearer(token));
        expect(sala.body.tavoli.map((t: any) => t.table_id)).toEqual([tableId]);
        const cfg = await api().get('/passepartout/tavoli-aperti/config').set(bearer(token));
        expect(cfg.body).toMatchObject({ enabled: true, disponibilita: true, aperti: 1, agente: { collegato: true, aggiornato: true } });
    });

    it('li vede anche chi ha solo Comande: la griglia dei tavoli li mostra', async () => {
        const email = `solo-comande-${Date.now()}@example.test`;
        const password = `Prova-${Date.now()}!`;
        const prima: string[] = (await api().get('/auth/permissions/roles/WAITER').set(bearer(token))).body.permissions;
        try {
            const ridotti = prima.filter((p) => p !== 'reservations:view' && p !== 'floorplan:update_status');
            expect((await api().put('/auth/permissions/roles/WAITER').set(bearer(token)).send({ permissions: ridotti })).status).toBe(200);
            const creato = await api().post('/auth/users').set(bearer(token)).send({ email, password, full_name: 'Solo Comande', role: 'WAITER' });
            expect(creato.status).toBe(201);
            const login = await api().post('/auth/login').send({ email, password });
            expect(login.status).toBe(200);
            const sala = await api().get('/passepartout/tavoli-aperti').set(bearer(login.body.accessToken));
            expect(sala.status).toBe(200);
            expect(sala.body.tavoli.map((t: any) => t.table_id)).toEqual([tableId]);
        } finally {
            await api().put('/auth/permissions/roles/WAITER').set(bearer(token)).send({ permissions: prima });
            await db.query(`DELETE FROM users WHERE email = $1`, [email]);
        }
    });

    it('la disponibilità automatica non propone il tavolo finché è aperto, e lo riprende spenta la regola', async () => {
        // L'esito non deve dipendere dall'ora del test: si libera a fine serata.
        await db.query(
            `UPDATE passepartout_tavoli_aperti SET libero_previsto_at = ($1::date + time '23:59') AT TIME ZONE 'Europe/Rome'
              WHERE tenant_id = 1 AND table_id = $2`,
            [oggi(), tableId]
        );
        expect(await salaProposta()).toBe(false);

        await api().put('/passepartout/tavoli-aperti/config').set(bearer(token)).send({ disponibilita: false });
        expect(await salaProposta()).toBe(true);
        await api().put('/passepartout/tavoli-aperti/config').set(bearer(token)).send({ disponibilita: true });
        expect(await salaProposta()).toBe(false);

        // Un tavolo aperto a pranzo che si libera alle 15:30 non tocca la cena.
        await db.query(
            `UPDATE passepartout_tavoli_aperti SET libero_previsto_at = ($1::date + time '15:30') AT TIME ZONE 'Europe/Rome'
              WHERE tenant_id = 1 AND table_id = $2`,
            [oggi(), tableId]
        );
        expect(await salaProposta()).toBe(true);
    });

    it('chiusa in cassa sparisce; spento, la sala non vede niente', async () => {
        aperte = [];
        const r = await api().post('/passepartout/tavoli-aperti/aggiorna').set(bearer(token));
        expect(r.body.tavoli).toEqual([]);
        expect(await salaProposta()).toBe(true);

        aperte = [{ idComanda: 7703, tavolo: 'PPA1', sala: 'FIUME', coperti: 2, idPrenotazione: null, aperta: oraRoma(0), totale: 0 }];
        await api().post('/passepartout/tavoli-aperti/aggiorna').set(bearer(token));
        await api().put('/passepartout/tavoli-aperti/config').set(bearer(token)).send({ enabled: false });
        expect((await api().get('/passepartout/tavoli-aperti').set(bearer(token))).body.tavoli).toEqual([]);
        expect(await salaProposta()).toBe(true);
    });
});

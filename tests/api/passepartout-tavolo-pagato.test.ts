import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Client } from 'pg';
import { io as ioClient, type Socket } from 'socket.io-client';
import { api, bearer, ownerToken } from './helpers';

// «Il tavolo X ha pagato» dalla cassa Passepartout: una comanda sparisce
// dalla lettura dei tavoli aperti e, riletta, risulta pagata. Titolare, GM,
// manager e reception ricevono 'passepartout:tavolo-pagato' con la
// prenotazione seduta da liberare; i camerieri no. Una comanda annullata,
// un walk-in senza prenotazione o l'interruttore spento: niente avviso.

const AGENT_TOKEN = 'test-pp-agent-token';
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const EVENTO = 'passepartout:tavolo-pagato';

const connetti = (token: string): Promise<Socket> => new Promise((resolve, reject) => {
    const socket = ioClient(process.env.TEST_BASE_URL as string, { transports: ['websocket', 'polling'], auth: { token }, timeout: 10_000 });
    const fallisci = (e: Error) => { clearTimeout(t); socket.close(); reject(e); };
    const t = setTimeout(() => fallisci(new Error('socket non connesso')), 10_000);
    socket.on('connect', () => { clearTimeout(t); resolve(socket); });
    socket.on('connect_error', fallisci);
});

describe('avviso «il tavolo ha pagato» dalla cassa', () => {
    let token: string;
    let db: Client;
    let agente: Socket | null = null;
    let titolare: Socket | null = null;
    let cameriere: Socket | null = null;
    const cameriereEmail = `cameriere-pagato-${Date.now()}@example.test`;
    let tableId: number;
    let tavoloSenzaPrenotazione: number;
    let aperte: any[] = [];
    const comande = new Map<number, any>();
    const ricevuti: any[] = [];
    const ricevutiCameriere: any[] = [];

    const finoA = async (cond: () => Promise<boolean> | boolean, descr: string, timeoutMs = 8_000) => {
        const deadline = Date.now() + timeoutMs;
        for (;;) {
            if (await cond()) return;
            if (Date.now() > deadline) throw new Error(`Timeout: ${descr}`);
            await sleep(100);
        }
    };
    const aggiorna = async () => expect((await api().post('/passepartout/tavoli-aperti/aggiorna').set(bearer(token))).status).toBe(200);
    const comanda = (idComanda: number, tavolo: string, totale: number) =>
        ({ idComanda, tavolo, sala: 'GIARDINO', coperti: 2, idPrenotazione: null, aperta: null, totale });

    beforeAll(async () => {
        token = await ownerToken();
        db = new Client({ connectionString: process.env.DATABASE_URL || 'postgresql://localhost/ristotest_api' });
        await db.connect();
        await api().put('/settings/entitlements').set(bearer(token)).send({ passepartout: true });
        const room = await api().post('/rooms').set(bearer(token)).send({ name: 'Sala Pagato PP', width: 600, height: 400 });
        const crea = async (name: string) => (await api().post('/tables').set(bearer(token)).send({
            name, shape: 'SQUARE', seats: 4, x: 40, y: 40, room_id: room.body.id, status: 'FREE',
        })).body.id as number;
        tableId = await crea('PAG1');
        tavoloSenzaPrenotazione = await crea('PAG2');
        for (const [id, nome] of [[tableId, 'PAG1'], [tavoloSenzaPrenotazione, 'PAG2']] as const) {
            await db.query(
                `INSERT INTO passepartout_tavoli (table_id, tenant_id, pp_sala, pp_tavolo, origine, confermato) VALUES ($1, 1, 'GIARDINO', $2, 'manuale', true)`,
                [id, nome]
            );
        }

        agente = ioClient(`${process.env.TEST_BASE_URL}/pp-agent`, { auth: { token: AGENT_TOKEN }, transports: ['websocket'], reconnection: false });
        agente.on('pp:call', (payload: any, ack: (r: unknown) => void) => {
            if (payload?.op === 'comandeAperte') return ack({ ok: true, result: aperte });
            if (payload?.op === 'comanda') return ack({ ok: true, result: comande.get(Number(payload?.params?.idGestionale)) ?? null });
            ack({ ok: false, error: `op non prevista: ${payload?.op}`, kind: 'agent' });
        });
        await new Promise<void>((resolve, reject) => { agente!.on('connect', () => resolve()); agente!.on('connect_error', reject); });
        agente.emit('agent:hello', { hostname: 'agente-pagato', capabilities: ['tavoli-aperti'] });
        await finoA(async () => ((await api().get('/passepartout/status').set(bearer(token))).body.capabilities ?? []).includes('tavoli-aperti'),
            'agente annunciato');
        await api().put('/passepartout/tavoli-aperti/config').set(bearer(token)).send({ enabled: true });

        titolare = await connetti(token);
        titolare.on(EVENTO, (p: any) => ricevuti.push(p));
        const password = `Prova-${Date.now()}!`;
        expect((await api().post('/auth/users').set(bearer(token)).send({ email: cameriereEmail, password, full_name: 'Cameriere Pagato', role: 'WAITER' })).status).toBe(201);
        const login = await api().post('/auth/login').send({ email: cameriereEmail, password });
        cameriere = await connetti(login.body.accessToken);
        cameriere.on(EVENTO, (p: any) => ricevutiCameriere.push(p));
    });

    afterAll(async () => {
        await api().put('/passepartout/tavoli-aperti/config').set(bearer(token)).send({ enabled: false, avvisoPagato: true });
        agente?.close();
        titolare?.close();
        cameriere?.close();
        await db.query(`DELETE FROM passepartout_tavoli_aperti WHERE tenant_id = 1`);
        await db.query(`DELETE FROM passepartout_tavoli WHERE table_id = ANY($1::int[])`, [[tableId, tavoloSenzaPrenotazione]]);
        await db.query(`DELETE FROM users WHERE email = $1`, [cameriereEmail]);
        await db.end();
    });

    it("di serie è acceso, e l'interruttore si legge e si salva", async () => {
        expect((await api().get('/passepartout/tavoli-aperti/config').set(bearer(token))).body.avvisoPagato).toBe(true);
    });

    it('comanda pagata sul tavolo di una prenotazione seduta: arriva a chi gestisce la sala, non ai camerieri', async () => {
        const res = await api().post('/reservations').set(bearer(token)).send({
            customer_name: 'Rossi Pagato', reservation_time: new Date(Date.now() - 60 * 60_000).toISOString(),
            shift: 'DINNER', guests: 2, table_id: tableId,
        });
        expect(res.status).toBe(201);
        await db.query(`UPDATE reservations SET arrival_status = 'ARRIVED' WHERE id = $1`, [res.body.id]);

        aperte = [comanda(8801, 'PAG1', 58.4), comanda(8802, 'PAG2', 12)];
        await aggiorna();
        // Pagate tutte e due; sul secondo tavolo c'era un walk-in senza prenotazione.
        comande.set(8801, { idGestionale: 8801, isPagato: true, idPrenotazione: null, righe: [] });
        comande.set(8802, { idGestionale: 8802, isPagato: true, idPrenotazione: null, righe: [] });
        aperte = [];
        await aggiorna();

        await finoA(() => ricevuti.length > 0, 'avviso al titolare');
        await sleep(500);
        expect(ricevuti).toHaveLength(1);
        expect(ricevuti[0]).toMatchObject({
            pp_comanda_id: 8801, reservation_id: res.body.id, table_id: tableId, tavolo: 'PAG1',
            customer_name: 'Rossi Pagato', coperti: 2, totale_cents: 5840,
        });
        expect(ricevutiCameriere).toEqual([]);
    });

    it('comanda annullata in cassa, o prenotazione già liberata: niente avviso', async () => {
        const res = await api().post('/reservations').set(bearer(token)).send({
            customer_name: 'Bianchi Annullato', reservation_time: new Date(Date.now() - 30 * 60_000).toISOString(),
            shift: 'DINNER', guests: 2, table_id: tavoloSenzaPrenotazione,
        });
        await db.query(`UPDATE reservations SET arrival_status = 'ARRIVED' WHERE id = $1`, [res.body.id]);
        ricevuti.length = 0;

        aperte = [comanda(8803, 'PAG2', 20), comanda(8804, 'PAG1', 30)];
        await aggiorna();
        comande.set(8803, { idGestionale: 8803, isPagato: false, idPrenotazione: null, righe: [] });
        // Sul primo tavolo la prenotazione intanto è stata liberata.
        await db.query(`UPDATE reservations SET arrival_status = 'DEPARTED' WHERE table_id = $1 AND tenant_id = 1`, [tableId]);
        comande.set(8804, { idGestionale: 8804, isPagato: true, idPrenotazione: null, righe: [] });
        aperte = [];
        await aggiorna();
        await sleep(1_000);
        expect(ricevuti).toEqual([]);
    });

    it("spento l'interruttore, la comanda pagata non avvisa", async () => {
        expect((await api().put('/passepartout/tavoli-aperti/config').set(bearer(token)).send({ avvisoPagato: false })).status).toBe(200);
        expect((await api().get('/passepartout/tavoli-aperti/config').set(bearer(token))).body.avvisoPagato).toBe(false);
        await db.query(`UPDATE reservations SET arrival_status = 'ARRIVED' WHERE table_id = $1 AND tenant_id = 1`, [tavoloSenzaPrenotazione]);
        ricevuti.length = 0;

        aperte = [comanda(8805, 'PAG2', 25)];
        await aggiorna();
        comande.set(8805, { idGestionale: 8805, isPagato: true, idPrenotazione: null, righe: [] });
        aperte = [];
        await aggiorna();
        await sleep(1_000);
        expect(ricevuti).toEqual([]);
    });
});

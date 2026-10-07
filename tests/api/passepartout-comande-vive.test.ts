import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Client } from 'pg';
import { io as ioClient, type Socket } from 'socket.io-client';
import { api, bearer, ownerToken } from './helpers';

// Comande del CRM in cassa («comanda viva», fase 1): le impostazioni.
// L'interruttore si accende solo con le comande accese, i tavoli abbinati,
// il tipo di pagamento in cassa e un agente che annuncia 'comanda-viva'; le
// due scelte (chi stampa in cucina, chi fa il conto) si salvano sempre, e
// spegnere si può anche con l'agente giù.

const AGENT_TOKEN = 'test-pp-agent-token';
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

describe('comande del CRM in cassa: impostazioni', () => {
    let token: string;
    let db: Client;
    let socket: Socket | null = null;
    let tableId: number;
    let comandePrima = false;

    const finoA = async (cond: () => Promise<boolean>, descr: string, timeoutMs = 8_000) => {
        const deadline = Date.now() + timeoutMs;
        for (;;) {
            if (await cond()) return;
            if (Date.now() > deadline) throw new Error(`Timeout: ${descr}`);
            await sleep(150);
        }
    };
    const config = async () => (await api().get('/passepartout/comande-vive/config').set(bearer(token))).body;
    const salva = (body: Record<string, unknown>) => api().put('/passepartout/comande-vive/config').set(bearer(token)).send(body);
    const capacita = async () => (await api().get('/passepartout/status').set(bearer(token))).body.capabilities ?? [];

    beforeAll(async () => {
        token = await ownerToken();
        db = new Client({ connectionString: process.env.DATABASE_URL || 'postgresql://localhost/ristotest_api' });
        await db.connect();
        await api().put('/settings/entitlements').set(bearer(token)).send({ passepartout: true });
        comandePrima = (await api().get('/settings/features').set(bearer(token))).body.table_orders_enabled === true;
        await api().put('/settings/features').set(bearer(token)).send({ table_orders_enabled: false });

        const room = await api().post('/rooms').set(bearer(token)).send({ name: 'Sala Comanda Viva', width: 600, height: 400 });
        const table = await api().post('/tables').set(bearer(token)).send({
            name: 'PPV1', shape: 'SQUARE', seats: 4, x: 40, y: 40, room_id: room.body.id, status: 'FREE',
        });
        tableId = table.body.id;
    });

    afterAll(async () => {
        await salva({ enabled: false, stampa: 'cassa', conto: 'cassa' });
        await api().put('/settings/features').set(bearer(token)).send({ table_orders_enabled: comandePrima });
        socket?.close();
        await db.query(`DELETE FROM passepartout_tavoli WHERE tenant_id = 1 AND table_id = $1`, [tableId]);
        await db.end();
    });

    it('di default è spenta, e stampa e conto li fa la cassa', async () => {
        expect(await config()).toMatchObject({
            enabled: false, stampa: 'cassa', conto: 'cassa',
            requisiti: { comande: false, tipo_pagamento: 'ESTERNO' },
            agente: { aggiornato: false },
        });
    });

    it('le due scelte si salvano sempre; i valori sbagliati no', async () => {
        expect((await salva({ stampa: 'crm', conto: 'crm' })).status).toBe(200);
        expect(await config()).toMatchObject({ enabled: false, stampa: 'crm', conto: 'crm' });
        expect((await salva({ stampa: 'tutti' })).status).toBe(400);
        expect((await salva({ conto: '' })).status).toBe(400);
        expect((await salva({ enabled: 'si' })).status).toBe(400);
        expect((await salva({ stampa: 'cassa' })).status).toBe(200);
        expect(await config()).toMatchObject({ stampa: 'cassa', conto: 'crm' });
    });

    it('si accende solo con comande, tavoli abbinati e un agente che sa scrivere le comande', async () => {
        const senzaComande = await salva({ enabled: true });
        expect(senzaComande.status).toBe(409);
        expect(senzaComande.body.error).toBe('comande_spente');

        await api().put('/settings/features').set(bearer(token)).send({ table_orders_enabled: true });
        const abbinati = (await db.query(
            `SELECT COUNT(*)::int AS n FROM passepartout_tavoli WHERE tenant_id = 1 AND confermato`
        )).rows[0].n;
        if (abbinati === 0) {
            const senzaTavoli = await salva({ enabled: true });
            expect(senzaTavoli.status).toBe(409);
            expect(senzaTavoli.body.error).toBe('tavoli_mancanti');
        }
        await db.query(
            `INSERT INTO passepartout_tavoli (table_id, tenant_id, pp_sala, pp_tavolo, origine, confermato)
             VALUES ($1, 1, 'TETTOIA', 'PPV1', 'manuale', true)`,
            [tableId]
        );

        // Un agente di prima, che non sa scrivere le comande.
        const vecchio = await salva({ enabled: true });
        expect(vecchio.status).toBe(409);
        expect(vecchio.body.error).toBe('agente_da_aggiornare');

        socket = ioClient(`${process.env.TEST_BASE_URL}/pp-agent`, {
            auth: { token: AGENT_TOKEN }, transports: ['websocket'], reconnection: false,
        });
        socket.on('pp:call', (_payload: any, ack: (r: unknown) => void) => ack({ ok: false, error: 'op non prevista', kind: 'agent' }));
        await new Promise<void>((resolve, reject) => {
            socket!.on('connect', () => resolve());
            socket!.on('connect_error', reject);
        });
        socket.emit('agent:hello', { hostname: 'agente-comanda-viva', capabilities: ['comanda-viva'] });
        await finoA(async () => (await capacita()).includes('comanda-viva'), 'agente annunciato');

        expect((await salva({ enabled: true })).status).toBe(200);
        expect(await config()).toMatchObject({
            enabled: true, stampa: 'cassa', conto: 'crm',
            requisiti: { comande: true, tipo_pagamento: 'ESTERNO' },
            agente: { collegato: true, aggiornato: true },
        });
        expect((await config()).requisiti.tavoli_abbinati).toBeGreaterThanOrEqual(1);
    });

    it('si spegne anche con l\'agente giù', async () => {
        socket?.close();
        socket = null;
        await finoA(async () => !(await capacita()).includes('comanda-viva'), 'agente scollegato');
        expect((await salva({ enabled: false })).status).toBe(200);
        expect(await config()).toMatchObject({ enabled: false, agente: { collegato: false } });
    });
});

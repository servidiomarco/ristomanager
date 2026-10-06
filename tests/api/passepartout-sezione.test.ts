import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Client } from 'pg';
import { io as ioClient, type Socket } from 'socket.io-client';
import { api, bearer, ownerToken } from './helpers';

// Passepartout per ristorante: ogni ristorante con la cassa ha il suo agente
// (token a DB, quello storico in env vale per il ristorante 1) e la sua
// configurazione di chiusura nella sezione Impostazioni → Passepartout.
// Prima un secondo agente qualunque scalzava l'unico collegato: con due
// ristoranti sullo stesso server sarebbe stato il disastro.

const TOKEN_STORICO = 'test-pp-agent-token';
const TOKEN_ALTRO = 'tokenristorante77abcdef0123456789';
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

describe('sezione Passepartout e agente per ristorante', () => {
    let token: string;
    let db: Client;
    const aperti: Socket[] = [];

    const finoA = async (cond: () => Promise<boolean>, descr: string, timeoutMs = 8_000) => {
        const deadline = Date.now() + timeoutMs;
        for (;;) {
            if (await cond()) return;
            if (Date.now() > deadline) throw new Error(`Timeout: ${descr}`);
            await sleep(150);
        }
    };

    /** Un agente finto: registra le chiamate e risponde ai tipi di pagamento. */
    const agente = async (tokenAgente: string, hostname: string) => {
        const calls: string[] = [];
        const socket = ioClient(`${process.env.TEST_BASE_URL}/pp-agent`, {
            auth: { token: tokenAgente }, transports: ['websocket'], reconnection: false,
        });
        aperti.push(socket);
        socket.on('pp:call', (payload: any, ack: (r: unknown) => void) => {
            calls.push(payload?.op);
            if (payload?.op === 'tipiPagamento') {
                return ack({ ok: true, result: [{ codice: `CONTANTI-${hostname}`, categoria: 'Contanti' }, { codice: 'ESTERNO', categoria: 'Varie1' }] });
            }
            ack({ ok: false, error: 'op non prevista', kind: 'agent' });
        });
        await new Promise<void>((resolve, reject) => {
            socket.on('connect', () => resolve());
            socket.on('connect_error', reject);
        });
        socket.emit('agent:hello', { hostname, versioneGestionale: '2026C1', capabilities: ['chiudi-riprendi'] });
        return { socket, calls };
    };

    beforeAll(async () => {
        token = await ownerToken();
        db = new Client({ connectionString: process.env.DATABASE_URL || 'postgresql://localhost/ristotest_api' });
        await db.connect();
        await api().put('/settings/entitlements').set(bearer(token)).send({ passepartout: true });
        await db.query(`INSERT INTO tenants (id, slug, name) VALUES (77, 'trattoria-cassa-77', 'Trattoria Cassa')
                        ON CONFLICT (id) DO NOTHING`);
        await db.query(`SELECT setval(pg_get_serial_sequence('tenants','id'), (SELECT MAX(id) FROM tenants))`);
        await db.query(`UPDATE tenants SET passepartout_agent_token = $1 WHERE id = 77`, [TOKEN_ALTRO]);
    });

    afterAll(async () => {
        for (const s of aperti) s.close();
        await api().put('/passepartout/config').set(bearer(token)).send({ tipo_pagamento_esterno: null, tipo_documento: null });
        await db.query(`DELETE FROM role_permissions WHERE tenant_id = 77`);
        await db.query(`DELETE FROM tenants WHERE id = 77`);
        await db.end();
    });

    it('ogni ristorante ha un token suo, generato dalla migrazione', async () => {
        const r = await db.query(`SELECT COUNT(*) FILTER (WHERE passepartout_agent_token IS NULL)::int AS senza FROM tenants`);
        expect(r.rows[0].senza).toBe(0);
    });

    it("l'agente di un altro ristorante non scalza quello del ristorante 1, e le chiamate vanno al proprio", async () => {
        const frantoio = await agente(TOKEN_STORICO, 'PC-FRANTOIO');
        await finoA(async () => (await api().get('/passepartout/status').set(bearer(token))).body.hostname === 'PC-FRANTOIO',
            'agente del ristorante 1 annunciato');

        const altro = await agente(TOKEN_ALTRO, 'PC-TRATTORIA');
        await sleep(400);
        const st = await api().get('/passepartout/status').set(bearer(token));
        expect(st.body).toMatchObject({ connected: true, hostname: 'PC-FRANTOIO' });
        expect(frantoio.socket.connected).toBe(true);
        expect(altro.socket.connected).toBe(true);

        const tipi = await api().get('/passepartout/tipi-pagamento').set(bearer(token));
        expect(tipi.status).toBe(200);
        expect(tipi.body.map((x: any) => x.codice)).toContain('CONTANTI-PC-FRANTOIO');
        expect(frantoio.calls).toContain('tipiPagamento');
        expect(altro.calls).not.toContain('tipiPagamento');
    });

    it('un token sconosciuto non si collega', async () => {
        const socket = ioClient(`${process.env.TEST_BASE_URL}/pp-agent`, {
            auth: { token: 'tokensconosciuto0123456789abcdef' }, transports: ['websocket'], reconnection: false,
        });
        aperti.push(socket);
        const esito = await new Promise<string>((resolve) => {
            socket.on('connect', () => resolve('connesso'));
            socket.on('connect_error', (err) => resolve(err.message));
        });
        expect(esito).toBe('Token agente non valido');
    });

    it('la chiusura in cassa eredita l\'env per il ristorante 1 finché la sezione non la imposta', async () => {
        const prima = await api().get('/passepartout/config').set(bearer(token));
        expect(prima.status).toBe(200);
        expect(prima.body).toMatchObject({
            tipo_pagamento_esterno: null,
            effettivo: { tipo_pagamento: 'ESTERNO', tipo_documento: 'Scontrino' },
            agente: { connected: true, hostname: 'PC-FRANTOIO' },
        });

        const salva = await api().put('/passepartout/config').set(bearer(token)).send({ tipo_pagamento_esterno: 'ONLINE', tipo_documento: 'Proforma' });
        expect(salva.status).toBe(200);
        expect(salva.body.effettivo).toEqual({ tipo_pagamento: 'ONLINE', tipo_documento: 'Proforma' });

        expect((await api().put('/passepartout/config').set(bearer(token)).send({ tipo_documento: 'Fattura' })).status).toBe(400);
        expect((await api().put('/passepartout/config').set(bearer(token)).send({})).status).toBe(400);

        // Tolto dalla sezione, torna il ripiego del server.
        const via = await api().put('/passepartout/config').set(bearer(token)).send({ tipo_pagamento_esterno: null, tipo_documento: null });
        expect(via.body.effettivo).toEqual({ tipo_pagamento: 'ESTERNO', tipo_documento: 'Scontrino' });
    });

    it('senza l\'add-on la sezione non risponde', async () => {
        await api().put('/settings/entitlements').set(bearer(token)).send({ passepartout: false });
        expect((await api().get('/passepartout/config').set(bearer(token))).status).toBe(403);
        await api().put('/settings/entitlements').set(bearer(token)).send({ passepartout: true });
    });

    it('il token dell\'agente non arriva al nodo di sala', async () => {
        const t = await db.query('SELECT sala_node_token FROM tenants WHERE id = 1');
        const header = { 'X-Sala-Node-Token': t.rows[0].sala_node_token };
        const riga = await api().get('/sala-node/tenant').set(header);
        expect(riga.status).toBe(200);
        expect(Number(riga.body.tenant.id)).toBe(1);
        expect(riga.body.tenant).not.toHaveProperty('passepartout_agent_token');
        const snap = await api().get('/sala-node/snapshot').set(header);
        expect(snap.status).toBe(200);
        expect(snap.body.tables.tenants[0]).not.toHaveProperty('passepartout_agent_token');
    });
});

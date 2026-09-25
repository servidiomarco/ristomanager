import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Client } from 'pg';
import { io as ioClient, type Socket } from 'socket.io-client';
import { api, ownerToken, bearer } from './helpers';
import { callPassepartout, getPassepartoutAgentStatus, PassepartoutBridgeError } from '../../services/passepartoutBridge';

// L'agente Passepartout è uno solo e parla con la cassa e l'RT fiscale del
// Vecchio Frantoio (tenant 1). Audit isolamento tenant H-01: qualunque altro
// tenant col conto al tavolo acceso poteva leggere la comanda viva di un
// tavolo del Frantoio, aprirci sopra un conto e, saldandolo, far chiudere il
// tavolo ed emettere uno scontrino sull'RT del Frantoio.
//
// Qui il secondo tenant si accende DA SOLO passepartout e pay_at_table (il
// PUT self-service degli entitlement): il rifiuto non deve dipendere dagli
// entitlement, ma dal tenant. E deve essere un 403 netto, mai il 503
// «agente offline» — l'agente nell'ambiente di test non c'è, quindi un 503
// vorrebbe dire che la richiesta è arrivata fino al ponte.
//
// In coda un finto agente si collega col token di globalSetup e conta le
// chiamate che riceve: dal secondo tenant, chiusura in cassa compresa (quella
// che batte lo scontrino sull'RT), non deve arrivarne nessuna.
const PP_AGENT_TOKEN = 'test-pp-agent-token';

const ADMIN_HEADER = { 'X-Platform-Admin-Token': 'test-platform-token' };
const SLUG = 'pizzeria-passepartout-test';
const OWNER2_EMAIL = 'owner.passepartout@example.com';

const dbUrl = () => process.env.DATABASE_URL || 'postgresql://localhost/ristotest_api';

describe('Passepartout: solo il tenant collegato all\'agente', () => {
    let db: Client;
    let tenant2Id = 0;
    let owner2Token = '';
    let reservationId = 0;
    let tableId = 0;

    beforeAll(async () => {
        db = new Client({ connectionString: dbUrl() });
        await db.connect();

        const created = await api().post('/admin/tenants').set(ADMIN_HEADER).send({
            slug: SLUG,
            name: 'Pizzeria Passepartout Test',
            owner_email: OWNER2_EMAIL,
        });
        expect(created.status).toBe(201);
        tenant2Id = Number(created.body.tenant.id);
        expect(tenant2Id).not.toBe(1);

        const login = await api().post('/auth/login').send({
            email: OWNER2_EMAIL,
            password: created.body.owner_temp_password,
        });
        expect(login.status).toBe(200);
        owner2Token = login.body.accessToken;

        // Il caso peggiore: entitlement e flag operativo accesi dal tenant
        // stesso, come può fare oggi qualunque OWNER con settings:full.
        const ent = await api().put('/settings/entitlements').set(bearer(owner2Token))
            .send({ passepartout: true, pay_at_table: true });
        expect(ent.status).toBe(200);
        const flags = await api().put('/settings/features').set(bearer(owner2Token))
            .send({ pay_at_table_enabled: true });
        expect(flags.status).toBe(200);

        // Un tavolo «40» e una prenotazione sopra, come nella sala del
        // Frantoio: i nomi tavolo sono l'unica chiave verso il gestionale.
        const t = await db.query(
            `INSERT INTO tables (tenant_id, name, shape, seats, x, y, status)
             VALUES ($1, '40', 'SQUARE', 4, 100, 100, 'FREE') RETURNING id`,
            [tenant2Id]
        );
        tableId = Number(t.rows[0].id);
        const r = await db.query(
            `INSERT INTO reservations (tenant_id, customer_name, phone, guests, reservation_time, shift, payment_status, reservation_status, table_id)
             VALUES ($1, 'Ospite Passepartout', '+390000000047', 2, now(), 'DINNER', 'NONE', 'CONFIRMED', $2) RETURNING id`,
            [tenant2Id, tableId]
        );
        reservationId = Number(r.rows[0].id);
    });

    afterAll(async () => {
        if (!db) return;
        try {
            if (tenant2Id) {
                // Ordine delle FK: conti → prenotazioni → tavoli, poi quello
                // che il provisioning e il login lasciano sul tenant.
                for (const table of ['fiscal_documents', 'table_bill_payments', 'table_bills', 'reservations', 'tables', 'user_sessions', 'app_settings',
                    'tenant_tokens', 'users', 'tenant_features', 'opening_hours', 'role_permissions']) {
                    await db.query(`DELETE FROM ${table} WHERE tenant_id = $1`, [tenant2Id]).catch(() => {});
                }
                // activity_logs per ultimo e con un secondo giro: i log sono
                // fire-and-forget e l'ultimo può atterrare dopo la prima
                // DELETE (vedi tenant-timezone.test.ts).
                let ultimo: unknown = null;
                for (let tentativo = 0; tentativo < 2; tentativo++) {
                    await db.query('DELETE FROM activity_logs WHERE tenant_id = $1', [tenant2Id]).catch(() => {});
                    try {
                        await db.query('DELETE FROM tenants WHERE id = $1', [tenant2Id]);
                        ultimo = null;
                        break;
                    } catch (err) {
                        ultimo = err;
                    }
                }
                if (ultimo) throw ultimo;
            }
        } finally {
            await db.end();
        }
    });

    it('anteprima comanda del tavolo → 403 passepartout_not_for_tenant, non 503', async () => {
        const res = await api().get('/passepartout/tavolo/40').set(bearer(owner2Token));
        expect(res.status).toBe(403);
        expect(res.body.error).toBe('passepartout_not_for_tenant');
        expect(res.body.message).toBe('Integrazione cassa non disponibile per questo ristorante');
    });

    it('introspezione ws-operations → 403', async () => {
        const res = await api().get('/passepartout/ws-operations').set(bearer(owner2Token));
        expect(res.status).toBe(403);
        expect(res.body.error).toBe('passepartout_not_for_tenant');
    });

    it('import menu dalla cassa, entitlement acceso → 403 per tenant, non per feature', async () => {
        const res = await api().post('/menu/import/passepartout').set(bearer(owner2Token));
        expect(res.status).toBe(403);
        expect(res.body.error).toBe('passepartout_not_for_tenant');
    });

    it('conto da comanda Passepartout su prenotazione → 403 e nessun conto aperto', async () => {
        const res = await api().post(`/reservations/${reservationId}/bill`).set(bearer(owner2Token))
            .send({ source: 'passepartout', pp_tavolo: '40' });
        expect(res.status).toBe(403);
        expect(res.body.error).toBe('passepartout_not_for_tenant');

        const bills = await db.query('SELECT count(*)::int AS n FROM table_bills WHERE tenant_id = $1', [tenant2Id]);
        expect(bills.rows[0].n).toBe(0);
    });

    it('conto da comanda Passepartout sul tavolo (walk-in) → 403 e nessun conto aperto', async () => {
        const res = await api().post(`/tables/${tableId}/bill`).set(bearer(owner2Token))
            .send({ source: 'passepartout', pp_tavolo: '40' });
        expect(res.status).toBe(403);
        expect(res.body.error).toBe('passepartout_not_for_tenant');

        const bills = await db.query('SELECT count(*)::int AS n FROM table_bills WHERE tenant_id = $1', [tenant2Id]);
        expect(bills.rows[0].n).toBe(0);
    });

    it('lo stato dell\'agente non rivela hostname né versione del gestionale', async () => {
        // Il server dei test ha il token agente: per il Frantoio è configurato.
        const mio = await api().get('/passepartout/status').set(bearer(await ownerToken()));
        expect(mio.body.configured).toBe(true);

        const res = await api().get('/passepartout/status').set(bearer(owner2Token));
        expect(res.status).toBe(200);
        expect(res.body.configured).toBe(false);
        expect(res.body.connected).toBe(false);
        expect(res.body.hostname).toBeNull();
        expect(res.body.versione_gestionale).toBeNull();
    });

    it('il tenant 1 arriva ancora fino al ponte: 503 agente offline', async () => {
        const token = await ownerToken();
        const res = await api().get('/passepartout/tavolo/40').set(bearer(token));
        expect(res.status).toBe(503);
        expect(res.body.error).toBe('passepartout_agent_offline');
    });

    // Con un agente collegato davvero: un 403 non basta a dire che la cassa
    // non ha ricevuto nulla, lo dice il conteggio delle chiamate. Il finto
    // agente risponde «nessuna comanda» all'anteprima e un errore del
    // gestionale a tutto il resto, così nessuno scontrino finisce a DB.
    describe('con l\'agente collegato', () => {
        let agent: Socket;
        const chiamate: Array<{ op: string; params: any }> = [];
        let tavolo1Id = 0;
        const conti1: number[] = [];

        const statoDi = async (token: string) =>
            (await api().get('/passepartout/status').set(bearer(token))).body;
        const attendi = async (cond: () => boolean | Promise<boolean>, ms: number, cosa: string) => {
            const fine = Date.now() + ms;
            while (Date.now() < fine) {
                if (await cond()) return;
                await new Promise(r => setTimeout(r, 50));
            }
            throw new Error(`in ${ms} ms non è successo: ${cosa}`);
        };
        const contoPp = async (tenantId: number, tavolo: number, idComanda: number, status: 'OPEN' | 'CLOSED') => {
            const r = await db.query(
                `INSERT INTO table_bills (tenant_id, table_id, total_cents, covers, status, external_ref, closed_at)
                 VALUES ($1, $2, 1000, 2, $3, $4, $5) RETURNING id`,
                [tenantId, tavolo, status, `pp:comanda:${idComanda}`, status === 'CLOSED' ? new Date() : null]
            );
            return Number(r.rows[0].id);
        };

        beforeAll(async () => {
            agent = ioClient(`${process.env.TEST_BASE_URL}/pp-agent`, {
                transports: ['websocket'],
                auth: { token: PP_AGENT_TOKEN },
                reconnection: false,
                timeout: 10_000,
            });
            agent.on('pp:call', (payload: { op: string; params: any }, ack: (r: unknown) => void) => {
                chiamate.push(payload);
                if (payload?.op === 'comandaTavolo') ack({ ok: true, result: null });
                else ack({ ok: false, kind: 'gestionale', error: 'gestionale finto del test' });
            });
            await new Promise<void>((resolve, reject) => {
                const t = setTimeout(() => reject(new Error('finto agente non connesso')), 10_000);
                agent.on('connect', () => { clearTimeout(t); resolve(); });
                agent.on('connect_error', (e) => { clearTimeout(t); reject(e); });
            });
            agent.emit('agent:hello', { hostname: 'PC-CASSA-FRANTOIO', versioneGestionale: '9.9-test' });
            const owner1 = await ownerToken();
            await attendi(async () => (await statoDi(owner1)).hostname === 'PC-CASSA-FRANTOIO', 5_000, 'hello dell\'agente registrato');

            const t = await db.query(
                `INSERT INTO tables (tenant_id, name, shape, seats, x, y, status)
                 VALUES (1, 'pp-test-cassa', 'SQUARE', 2, 900, 900, 'FREE') RETURNING id`
            );
            tavolo1Id = Number(t.rows[0].id);
        });

        afterAll(async () => {
            try {
                if (agent) {
                    agent.disconnect();
                    // I file dopo questo si aspettano di nuovo «agente offline».
                    const owner1 = await ownerToken();
                    await attendi(async () => (await statoDi(owner1)).connected === false, 5_000, 'agente scollegato');
                }
            } finally {
                if (conti1.length) {
                    await db.query('DELETE FROM fiscal_documents WHERE table_bill_id = ANY($1::int[])', [conti1]);
                    await db.query('DELETE FROM table_bills WHERE id = ANY($1::int[])', [conti1]);
                }
                if (tavolo1Id) await db.query('DELETE FROM tables WHERE id = $1', [tavolo1Id]);
            }
        });

        it('lo stato: il Frantoio vede il suo PC, l\'altro tenant niente', async () => {
            const mio = await statoDi(await ownerToken());
            expect(mio.connected).toBe(true);
            expect(mio.hostname).toBe('PC-CASSA-FRANTOIO');

            const altro = await statoDi(owner2Token);
            expect(altro).toMatchObject({ configured: false, connected: false, hostname: null, versione_gestionale: null });
        });

        it('anteprima, import conto e import menu del secondo tenant: 403 e zero chiamate alla cassa', async () => {
            const richieste = [
                () => api().get('/passepartout/tavolo/40').set(bearer(owner2Token)),
                () => api().get('/passepartout/ws-operations').set(bearer(owner2Token)),
                () => api().post('/menu/import/passepartout').set(bearer(owner2Token)),
                () => api().post(`/reservations/${reservationId}/bill`).set(bearer(owner2Token))
                    .send({ source: 'passepartout', pp_tavolo: '40' }),
                () => api().post(`/tables/${tableId}/bill`).set(bearer(owner2Token))
                    .send({ source: 'passepartout', pp_tavolo: '40' }),
            ];
            for (const r of richieste) {
                const res = await r();
                expect(res.status).toBe(403);
                expect(res.body.error).toBe('passepartout_not_for_tenant');
            }
            expect(chiamate).toEqual([]);
        });

        it('«Chiudi in cassa» su un conto pp del secondo tenant: 403, nessuno scontrino', async () => {
            const billId = await contoPp(tenant2Id, tableId, 7001, 'CLOSED');
            const res = await api().post(`/bills/${billId}/passepartout-close`).set(bearer(owner2Token)).send({});
            expect(res.status).toBe(403);
            expect(res.body.error).toBe('passepartout_not_for_tenant');
            expect(chiamate).toEqual([]);

            const docs = await db.query('SELECT count(*)::int AS n FROM fiscal_documents WHERE table_bill_id = $1', [billId]);
            expect(docs.rows[0].n).toBe(0);
        });

        it('chiusura automatica al saldo di un conto pp del secondo tenant: la cassa non riceve nulla', async () => {
            const billId = await contoPp(tenant2Id, tableId, 7002, 'OPEN');
            const res = await api().post(`/bills/${billId}/close`).set(bearer(owner2Token))
                .send({ payments: [{ method: 'POS_FISICO', amount_cents: 1000 }] });
            expect(res.status).toBe(200);
            expect(res.body.status).toBe('CLOSED');
            // La chiusura in cassa parte dopo la risposta: si lascia il tempo
            // che arriverebbe all'agente (per il tenant 1, qui sotto, sono ms).
            await new Promise(r => setTimeout(r, 1_000));
            expect(chiamate).toEqual([]);
        });

        it('il tenant 1 invece arriva all\'agente: anteprima, «Chiudi in cassa» e chiusura automatica', async () => {
            const owner1 = await ownerToken();

            const anteprima = await api().get('/passepartout/tavolo/40').set(bearer(owner1));
            expect(anteprima.status).toBe(404);
            expect(anteprima.body.error).toBe('no_comanda');
            expect(chiamate.some(c => c.op === 'comandaTavolo' && c.params?.tavolo === '40')).toBe(true);

            const chiuso = await contoPp(1, tavolo1Id, 7101, 'CLOSED');
            conti1.push(chiuso);
            const retry = await api().post(`/bills/${chiuso}/passepartout-close`).set(bearer(owner1)).send({});
            expect(retry.status).toBe(502);
            expect(retry.body.error).toBe('passepartout_gestionale');
            expect(chiamate.some(c => c.op === 'chiudi' && c.params?.idComanda === 7101)).toBe(true);

            const aperto = await contoPp(1, tavolo1Id, 7102, 'OPEN');
            conti1.push(aperto);
            const close = await api().post(`/bills/${aperto}/close`).set(bearer(owner1))
                .send({ payments: [{ method: 'POS_FISICO', amount_cents: 1000 }] });
            expect(close.status).toBe(200);
            await attendi(() => chiamate.some(c => c.op === 'chiudi' && c.params?.idComanda === 7102), 5_000,
                'chiusura automatica del tenant 1 arrivata all\'agente');
            // Nessuna chiamata ha mai portato una comanda del secondo tenant.
            expect(chiamate.some(c => c.params?.idComanda === 7001 || c.params?.idComanda === 7002)).toBe(false);
        });
    });
});

// In-process sul modulo del ponte, senza server di mezzo: col token in env
// solo il tenant 1 vede l'agente configurato, e l'ordine dei controlli (prima
// il tenant, poi l'agente offline) si vede senza nessun agente collegato.
describe('ponte Passepartout: controllo del tenant al punto di uscita', () => {
    const tokenPrima = process.env.PASSEPARTOUT_AGENT_TOKEN;
    beforeAll(() => { process.env.PASSEPARTOUT_AGENT_TOKEN = 'token-di-prova'; });
    afterAll(() => {
        if (tokenPrima === undefined) delete process.env.PASSEPARTOUT_AGENT_TOKEN;
        else process.env.PASSEPARTOUT_AGENT_TOKEN = tokenPrima;
    });

    it('lo stato è del solo tenant 1', () => {
        expect(getPassepartoutAgentStatus(1).configured).toBe(true);
        expect(getPassepartoutAgentStatus(3)).toEqual({
            configured: false, connected: false, connected_at: null, hostname: null, versione_gestionale: null,
        });
    });

    it('un altro tenant è respinto prima del controllo agente offline', async () => {
        await expect(callPassepartout(3, 'versione')).rejects.toBeInstanceOf(PassepartoutBridgeError);
        await expect(callPassepartout(3, 'versione')).rejects.toMatchObject({ kind: 'not_for_tenant' });
        // Il Frantoio passa il controllo e si ferma dove si fermava prima.
        await expect(callPassepartout(1, 'versione')).rejects.toMatchObject({ kind: 'agent_offline' });
    });
});

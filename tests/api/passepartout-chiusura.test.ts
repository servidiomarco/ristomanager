import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Client } from 'pg';
import { io as ioClient, type Socket } from 'socket.io-client';
import { api, bearer, ownerToken } from './helpers';

// Fase B5 del piano «sala, comande e conto sul nodo»: la chiusura in cassa
// di un conto nato da una comanda Passepartout non è più un colpo solo.
// Nasce PENDING con la chiusura del conto, si riprova da sola con
// `riprendi` (l'agente guarda prima nell'archivio, niente secondo
// scontrino), e diventa FAILED — col bottone «Chiudi in cassa» — quando
// serve una mano. Un agente finto prende il posto di quello del PC.

const AGENT_TOKEN = 'test-pp-agent-token';
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

interface FakeAgent { socket: Socket; calls: Array<{ op: string; params: any }>; close: () => Promise<void> }

const comandaPer = (tavolo: string, idComanda: number) => ({
    idGestionale: idComanda, tavolo, sala: 'Sala', coperti: 2, sconto: null, stato: '1',
    righe: [{ idGestionale: idComanda * 10, descrizione: 'Tagliatelle', articolo: 'TAGL', prezzo: 12, pezzi: 2, totale: 24, stato: '1' }],
});
const esito = (numero: string) => ({
    chiuso: true, importoSospeso: 0, stato: 'Pagato', numeroScontrino: numero,
    totalePagato: 24, totaleDaPagare: 24, avviso: null,
});

describe('chiusura in cassa Passepartout durevole', () => {
    let token: string;
    let db: Client;
    // tavolo Passepartout → id della comanda sul gestionale
    const comande = new Map<string, number>();
    let agent: FakeAgent | null = null;

    const finoA = async (cond: () => Promise<boolean>, descr: string, timeoutMs = 10_000) => {
        const deadline = Date.now() + timeoutMs;
        for (;;) {
            if (await cond()) return;
            if (Date.now() > deadline) throw new Error(`Timeout: ${descr}`);
            await sleep(150);
        }
    };

    const startAgent = async (opts: { capabilities?: string[]; chiudi: (params: any) => any }): Promise<FakeAgent> => {
        const socket = ioClient(`${process.env.TEST_BASE_URL}/pp-agent`, {
            auth: { token: AGENT_TOKEN }, transports: ['websocket'], reconnection: false,
        });
        const calls: FakeAgent['calls'] = [];
        socket.on('pp:call', async (payload: any, ack: (r: unknown) => void) => {
            calls.push({ op: payload?.op, params: payload?.params });
            if (payload?.op === 'comandaTavolo') {
                const id = comande.get(String(payload.params?.tavolo));
                return ack({ ok: true, result: id ? comandaPer(payload.params.tavolo, id) : null });
            }
            if (payload?.op === 'chiudi') {
                try {
                    return ack({ ok: true, result: await opts.chiudi(payload.params) });
                } catch (err: any) {
                    return ack({ ok: false, error: err.message, kind: 'gestionale' });
                }
            }
            ack({ ok: false, error: `op non prevista: ${payload?.op}`, kind: 'agent' });
        });
        await new Promise<void>((resolve, reject) => {
            socket.on('connect', () => resolve());
            socket.on('connect_error', reject);
        });
        socket.emit('agent:hello', { hostname: 'agente-di-prova', capabilities: opts.capabilities ?? [] });
        await finoA(async () => {
            const st = await api().get('/passepartout/status').set(bearer(token));
            return st.body.connected === true && JSON.stringify(st.body.capabilities) === JSON.stringify(opts.capabilities ?? []);
        }, 'agente annunciato');
        const fake: FakeAgent = {
            socket, calls,
            close: async () => {
                socket.close();
                await finoA(async () => (await api().get('/passepartout/status').set(bearer(token))).body.connected === false,
                    'agente scollegato');
            },
        };
        agent = fake;
        return fake;
    };

    /** Un conto aperto dalla comanda Passepartout del tavolo `nome`. */
    const openPpBill = async (nome: string, idComanda: number, withAgent: FakeAgent | null) => {
        comande.set(nome, idComanda);
        const room = await api().post('/rooms').set(bearer(token)).send({ name: `Sala ${nome}`, width: 400, height: 300 });
        const table = await api().post('/tables').set(bearer(token)).send({
            name: nome, shape: 'SQUARE', seats: 4, x: 40, y: 40, room_id: room.body.id, status: 'FREE',
        });
        const helper = withAgent ?? await startAgent({ chiudi: () => esito('ignorato') });
        const bill = await api().post(`/tables/${table.body.id}/bill`).set(bearer(token)).send({ source: 'passepartout', pp_tavolo: nome });
        expect(bill.status).toBe(201);
        expect(bill.body.bill.external_ref).toBe(`pp:comanda:${idComanda}`);
        if (!withAgent) await helper.close();
        return bill.body.bill as { id: number; total_cents: number };
    };
    const closeBill = async (bill: { id: number; total_cents: number }) => {
        const res = await api().post(`/bills/${bill.id}/close`).set(bearer(token))
            .send({ payments: [{ method: 'CONTANTI', amount_cents: bill.total_cents }] });
        expect(res.status).toBe(200);
        expect(res.body.status).toBe('CLOSED');
    };
    const docs = async (billId: number) => (await db.query(
        `SELECT id, status, provider, doc_type, provider_ref, attempts, error, response FROM fiscal_documents
          WHERE table_bill_id = $1 ORDER BY id`, [billId]
    )).rows;

    beforeAll(async () => {
        token = await ownerToken();
        db = new Client({ connectionString: process.env.DATABASE_URL || 'postgresql://localhost/ristotest_api' });
        await db.connect();
    });

    afterAll(async () => {
        await agent?.close().catch(() => {});
        await db.end();
    });

    it('il primo tentativo fallisce: resta PENDING e lo spazzino lo riprende senza rifare lo scontrino', async () => {
        let n = 0;
        const fake = await startAgent({
            capabilities: ['chiudi-riprendi'],
            chiudi: () => {
                n++;
                if (n === 1) throw new Error('modificate le informazioni da un altro utente');
                return esito('0042-0007');
            },
        });
        const bill = await openPpBill('PP1', 9101, fake);
        await closeBill(bill);

        await finoA(async () => (await docs(bill.id)).some(d => d.status === 'CONFIRMED'), 'chiusura ripresa');
        const [doc] = await docs(bill.id);
        expect(doc.provider).toBe('passepartout');
        expect(doc.doc_type).toBe('RECEIPT');
        expect(doc.provider_ref).toBe('0042-0007');
        expect(doc.attempts).toBe(2);
        expect(doc.error).toBeNull();

        const chiusure = fake.calls.filter(c => c.op === 'chiudi');
        expect(chiusure).toHaveLength(2);
        expect(chiusure[0].params).toMatchObject({ idComanda: 9101, tipoPagamento: 'ESTERNO', riprendi: false });
        // Il secondo tentativo chiede all'agente di guardare prima in archivio.
        expect(chiusure[1].params.riprendi).toBe(true);

        // Nel log di replica: la riga sale al cloud (o scende al nodo).
        const logged = await db.query(
            `SELECT COUNT(*)::int AS n FROM outbox_events WHERE event = 'fiscalDoc:changed' AND payload->>'fiscal_document_id' = $1`,
            [String(doc.id)]
        );
        expect(logged.rows[0].n).toBeGreaterThanOrEqual(2);
        await fake.close();
    });

    it('con un agente che non sa riprendere: FAILED subito, e «Chiudi in cassa» lo rifà a mano', async () => {
        let fallisci = true;
        const fake = await startAgent({
            chiudi: () => {
                if (fallisci) throw new Error('RT in errore carta');
                return esito('0042-0008');
            },
        });
        const bill = await openPpBill('PP2', 9102, fake);
        await closeBill(bill);

        await finoA(async () => (await docs(bill.id)).some(d => d.status === 'FAILED'), 'chiusura in errore');
        const [failed] = await docs(bill.id);
        expect(failed.error).toContain('Controlla in cassa');
        // Nessun tentativo automatico dopo che il primo è arrivato all'agente.
        await sleep(1_200);
        expect(fake.calls.filter(c => c.op === 'chiudi')).toHaveLength(1);

        fallisci = false;
        const manual = await api().post(`/bills/${bill.id}/passepartout-close`).set(bearer(token)).send({});
        expect(manual.status).toBe(200);
        expect(manual.body.esito.numeroScontrino).toBe('0042-0008');
        const rows = await docs(bill.id);
        expect(rows.map(r => r.status)).toEqual(['FAILED', 'CONFIRMED']);
        expect(fake.calls.filter(c => c.op === 'chiudi').at(-1)!.params.riprendi).toBe(true);
        await fake.close();
    });

    it('agente spento alla chiusura: PENDING, e parte da solo appena l\'agente si ricollega', async () => {
        const bill = await openPpBill('PP3', 9103, null);
        await closeBill(bill);
        await finoA(async () => {
            const [d] = await docs(bill.id);
            return d?.status === 'PENDING' && Number(d.response?.offline_attempts) === 1;
        }, 'tentativo a vuoto registrato');

        // Anche un agente che non dichiara la ripresa: il tentativo precedente
        // non era mai arrivato a lui.
        const fake = await startAgent({ chiudi: () => esito('0042-0009') });
        await finoA(async () => (await docs(bill.id)).some(d => d.status === 'CONFIRMED'), 'chiusura partita al ritorno dell\'agente');
        const rows = await docs(bill.id);
        expect(rows).toHaveLength(1);
        expect(rows[0].provider_ref).toBe('0042-0009');
        expect(fake.calls.filter(c => c.op === 'chiudi')).toHaveLength(1);

        // Una seconda richiesta a mano su un conto già chiuso in cassa non
        // chiama l'agente: risponde con l'esito registrato.
        const again = await api().post(`/bills/${bill.id}/passepartout-close`).set(bearer(token)).send({});
        expect(again.status).toBe(200);
        expect(again.body.esito.numeroScontrino).toBe('0042-0009');
        expect(fake.calls.filter(c => c.op === 'chiudi')).toHaveLength(1);
        await fake.close();
    });
});

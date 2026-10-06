import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createHmac } from 'node:crypto';
import { Client } from 'pg';
import { io as ioClient, type Socket } from 'socket.io-client';
import { api, bearer, ownerToken } from './helpers';

// Pagamento dal QR di un tavolo battuto tutto nella cassa Passepartout. Il
// QR mostra «Paga il conto» quando il tavolo ha una comanda aperta in cassa;
// al tocco il CRM importa la comanda come conto (e lo riallinea finché
// nessuno paga). Saldato dal QR, il conto si chiude da solo e la cassa
// chiude il tavolo col tipo esterno; se in cassa la comanda è cambiata dopo
// il pagamento, la chiusura si ferma con la differenza.

const AGENT_TOKEN = 'test-pp-agent-token';
const WEBHOOK_SECRET = 'segreto-webhook-qr-cassa';
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const oraRoma = () => {
    const d = new Date();
    const ora = new Intl.DateTimeFormat('it-IT', { timeZone: 'Europe/Rome', hour: '2-digit', minute: '2-digit', hour12: false }).format(d);
    return `${new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Rome' }).format(d)}T${ora}:00`;
};
const riga = (id: number, descrizione: string, prezzo: number, pezzi = 1) =>
    ({ idGestionale: id, descrizione, articolo: descrizione.toUpperCase(), prezzo, pezzi, totale: prezzo * pezzi, stato: '1' });

describe('pagamento dal QR delle comande della cassa Passepartout', () => {
    let token: string;
    let db: Client;
    let socket: Socket | null = null;
    let flagsPrima: Record<string, boolean> = {};
    let tableId: number;
    let qr: string;
    // Lo stato della cassa finta: comande per id e quelle aperte sui tavoli.
    const comande = new Map<number, any>();
    const chiamate: Array<{ op: string; params: any }> = [];

    const finoA = async (cond: () => Promise<boolean>, descr: string, timeoutMs = 10_000) => {
        const deadline = Date.now() + timeoutMs;
        for (;;) {
            if (await cond()) return;
            if (Date.now() > deadline) throw new Error(`Timeout: ${descr}`);
            await sleep(150);
        }
    };
    const apriInCassa = (idComanda: number, righe: any[]) => {
        comande.set(idComanda, {
            idGestionale: idComanda, tavolo: 'PPQ1', sala: 'TETTOIA', coperti: 2, sconto: null, stato: '1',
            isPagato: false, idPrenotazione: null, dataCreazione: oraRoma(), righe,
        });
    };
    const aggiornaLettura = async () => {
        const r = await api().post('/passepartout/tavoli-aperti/aggiorna').set(bearer(token));
        expect(r.status).toBe(200);
    };
    const statoQr = async () => {
        const r = await api().get(`/public/table/${qr}/conto`);
        expect(r.status).toBe(200);
        return r.body.pay;
    };
    const conto = async (idComanda: number) => (await db.query(
        `SELECT id, status, total_cents, items, opened_by_user_id, share_token FROM table_bills
          WHERE tenant_id = 1 AND external_ref = $1 ORDER BY id DESC LIMIT 1`,
        [`pp:comanda:${idComanda}`]
    )).rows[0];
    /** L'ospite salda tutto il conto dal link di pagamento (Revolut finto). */
    const pagaTutto = async (shareToken: string, billId: number, importo: number) => {
        const claim = await api().post(`/pay/${shareToken}/claim`).send({ kind: 'full_bill', claimant_label: 'Ospite' });
        expect([200, 201]).toContain(claim.status);
        const splitId = Number(claim.body?.split?.id ?? claim.body?.split_id ?? claim.body?.id);
        const orderId = `ordine-qr-cassa-${billId}`;
        const pr = await db.query(
            `INSERT INTO payment_requests (tenant_id, amount_cents, currency, description, status, provider, provider_order_id, table_bill_split_id)
             VALUES (1, $1, 'EUR', 'Conto dal QR', 'PENDING', 'revolut', $2, $3) RETURNING id`,
            [importo, orderId, splitId]
        );
        await db.query(`UPDATE table_bill_splits SET payment_request_id = $1 WHERE id = $2`, [pr.rows[0].id, splitId]);
        const body = JSON.stringify({ event: 'ORDER_COMPLETED', order_id: orderId });
        const ts = String(Date.now());
        const signature = createHmac('sha256', WEBHOOK_SECRET).update(`v1.${ts}.${body}`).digest('hex');
        const hook = await api().post('/webhook/revolut')
            .set('Content-Type', 'application/json')
            .set('Revolut-Request-Timestamp', ts)
            .set('Revolut-Signature', `v1=${signature}`)
            .send(body);
        expect(hook.status).toBe(200);
    };

    beforeAll(async () => {
        token = await ownerToken();
        db = new Client({ connectionString: process.env.DATABASE_URL || 'postgresql://localhost/ristotest_api' });
        await db.connect();
        await api().put('/settings/entitlements').set(bearer(token)).send({ passepartout: true, pay_at_table: true });
        const prima = await api().get('/settings/features').set(bearer(token));
        flagsPrima = { pay_at_table_enabled: prima.body.pay_at_table_enabled === true };
        await api().put('/settings/features').set(bearer(token)).send({ pay_at_table_enabled: true });
        expect((await api().put('/settings/integrations/revolut').set(bearer(token)).send({ webhook_secret: WEBHOOK_SECRET })).status).toBe(200);

        const room = await api().post('/rooms').set(bearer(token)).send({ name: 'Sala QR Cassa', width: 600, height: 400 });
        const table = await api().post('/tables').set(bearer(token)).send({
            name: 'PPQ1', shape: 'SQUARE', seats: 4, x: 40, y: 40, room_id: room.body.id, status: 'FREE',
        });
        tableId = table.body.id;
        await db.query(
            `INSERT INTO passepartout_tavoli (table_id, tenant_id, pp_sala, pp_tavolo, origine, confermato) VALUES ($1, 1, 'TETTOIA', 'PPQ1', 'manuale', true)`,
            [tableId]
        );
        const tokens = await api().post('/tables/qr-tokens').set(bearer(token)).send({});
        expect(tokens.status).toBe(200);
        qr = tokens.body.find((r: any) => r.table_id === tableId).public_token;

        socket = ioClient(`${process.env.TEST_BASE_URL}/pp-agent`, {
            auth: { token: AGENT_TOKEN }, transports: ['websocket'], reconnection: false,
        });
        socket.on('pp:call', (payload: any, ack: (r: unknown) => void) => {
            chiamate.push({ op: payload?.op, params: payload?.params });
            if (payload?.op === 'comandeAperte') {
                return ack({
                    ok: true,
                    result: [...comande.values()].filter(c => !c.isPagato).map(c => ({
                        idComanda: c.idGestionale, tavolo: c.tavolo, sala: c.sala, coperti: c.coperti,
                        idPrenotazione: c.idPrenotazione, aperta: c.dataCreazione,
                        totale: c.righe.reduce((s: number, r: any) => s + r.totale, 0),
                    })),
                });
            }
            if (payload?.op === 'comanda') return ack({ ok: true, result: comande.get(Number(payload.params?.idGestionale)) ?? null });
            if (payload?.op === 'chiudi') {
                const c = comande.get(Number(payload.params?.idComanda));
                if (c) c.isPagato = true;
                const totale = c ? c.righe.reduce((s: number, r: any) => s + r.totale, 0) : 0;
                return ack({ ok: true, result: { chiuso: true, importoSospeso: 0, stato: 'Pagato', numeroScontrino: '0001-0042', totalePagato: totale, totaleDaPagare: totale, avviso: null } });
            }
            ack({ ok: false, error: `op non prevista: ${payload?.op}`, kind: 'agent' });
        });
        await new Promise<void>((resolve, reject) => {
            socket!.on('connect', () => resolve());
            socket!.on('connect_error', reject);
        });
        socket.emit('agent:hello', { hostname: 'agente-qr', capabilities: ['chiudi-riprendi', 'tavoli-aperti'] });
        await finoA(async () => ((await api().get('/passepartout/status').set(bearer(token))).body.capabilities ?? []).includes('tavoli-aperti'),
            'agente annunciato');
    });

    afterAll(async () => {
        await api().put('/passepartout/qr-pagamento/config').set(bearer(token)).send({ enabled: false });
        await api().put('/settings/features').set(bearer(token)).send(flagsPrima);
        await api().put('/settings/integrations/revolut').set(bearer(token)).send({ webhook_secret: '' });
        socket?.close();
        await db.query(`DELETE FROM passepartout_tavoli_aperti WHERE tenant_id = 1`);
        await db.query(`DELETE FROM passepartout_tavoli WHERE table_id = $1`, [tableId]);
        await db.query(`DELETE FROM notifications WHERE tag LIKE 'pp-comanda-cambiata-%' OR tag LIKE 'bill-paying-%'`);
        await db.end();
    });

    it('acceso: il QR mostra «Paga il conto» sul tavolo aperto in cassa, e il tocco importa la comanda', async () => {
        apriInCassa(8801, [riga(88011, 'Tagliatelle', 12, 2)]);
        // Spento, la cassa non legge e il QR non propone niente.
        expect((await api().post('/passepartout/tavoli-aperti/aggiorna').set(bearer(token))).status).toBe(409);
        expect((await statoQr()).open).toBe(false);

        const on = await api().put('/passepartout/qr-pagamento/config').set(bearer(token)).send({ enabled: true });
        expect(on.status).toBe(200);
        await aggiornaLettura();
        const pay = await statoQr();
        expect(pay).toMatchObject({ open: true, cassa: true });
        expect(pay.url).toBeUndefined();

        const tocco = await api().post(`/public/table/${qr}/conto/cassa`);
        expect(tocco.status).toBe(200);
        const bill = await conto(8801);
        expect(tocco.body.url).toMatch(new RegExp(`/pay/${bill.share_token}$`));
        expect(bill).toMatchObject({ status: 'OPEN', total_cents: 2400, opened_by_user_id: null });
        expect(bill.items).toHaveLength(1);

        // Ora c'è il conto: il tasto porta al pagamento, passando ancora
        // dalla cassa finché nessuno paga.
        expect(await statoQr()).toMatchObject({ open: true, cassa: true, residual_cents: 2400 });

        const cfg = await api().get('/passepartout/qr-pagamento/config').set(bearer(token));
        expect(cfg.body).toMatchObject({
            enabled: true, aperti: 1,
            requisiti: { conto_al_tavolo: true, tipo_pagamento: 'ESTERNO', conti_in_sala: false },
        });
    });

    it('finché nessuno paga, il tocco riallinea il conto alla comanda in cassa', async () => {
        comande.get(8801).righe.push(riga(88012, 'Caffè', 1.5));
        const tocco = await api().post(`/public/table/${qr}/conto/cassa`);
        expect(tocco.status).toBe(200);
        const bill = await conto(8801);
        expect(bill.total_cents).toBe(2550);
        expect(bill.items).toHaveLength(2);
        // Un conto solo, anche con due telefoni che toccano insieme.
        const [a, b] = await Promise.all([
            api().post(`/public/table/${qr}/conto/cassa`),
            api().post(`/public/table/${qr}/conto/cassa`),
        ]);
        expect(a.body.url).toBe(b.body.url);
        const n = await db.query(`SELECT COUNT(*)::int AS n FROM table_bills WHERE external_ref = 'pp:comanda:8801'`);
        expect(n.rows[0].n).toBe(1);
    });

    it('saldato dal QR: il conto si chiude da solo e la cassa chiude il tavolo col tipo esterno', async () => {
        const bill = await conto(8801);
        await pagaTutto(bill.share_token, bill.id, 2550);
        await finoA(async () => (await conto(8801)).status === 'CLOSED', 'conto chiuso da solo');
        await finoA(async () => {
            const doc = await db.query(
                `SELECT status, provider, provider_ref FROM fiscal_documents WHERE table_bill_id = $1`, [bill.id]);
            return doc.rows[0]?.status === 'CONFIRMED' && doc.rows[0].provider === 'passepartout';
        }, 'tavolo chiuso in cassa');
        const chiusura = chiamate.filter(c => c.op === 'chiudi').at(-1)!;
        expect(chiusura.params).toMatchObject({ idComanda: 8801, tipoPagamento: 'ESTERNO' });

        // Chiusa in cassa: alla lettura dopo, il QR non propone più niente.
        await aggiornaLettura();
        expect((await statoQr()).open).toBe(false);
    });

    it('comanda cambiata in cassa dopo il pagamento: niente chiusura automatica, e la differenza per chi è in cassa', async () => {
        apriInCassa(8802, [riga(88021, 'Pizza', 9, 2)]);
        await aggiornaLettura();
        expect((await api().post(`/public/table/${qr}/conto/cassa`)).status).toBe(200);
        const bill = await conto(8802);
        expect(bill.total_cents).toBe(1800);

        // L'ospite paga; intanto in cassa arriva un amaro.
        comande.get(8802).righe.push(riga(88022, 'Amaro', 3));
        const chiusurePrima = chiamate.filter(c => c.op === 'chiudi').length;
        await pagaTutto(bill.share_token, bill.id, 1800);
        await finoA(async () => {
            const doc = await db.query(`SELECT status FROM fiscal_documents WHERE table_bill_id = $1`, [bill.id]);
            return doc.rows[0]?.status === 'FAILED';
        }, 'chiusura in cassa fermata');
        const doc = await db.query(`SELECT error FROM fiscal_documents WHERE table_bill_id = $1`, [bill.id]);
        expect(doc.rows[0].error).toContain('ancora da incassare');
        expect(doc.rows[0].error).toContain('ESTERNO');
        expect(chiamate.filter(c => c.op === 'chiudi').length).toBe(chiusurePrima);
        expect((await conto(8802)).status).toBe('CLOSED');

        // La comanda è ancora aperta in cassa, ma è già stata pagata: il QR
        // non la fa pagare una seconda volta.
        await aggiornaLettura();
        expect((await statoQr()).open).toBe(false);
        const tocco = await api().post(`/public/table/${qr}/conto/cassa`);
        expect(tocco.status).toBe(409);
        expect(tocco.body.error).toBe('chiuso');
    });

    it('senza conto al tavolo non si accende', async () => {
        await api().put('/passepartout/qr-pagamento/config').set(bearer(token)).send({ enabled: false });
        await api().put('/settings/features').set(bearer(token)).send({ pay_at_table_enabled: false });
        const on = await api().put('/passepartout/qr-pagamento/config').set(bearer(token)).send({ enabled: true });
        expect(on.status).toBe(409);
        expect(on.body.error).toBe('conto_al_tavolo_spento');
        await api().put('/settings/features').set(bearer(token)).send({ pay_at_table_enabled: true });
    });
});

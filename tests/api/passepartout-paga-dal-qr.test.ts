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
// il pagamento, la chiusura si ferma con la differenza. Lo sconto messo in
// cassa sul conto del tavolo entra nel conto del QR.

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
    // Lo sconto in euro sul conto aperto della comanda, come lo legge
    // GetContiGiorno; scontoMuto = l'agente non risponde su quella lettura.
    const sconti = new Map<number, number>();
    let scontoMuto = false;
    const chiamate: Array<{ op: string; params: any }> = [];

    const finoA = async (cond: () => Promise<boolean>, descr: string, timeoutMs = 10_000) => {
        const deadline = Date.now() + timeoutMs;
        for (;;) {
            if (await cond()) return;
            if (Date.now() > deadline) throw new Error(`Timeout: ${descr}`);
            await sleep(150);
        }
    };
    const apriInCassa = (idComanda: number, righe: any[], tavolo = 'PPQ1') => {
        comande.set(idComanda, {
            idGestionale: idComanda, tavolo, sala: 'TETTOIA', coperti: 2, sconto: null, stato: '1',
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
        `SELECT id, status, total_cents, items, opened_by_user_id, share_token,
                discount_type, discount_value::float AS discount_value, discount_reason FROM table_bills
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
            if (payload?.op === 'comandaTavolo') {
                const c = [...comande.values()].find(x => !x.isPagato && x.tavolo === payload.params?.tavolo);
                return ack({ ok: true, result: c ?? null });
            }
            if (payload?.op === 'scontoComanda') {
                if (scontoMuto) return ack({ ok: false, error: 'GetContiGiorno: timeout', kind: 'gestionale' });
                const id = Number(payload.params?.idComanda);
                const c = comande.get(id);
                if (!c || c.isPagato) return ack({ ok: true, result: null });
                const totale = c.righe.reduce((s: number, r: any) => s + r.totale, 0);
                const sconto = sconti.get(id) ?? 0;
                return ack({ ok: true, result: { idConto: id + 100_000, totaleDocumento: totale, totaleDaPagare: totale - sconto, scontoEuro: sconto } });
            }
            if (payload?.op === 'preconto') return ack({ ok: true, result: { emesso: true } });
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
        socket.emit('agent:hello', { hostname: 'agente-qr', capabilities: ['chiudi-riprendi', 'tavoli-aperti', 'chiudi-preconto', 'preconto', 'sconto-cassa'] });
        await finoA(async () => ((await api().get('/passepartout/status').set(bearer(token))).body.capabilities ?? []).includes('tavoli-aperti'),
            'agente annunciato');
    });

    afterAll(async () => {
        await api().put('/passepartout/qr-pagamento/config').set(bearer(token)).send({ enabled: false });
        await api().put('/settings/features').set(bearer(token)).send(flagsPrima);
        await api().put('/settings/integrations/revolut').set(bearer(token)).send({ webhook_secret: '' });
        socket?.close();
        await db.query(`DELETE FROM passepartout_tavoli_aperti WHERE tenant_id = 1`);
        await db.query(`DELETE FROM passepartout_tavoli WHERE tenant_id = 1 AND pp_tavolo IN ('PPQ1', 'PPQ2')`);
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

        // Il tavolo vuole pagare: preconto in cassa (tavolo blu) e push alla
        // cassa e ai camerieri, col tag di «sta pagando dal QR».
        await finoA(async () => chiamate.some(c => c.op === 'preconto' && c.params?.idComanda === 8801), 'preconto chiesto alla cassa');
        await finoA(async () => (await db.query(
            `SELECT 1 FROM notifications WHERE tag = $1 AND title LIKE '%vuole pagare dal QR%'`, [`bill-paying-${bill.id}`]
        )).rows.length > 0, 'avviso «vuole pagare»');

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
        // Il preconto si chiede una volta sola, quando il conto nasce.
        expect(chiamate.filter(c => c.op === 'preconto')).toHaveLength(1);
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

        // Uno scontrino per il tavolo, e la sua copia digitale su ogni
        // telefono che ha pagato: la pagina di pagamento resta leggibile e
        // porta allo scontrino della cassa.
        const doc = (await db.query(
            `SELECT public_token FROM fiscal_documents WHERE table_bill_id = $1 AND provider = 'passepartout'`, [bill.id]
        )).rows[0];
        expect(doc.public_token).toMatch(/^[0-9a-f]{64}$/);
        const pagina = await api().get(`/pay/${bill.share_token}`);
        expect(pagina.status).toBe(200);
        expect(pagina.body.bill.status).toBe('CLOSED');
        expect(pagina.body.residual_cents).toBe(0);
        expect(pagina.body.receipt_url).toMatch(new RegExp(`/scontrino/${doc.public_token}$`));
        const copia = await api().get(`/scontrino/${doc.public_token}`);
        expect(copia.status).toBe(200);
        expect(copia.body.receipt).toMatchObject({
            doc_number: '0001-0042', issuer: 'cassa', total_cents: 2550, electronic_cents: 2550, cash_cents: 0,
            paid_by: [{ label: 'Ospite', amount_cents: 2550 }],
        });
        expect(copia.body.receipt.items.map((i: any) => i.description)).toEqual(['Tagliatelle', 'Caffè']);
        // Saldato, il conto non si paga più.
        const ancora = await api().post(`/pay/${bill.share_token}/claim`).send({ kind: 'full_bill', claimant_label: 'Altro' });
        expect([404, 409]).toContain(ancora.status);

        // Chiusa in cassa: alla lettura dopo, il QR non propone più niente.
        await aggiornaLettura();
        expect((await statoQr()).open).toBe(false);
    });

    it('lo sconto messo in cassa entra nel conto del QR e lo segue finché nessuno paga (07/10)', async () => {
        // Come la comanda 78529: 221,50 € di righe, 21,50 di sconto in cassa.
        apriInCassa(8805, [riga(88051, 'Grigliata', 100, 2), riga(88052, 'Vino', 21.5)]);
        sconti.set(8805, 21.5);
        await aggiornaLettura();
        const tocco = await api().post(`/public/table/${qr}/conto/cassa`);
        expect(tocco.status).toBe(200);
        let bill = await conto(8805);
        expect(bill).toMatchObject({
            status: 'OPEN', total_cents: 20000, discount_type: 'AMOUNT', discount_value: 21.5, discount_reason: 'Sconto della cassa',
        });
        expect(bill.items).toHaveLength(2);

        // La pagina di pagamento: righe a prezzo pieno, sotto lo sconto, e
        // si paga il totale scontato.
        const pagina = await api().get(`/pay/${bill.share_token}`);
        expect(pagina.status).toBe(200);
        expect(pagina.body).toMatchObject({ bill: { total_cents: 20000 }, discount_cents: 2150, residual_cents: 20000, per_item_available: false });
        expect(await statoQr()).toMatchObject({ open: true, residual_cents: 20000 });

        // Il cameriere cambia lo sconto in cassa, poi lo toglie: il conto segue.
        sconti.set(8805, 31.5);
        await api().post(`/public/table/${qr}/conto/cassa`);
        expect(await conto(8805)).toMatchObject({ total_cents: 19000, discount_value: 31.5 });
        sconti.delete(8805);
        await api().post(`/public/table/${qr}/conto/cassa`);
        expect(await conto(8805)).toMatchObject({ total_cents: 22150, discount_type: null, discount_value: null, discount_reason: null });
        expect((await api().get(`/pay/${bill.share_token}`)).body.discount_cents).toBe(0);

        // Sconto rimesso; poi la lettura dello sconto non risponde e in cassa
        // arriva un caffè: le righe si riallineano, lo sconto resta quello noto.
        sconti.set(8805, 21.5);
        await api().post(`/public/table/${qr}/conto/cassa`);
        expect((await conto(8805)).total_cents).toBe(20000);
        scontoMuto = true;
        comande.get(8805).righe.push(riga(88053, 'Caffè', 1.5));
        await api().post(`/public/table/${qr}/conto/cassa`);
        expect(await conto(8805)).toMatchObject({ total_cents: 20150, discount_value: 21.5 });
        scontoMuto = false;

        // Pagato dal QR il totale scontato: la cassa chiude il tavolo, senza
        // differenza tra conto e comanda.
        bill = await conto(8805);
        await pagaTutto(bill.share_token, bill.id, 20150);
        await finoA(async () => (await db.query(
            `SELECT status FROM fiscal_documents WHERE table_bill_id = $1 AND provider = 'passepartout'`, [bill.id]
        )).rows[0]?.status === 'CONFIRMED', 'tavolo scontato chiuso in cassa');
        expect(chiamate.filter(c => c.op === 'chiudi').at(-1)!.params).toMatchObject({ idComanda: 8805, tipoPagamento: 'ESTERNO' });
        await aggiornaLettura();
        expect((await statoQr()).open).toBe(false);
    });

    it('sconto tolto in cassa dopo il pagamento dal QR: niente chiusura automatica', async () => {
        apriInCassa(8806, [riga(88061, 'Pizza', 10, 2)]);
        sconti.set(8806, 5);
        await aggiornaLettura();
        expect((await api().post(`/public/table/${qr}/conto/cassa`)).status).toBe(200);
        const bill = await conto(8806);
        expect(bill.total_cents).toBe(1500);

        // L'ospite paga 15 €; intanto in cassa lo sconto sparisce.
        sconti.delete(8806);
        const chiusurePrima = chiamate.filter(c => c.op === 'chiudi').length;
        await pagaTutto(bill.share_token, bill.id, 1500);
        await finoA(async () => (await db.query(
            `SELECT status FROM fiscal_documents WHERE table_bill_id = $1`, [bill.id]
        )).rows[0]?.status === 'FAILED', 'chiusura in cassa fermata');
        const doc = await db.query(`SELECT error FROM fiscal_documents WHERE table_bill_id = $1`, [bill.id]);
        expect(doc.rows[0].error).toContain('ancora da incassare');
        expect(chiamate.filter(c => c.op === 'chiudi').length).toBe(chiusurePrima);

        // Il tavolo lo chiude qualcuno in cassa: per i casi dopo, via dal tavolo.
        comande.get(8806).isPagato = true;
        await aggiornaLettura();
    });

    it('anche il conto importato dal personale prende lo sconto della cassa', async () => {
        const room = await db.query(`SELECT room_id FROM tables WHERE id = $1`, [tableId]);
        const t3 = await api().post('/tables').set(bearer(token)).send({
            name: 'PPQ3', shape: 'SQUARE', seats: 2, x: 240, y: 40, room_id: room.rows[0].room_id, status: 'FREE',
        });
        apriInCassa(8807, [riga(88071, 'Tagliata', 18, 2)], 'PPQ3');
        sconti.set(8807, 6);
        const r = await api().post(`/tables/${t3.body.id}/bill`).set(bearer(token)).send({ source: 'passepartout' });
        expect(r.status).toBe(201);
        expect(r.body.bill.total_cents).toBe(3000);
        expect(await conto(8807)).toMatchObject({ discount_type: 'AMOUNT', discount_value: 6, discount_reason: 'Sconto della cassa' });

        comande.get(8807).isPagato = true;
        await db.query(`UPDATE table_bills SET status = 'VOIDED' WHERE id = $1`, [r.body.bill.id]);
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

    it('comanda chiusa in cassa e una nuova sul tavolo: il conto vecchio lascia il posto (tavolo 29, 06/10)', async () => {
        // Un secondo tavolo, tutto suo.
        const room = await db.query(`SELECT room_id FROM tables WHERE id = $1`, [tableId]);
        const t2 = await api().post('/tables').set(bearer(token)).send({
            name: 'PPQ2', shape: 'SQUARE', seats: 4, x: 140, y: 40, room_id: room.rows[0].room_id, status: 'FREE',
        });
        await db.query(
            `INSERT INTO passepartout_tavoli (table_id, tenant_id, pp_sala, pp_tavolo, origine, confermato) VALUES ($1, 1, 'TETTOIA', 'PPQ2', 'manuale', true)`,
            [t2.body.id]
        );
        const tokens = await api().post('/tables/qr-tokens').set(bearer(token)).send({});
        const qr2 = tokens.body.find((r: any) => r.table_id === t2.body.id).public_token;

        apriInCassa(8810, [riga(88101, 'Antipasto', 1, 3)], 'PPQ2');
        await aggiornaLettura();
        expect((await api().post(`/public/table/${qr2}/conto/cassa`)).status).toBe(200);
        const vecchio = await conto(8810);
        expect(vecchio.status).toBe('OPEN');

        // In cassa la comanda si chiude (pagata lì) e il tavolo si riapre.
        comande.get(8810).isPagato = true;
        apriInCassa(8811, [riga(88111, 'Coperto', 1, 2)], 'PPQ2');
        const tocco = await api().post(`/public/table/${qr2}/conto/cassa`);
        expect(tocco.status).toBe(200);
        expect((await conto(8810)).status).toBe('VOIDED');
        const nuovo = await conto(8811);
        expect(nuovo).toMatchObject({ status: 'OPEN', total_cents: 200 });
        expect(tocco.body.url).toMatch(new RegExp(`/pay/${nuovo.share_token}$`));

        // Chiusa in cassa anche la nuova, senza che nessuno paghi dal QR:
        // alla lettura dopo il conto si annulla da solo.
        comande.get(8811).isPagato = true;
        await aggiornaLettura();
        await finoA(async () => (await conto(8811)).status === 'VOIDED', 'conto del QR annullato con la comanda chiusa');
        const pay = (await api().get(`/public/table/${qr2}/conto`)).body.pay;
        expect(pay.open).toBe(false);
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

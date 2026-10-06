import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { Client } from 'pg';
import { io as ioClient, type Socket } from 'socket.io-client';
import { api, bearer, ownerToken } from './helpers';
import { righeSpecchio } from '../../services/passepartoutSpecchio';
import { specchioComanda, SPECCHIO_TAVOLO_OCCUPATO } from '../../services/passepartoutService';

// Fase 4, «comanda specchio»: i conti chiusi nel CRM copiati in cassa sul
// tavolo scelto, come proforma col tipo esterno, per le statistiche della
// cassa. Tre livelli: le righe (sconto e coperti), la scrittura in cassa
// contro una cassa SOAP finta, il giro completo con un agente finto.

describe('righe della comanda specchio', () => {
    const somma = (r: { pezzi: number; prezzoCents: number }[]) => r.reduce((s, x) => s + x.pezzi * x.prezzoCents, 0);

    it('senza sconto: piatti e coperto del CRM così come sono', () => {
        const { righe, coperti } = righeSpecchio([
            { kind: 'DISH', qty: 2, unitCents: 1250, nome: 'Tagliatelle', idArticolo: 367 },
            { kind: 'COVER', qty: 2, unitCents: 250, nome: 'Coperto', idArticolo: null },
        ], 3000, 2);
        expect(coperti).toBe(2);
        expect(righe).toEqual([
            { idArticolo: 367, descrizione: 'Tagliatelle', pezzi: 2, prezzoCents: 1250 },
            { idArticolo: null, descrizione: 'Coperto', pezzi: 2, prezzoCents: 250, coperto: true },
        ]);
    });

    it('con lo sconto la somma torna al centesimo e i pezzi restano quelli', () => {
        const { righe } = righeSpecchio([
            { kind: 'DISH', qty: 3, unitCents: 1000, nome: 'Pizza', idArticolo: 10 },
            { kind: 'DISH', qty: 1, unitCents: 999, nome: 'Vino', idArticolo: 11 },
        ], 3599, 0);
        expect(somma(righe)).toBe(3599);
        expect(righe.filter((r) => r.idArticolo === 10).reduce((s, r) => s + r.pezzi, 0)).toBe(3);
        expect(righe.filter((r) => r.idArticolo === 11).reduce((s, r) => s + r.pezzi, 0)).toBe(1);
    });

    it('senza coperto nel CRM: riga coperto a zero, o la cassa ne aggiunge una sua', () => {
        const { righe, coperti } = righeSpecchio([
            { kind: 'DISH', qty: 1, unitCents: 800, nome: 'Insalata', idArticolo: null },
        ], 800, 4);
        expect(coperti).toBe(4);
        expect(righe[0]).toEqual({ idArticolo: null, descrizione: 'Coperto', pezzi: 4, prezzoCents: 0, coperto: true });
        expect(somma(righe)).toBe(800);
    });
});

describe('comanda specchio contro la cassa', () => {
    let server: http.Server;
    const chiamate: Array<{ op: string; body: string }> = [];
    let comandeGiorno: string[] = [];
    let sulTavolo: string | null = null;

    const busta = (op: string, risultato: string) =>
        `<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body>` +
        `<${op}Response xmlns="http://tempuri.org/"><${op}Result xmlns:a="x" xmlns:i="http://www.w3.org/2001/XMLSchema-instance">${risultato}</${op}Result></${op}Response></s:Body></s:Envelope>`;
    const nil = (op: string) =>
        `<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body><${op}Response xmlns="http://tempuri.org/">` +
        `<${op}Result i:nil="true" xmlns:i="http://www.w3.org/2001/XMLSchema-instance"/></${op}Response></s:Body></s:Envelope>`;
    const comanda = (id: number, note: string, pagata: boolean) =>
        `<a:IdGestionale>${id}</a:IdGestionale><a:IsPagato>${pagata}</a:IsPagato><a:Note>${note}</a:Note><a:Sala>DENTRO</a:Sala><a:Tavolo>29</a:Tavolo>` +
        `<a:Righe><a:PMBRigaComanda><a:Descrizione>Coperto</a:Descrizione><a:IdGestionale>1</a:IdGestionale><a:Pezzi>2</a:Pezzi><a:Prezzo>2.50</a:Prezzo><a:Totale>5.00</a:Totale></a:PMBRigaComanda>` +
        `<a:PMBRigaComanda><a:Descrizione>ACQUA PICCOLA</a:Descrizione><a:IdGestionale>2</a:IdGestionale><a:Pezzi>1</a:Pezzi><a:Prezzo>1.20</a:Prezzo><a:Totale>1.20</a:Totale></a:PMBRigaComanda></a:Righe>`;
    const ultima = (op: string) => chiamate.filter((c) => c.op === op).pop();
    const parametri = (over: Partial<Parameters<typeof specchioComanda>[0]> = {}) => ({
        tag: 'sympotia-conto:501', sala: 'DENTRO', tavolo: '29', coperti: 2,
        righe: [
            { idArticolo: null, descrizione: 'Coperto', pezzi: 2, prezzoCents: 250, coperto: true },
            { idArticolo: 367, descrizione: 'Acqua', pezzi: 1, prezzoCents: 120 },
        ],
        idArticoloGenerico: null, tipoPagamento: 'ESTERNO', totaleCents: 620,
        ...over,
    });

    beforeAll(async () => {
        server = http.createServer((req, res) => {
            let body = '';
            req.on('data', (d) => { body += d; });
            req.on('end', () => {
                const op = String(req.headers.soapaction ?? '').replace(/"/g, '').split('/').pop() ?? '';
                chiamate.push({ op, body });
                const ok = (xml: string) => { res.writeHead(200, { 'Content-Type': 'text/xml' }); res.end(xml); };
                if (op === 'GetComandeGiorno') return ok(busta(op, comandeGiorno.map((c) => `<a:ContrattoComanda>${c}</a:ContrattoComanda>`).join('')));
                if (op === 'GetComandaTavolo') return ok(sulTavolo ? busta(op, sulTavolo) : nil(op));
                if (op === 'GetArticoli') {
                    return ok(busta(op,
                        `<a:ContrattoArticolo><a:Codice>Coperti</a:Codice><a:Descrizione>Coperti</a:Descrizione><a:IdGestionale>1</a:IdGestionale><a:IsAttivo>true</a:IsAttivo></a:ContrattoArticolo>` +
                        `<a:ContrattoArticolo><a:Codice>ACQUA PICCOLA</a:Codice><a:Descrizione>ACQUA PICCOLA</a:Descrizione><a:IdGestionale>367</a:IdGestionale><a:IsAttivo>true</a:IsAttivo></a:ContrattoArticolo>`));
                }
                if (op === 'PutComanda') return ok(busta(op, `<a:IdGestionale>90001</a:IdGestionale>`));
                if (op === 'GetComanda') return ok(busta(op, comanda(90001, 'Conto Sympotia sympotia-conto:501', false)));
                if (op === 'ContoComanda') return ok(nil(op));
                if (op === 'GetContiGiorno') {
                    return ok(busta(op, `<a:ContrattoConto><a:IdComanda>90001</a:IdComanda><a:IdGestionale>92001</a:IdGestionale><a:Sospeso>0</a:Sospeso>` +
                        `<a:StatoEnum>Pagato</a:StatoEnum><a:TotaleDaPagare>6.20</a:TotaleDaPagare><a:TotalePagato>6.20</a:TotalePagato></a:ContrattoConto>`));
                }
                ok(`<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body><s:Fault><faultstring>op non prevista: ${op}</faultstring></s:Fault></s:Body></s:Envelope>`);
            });
        });
        await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
        process.env.PASSEPARTOUT_WS_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}/AdapterWS`;
        process.env.PASSEPARTOUT_WS_USER = 'utente-prova';
        process.env.PASSEPARTOUT_WS_PASSWORD = 'segreto-prova';
    });

    afterAll(async () => {
        delete process.env.PASSEPARTOUT_WS_URL;
        delete process.env.PASSEPARTOUT_WS_USER;
        delete process.env.PASSEPARTOUT_WS_PASSWORD;
        await new Promise<void>((resolve) => server.close(() => resolve()));
    });

    beforeEach(() => {
        chiamate.length = 0;
        comandeGiorno = [];
        sulTavolo = null;
    });

    it('scrive la comanda senza invio, col nostro coperto, e la chiude proforma col tipo esterno', async () => {
        const esito = await specchioComanda(parametri());
        expect(esito).toMatchObject({ idComanda: 90001, idConto: 92001, stato: 'Pagato', totaleCassaCents: 620, ripresa: false, avviso: null });
        const put = ultima('PutComanda')!.body;
        expect(put).toContain('<c:Coperti>2</c:Coperti>');
        expect(put).toContain('<c:Note>Conto Sympotia sympotia-conto:501</c:Note>');
        expect(put).toMatch(/<c:Articolo>Coperti<\/c:Articolo><c:Descrizione>Coperto<\/c:Descrizione><c:Pezzi>2<\/c:Pezzi><c:Prezzo>2\.50<\/c:Prezzo><c:TipoEnum>Coperto<\/c:TipoEnum>/);
        expect(put).toContain('<c:Articolo>ACQUA PICCOLA</c:Articolo>');
        expect((put.match(/<c:Tool_EseguiInvio>false<\/c:Tool_EseguiInvio>/g) ?? []).length).toBe(2);
        expect(put).toContain('<c:Sala>DENTRO</c:Sala><c:Tavolo>29</c:Tavolo>');
        const conto = ultima('ContoComanda')!.body;
        expect(conto).toContain('<noInvio>true</noInvio>');
        expect(conto).toContain('<tipoDoc>Proforma</tipoDoc>');
        expect(conto).toContain('<tipoPag>ESTERNO</tipoPag>');
        // Mai in produzione: niente stampe in cucina.
        expect(ultima('InviaProduzioneComanda')).toBeUndefined();
    });

    it('un nuovo tentativo ritrova la comanda già chiusa e non ne scrive un\'altra', async () => {
        comandeGiorno = [comanda(90001, 'Conto Sympotia sympotia-conto:501', true)];
        const esito = await specchioComanda(parametri());
        expect(esito).toMatchObject({ idComanda: 90001, ripresa: true });
        expect(ultima('PutComanda')).toBeUndefined();
        expect(ultima('ContoComanda')).toBeUndefined();
    });

    it('con un tavolo vero aperto sul tavolo specchio non scrive niente', async () => {
        sulTavolo = comanda(78600, 'Tavolo di un cliente', false);
        await expect(specchioComanda(parametri())).rejects.toThrow(SPECCHIO_TAVOLO_OCCUPATO);
        expect(ultima('PutComanda')).toBeUndefined();
    });

    it('un piatto senza articolo in cassa e senza generico: lo dice, senza scrivere', async () => {
        await expect(specchioComanda(parametri({
            tag: 'sympotia-conto:502',
            righe: [{ idArticolo: null, descrizione: 'Piatto del CRM', pezzi: 1, prezzoCents: 900 }],
        }))).rejects.toThrow(/non ha un articolo in cassa/);
        expect(ultima('PutComanda')).toBeUndefined();
    });
});

describe('conti del CRM in cassa, dal conto chiuso al giro', () => {
    const AGENT_TOKEN = 'test-pp-agent-token';
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    let token: string;
    let db: Client;
    let socket: Socket | null = null;
    let flagsPrima: Record<string, boolean> = {};
    let tableId: number;
    let dishId: number;
    const ricevute: any[] = [];
    let rispostaAgente: (p: any) => { ok: boolean; result?: unknown; error?: string; kind?: string } = () => ({ ok: false, error: 'non impostata' });

    const finoA = async (cond: () => Promise<boolean>, descr: string, timeoutMs = 10_000) => {
        const deadline = Date.now() + timeoutMs;
        for (;;) {
            if (await cond()) return;
            if (Date.now() > deadline) throw new Error(`Timeout: ${descr}`);
            await sleep(150);
        }
    };
    /** Un conto del CRM con una comanda vera, chiuso in contanti. */
    const contoChiuso = async (qty: number) => {
        const order = await api().post('/orders').set(bearer(token)).send({ table_id: tableId });
        expect(order.status).toBe(201);
        const orderId = order.body.order.id as number;
        expect((await api().post(`/orders/${orderId}/items`).set(bearer(token)).send({ items: [{ dish_id: dishId, qty }] })).status).toBe(201);
        expect((await api().post(`/orders/${orderId}/send`).set(bearer(token)).send({})).status).toBe(200);
        const closed = await api().post(`/orders/${orderId}/close`).set(bearer(token)).send({});
        expect(closed.status).toBe(200);
        const bill = closed.body.bill;
        const res = await api().post(`/bills/${bill.id}/close`).set(bearer(token))
            .send({ payments: [{ method: 'CONTANTI', amount_cents: bill.total_cents }] });
        expect(res.status).toBe(200);
        expect(res.body.status).toBe('CLOSED');
        return bill as { id: number; total_cents: number };
    };
    const riga = async (billId: number) => (await db.query(
        `SELECT stato, attempts, pp_comanda_id, pp_conto_id, totale_cents, totale_cassa_cents, error
           FROM passepartout_specchio WHERE tenant_id = 1 AND table_bill_id = $1`, [billId]
    )).rows[0];

    beforeAll(async () => {
        token = await ownerToken();
        db = new Client({ connectionString: process.env.DATABASE_URL || 'postgresql://localhost/ristotest_api' });
        await db.connect();
        await api().put('/settings/entitlements').set(bearer(token)).send({ passepartout: true });
        const prima = await api().get('/settings/features').set(bearer(token));
        flagsPrima = {
            table_orders_enabled: prima.body.table_orders_enabled === true,
            pay_at_table_enabled: prima.body.pay_at_table_enabled === true,
        };
        await api().put('/settings/features').set(bearer(token)).send({ table_orders_enabled: true, pay_at_table_enabled: true });

        const room = await api().post('/rooms').set(bearer(token)).send({ name: 'Sala Specchio', width: 600, height: 400 });
        const table = await api().post('/tables').set(bearer(token)).send({
            name: 'SPC1', shape: 'SQUARE', seats: 4, x: 40, y: 40, room_id: room.body.id, status: 'FREE',
        });
        tableId = table.body.id;
        const dish = await api().post('/dishes').set(bearer(token)).send({
            name: 'Tagliatelle Specchio', description: null, price: 12.5, category: 'PRIMI', allergens: null,
        });
        expect(dish.status).toBe(201);
        dishId = dish.body.id;
        // Un piatto importato dalla cassa: porta l'id dell'articolo.
        await db.query(`UPDATE dishes SET external_ref = 'pp:articolo:367' WHERE id = $1`, [dishId]);

        socket = ioClient(`${process.env.TEST_BASE_URL}/pp-agent`, {
            auth: { token: AGENT_TOKEN }, transports: ['websocket'], reconnection: false,
        });
        socket.on('pp:call', (payload: any, ack: (r: unknown) => void) => {
            if (payload?.op === 'specchio') {
                ricevute.push(payload.params);
                return ack(rispostaAgente(payload.params));
            }
            ack({ ok: false, error: `op non prevista: ${payload?.op}`, kind: 'agent' });
        });
        await new Promise<void>((resolve, reject) => {
            socket!.on('connect', () => resolve());
            socket!.on('connect_error', reject);
        });
        socket.emit('agent:hello', { hostname: 'agente-specchio', capabilities: ['specchio'] });
        await finoA(async () => ((await api().get('/passepartout/status').set(bearer(token))).body.capabilities ?? []).includes('specchio'),
            'agente annunciato');
    });

    afterAll(async () => {
        await api().put('/passepartout/specchio/config').set(bearer(token)).send({ mode: 'off' });
        await api().put('/settings/features').set(bearer(token)).send(flagsPrima);
        socket?.close();
        await db.query(`DELETE FROM passepartout_specchio WHERE tenant_id = 1`);
        await db.end();
    });

    it('si accende solo col tavolo specchio scelto', async () => {
        await db.query(`UPDATE passepartout_config SET specchio_sala = NULL, specchio_tavolo = NULL WHERE tenant_id = 1`);
        const senza = await api().put('/passepartout/specchio/config').set(bearer(token)).send({ mode: 'statistiche' });
        expect(senza.status).toBe(409);
        expect(senza.body.error).toBe('tavolo_mancante');
        const ok = await api().put('/passepartout/specchio/config').set(bearer(token)).send({ mode: 'statistiche', sala: 'DENTRO', tavolo: '29' });
        expect(ok.status).toBe(200);
        const cfg = await api().get('/passepartout/specchio/config').set(bearer(token));
        expect(cfg.body).toMatchObject({ mode: 'statistiche', sala: 'DENTRO', tavolo: '29', tipo_pagamento: 'ESTERNO', agente: { aggiornato: true } });
        expect(cfg.body.piatti).toEqual(expect.arrayContaining([{ pp_id: 367, name: 'Tagliatelle Specchio' }]));
    });

    it('un conto chiuso nel CRM va in cassa sul tavolo specchio, ed è confermato', async () => {
        rispostaAgente = (p) => ({ ok: true, result: { idComanda: 91001, idConto: 92001, stato: 'Pagato', totaleCassaCents: p.totaleCents, ripresa: false, avviso: null } });
        const bill = await contoChiuso(2);
        await finoA(async () => (await riga(bill.id))?.stato === 'CONFIRMED', 'comanda specchio confermata');
        const p = ricevute.find((x) => x.tag === `sympotia-conto:${bill.id}`);
        expect(p).toMatchObject({ sala: 'DENTRO', tavolo: '29', tipoPagamento: 'ESTERNO', totaleCents: bill.total_cents });
        expect(p.righe).toEqual(expect.arrayContaining([expect.objectContaining({ idArticolo: 367, pezzi: 2, prezzoCents: 1250 })]));
        expect(p.righe.reduce((s: number, r: any) => s + r.pezzi * r.prezzoCents, 0)).toBe(bill.total_cents);
        expect(await riga(bill.id)).toMatchObject({ pp_comanda_id: 91001, pp_conto_id: 92001, totale_cents: bill.total_cents, error: null });
    });

    it('tavolo specchio occupato: il conto aspetta in coda senza consumare tentativi', async () => {
        rispostaAgente = () => ({ ok: false, error: 'tavolo_specchio_occupato: il tavolo 29 ha una comanda aperta in cassa', kind: 'gestionale' });
        const bill = await contoChiuso(1);
        await finoA(async () => ((await riga(bill.id))?.error ?? '').includes('occupato'), 'attesa per tavolo occupato');
        expect(await riga(bill.id)).toMatchObject({ stato: 'PENDING', attempts: 0 });
    });

    it('«Riprova» rimette in coda i conti falliti', async () => {
        rispostaAgente = (p) => ({ ok: true, result: { idComanda: 91002, idConto: 92002, stato: 'Pagato', totaleCassaCents: p.totaleCents, ripresa: false, avviso: null } });
        const bill = await contoChiuso(1);
        await finoA(async () => (await riga(bill.id))?.stato === 'CONFIRMED', 'confermato');
        await db.query(`UPDATE passepartout_specchio SET stato = 'FAILED', error = 'prova' WHERE tenant_id = 1 AND table_bill_id = $1`, [bill.id]);
        const r = await api().post('/passepartout/specchio/riprova').set(bearer(token));
        expect(r.status).toBe(200);
        expect(r.body.rimessi).toBeGreaterThanOrEqual(1);
        await finoA(async () => (await riga(bill.id))?.stato === 'CONFIRMED', 'riconfermato dopo «Riprova»');
    });

    it('spento, un conto chiuso non va in coda', async () => {
        await api().put('/passepartout/specchio/config').set(bearer(token)).send({ mode: 'off' });
        const bill = await contoChiuso(1);
        await sleep(300);
        expect(await riga(bill.id)).toBeUndefined();
    });
});

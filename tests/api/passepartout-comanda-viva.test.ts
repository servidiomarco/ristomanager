import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { Client } from 'pg';
import { io as ioClient, type Socket } from 'socket.io-client';
import { api, bearer, ownerToken } from './helpers';
import { differenza, righeDesiderate, uscitaPerCassa, usciteDaInviare, variantiPerCassa } from '../../services/passepartoutComandeVive';
import { PassepartoutError, getComanda, scriviComandaViva, type EsitoComandaViva, type MemoriaComandaViva } from '../../services/passepartoutService';

// Comanda viva, fase 2: gli ordini del CRM nella comanda in cassa del
// tavolo vero. Due livelli: le righe (cosa va in cassa e la differenza con
// quello già scritto), e il percorso intero — rotte delle comande, giro sul
// server, un agente finto che usa la scrittura vera dell'agente, e una cassa
// SOAP finta che ricorda comande e righe come la cassa delle prove del 07 e
// 08/10 (docs/passepartout-comanda-viva-prove.md).

const AGENT_TOKEN = 'test-pp-agent-token';
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

describe('righe della comanda viva', () => {
    const riga = (over: Record<string, unknown>) => ({
        id: 1, line_kind: 'DISH', qty: 1, unit_price_cents: 1000, modifiers: null, note: null,
        course_no: 1, name_snapshot: 'Piatto', weight_grams: null, external_ref: null, ...over,
    });

    it('uscite: le portate restano, il Bar va sulla 1 come in cassa, i Dolci dopo', () => {
        expect(uscitaPerCassa(1)).toBe(1);
        expect(uscitaPerCassa(3)).toBe(3);
        expect(uscitaPerCassa(99)).toBe(1);
        expect(uscitaPerCassa(98)).toBe(7);
    });

    it('varianti firmate e nota come varianti libere', () => {
        expect(variantiPerCassa([{ name: '+ Bufala' }, { name: 'Senza cipolla' }, { name: 'Molta Nduja' }, { name: 'Media' }], 'ben cotta'))
            .toEqual([
                { descrizione: 'Bufala', inAggiunta: true },
                { descrizione: 'cipolla', inAggiunta: false },
                { descrizione: 'Molta Nduja', inAggiunta: true },
                { descrizione: 'Media', inAggiunta: true },
                { descrizione: 'ben cotta', inAggiunta: true },
            ]);
    });

    it('il prezzo delle varianti sta nella riga, l\'articolo viene dal piatto importato', () => {
        const [d] = righeDesiderate([riga({
            id: 7, qty: 2, unit_price_cents: 1300, modifiers: [{ name: '+ Bufala', price_delta_cents: 200 }],
            external_ref: 'pp:articolo:11', course_no: 2,
        })], 0, false);
        expect(d).toMatchObject({ chiave: 'oi:7', idArticolo: 11, pezzi: 2, prezzoCents: 1500, uscita: 2 });
    });

    it('coperto: quello del CRM, o a zero coi coperti; mai sul tavolo del palmare', () => {
        const conCoperto = righeDesiderate([riga({ id: 2, line_kind: 'COVER', qty: 3, unit_price_cents: 250, name_snapshot: 'Coperto' })], 3, false);
        expect(conCoperto[0]).toMatchObject({ chiave: 'coperto', coperto: true, pezzi: 3, prezzoCents: 250, soloComandaNostra: true });
        const senza = righeDesiderate([riga({ id: 3 })], 4, false);
        expect(senza[0]).toMatchObject({ chiave: 'coperto', pezzi: 4, prezzoCents: 0 });
        const palmare = righeDesiderate([
            riga({ id: 2, line_kind: 'COVER', qty: 3, unit_price_cents: 250 }),
            riga({ id: 4, line_kind: 'SERVICE', unit_price_cents: 300, name_snapshot: 'Servizio 10%' }),
            riga({ id: 5 }),
        ], 3, true);
        expect(palmare.map((r) => r.chiave)).toEqual(['oi:5']);
    });

    it('la differenza: nuove, cambiate nel CRM, da togliere; le sparite in cassa no', () => {
        const desiderate = righeDesiderate([
            riga({ id: 1, qty: 2 }), riga({ id: 2 }), riga({ id: 3, unit_price_cents: 900 }), riga({ id: 6 }),
        ], 0, false);
        const out = differenza(desiderate, [
            { chiave: 'oi:1', pp_riga_id: 101, pezzi_scritti: 1, prezzo_cents_scritto: 1000, sparita: false },
            { chiave: 'oi:2', pp_riga_id: 102, pezzi_scritti: 1, prezzo_cents_scritto: 1000, sparita: false },
            { chiave: 'oi:3', pp_riga_id: 103, pezzi_scritti: 1, prezzo_cents_scritto: 1000, sparita: false },
            { chiave: 'oi:4', pp_riga_id: 104, pezzi_scritti: 1, prezzo_cents_scritto: 1000, sparita: false },
            { chiave: 'oi:5', pp_riga_id: 105, pezzi_scritti: 1, prezzo_cents_scritto: 1000, sparita: true },
            { chiave: 'oi:6', pp_riga_id: 106, pezzi_scritti: 1, prezzo_cents_scritto: 1000, sparita: true },
        ]);
        const per = Object.fromEntries(out.map((r) => [r.chiave, r]));
        expect(Object.keys(per).sort()).toEqual(['oi:1', 'oi:3', 'oi:4']);
        expect(per['oi:1']).toMatchObject({ idRiga: 101, pezzi: 2 });
        expect(per['oi:3']).toMatchObject({ idRiga: 103, prezzoCents: 900 });
        expect(per['oi:4']).toMatchObject({ idRiga: 104, cancella: true });
    });

    it('conto della cassa: il coperto ha il numero dei coperti e il prezzo della cassa', () => {
        const [cop] = righeDesiderate([riga({ id: 2, line_kind: 'COVER', qty: 3, unit_price_cents: 250 })], 3, false, { copertoDellaCassa: true });
        expect(cop).toMatchObject({ chiave: 'coperto', coperto: true, pezzi: 3, prezzoCents: 0, prezzoDellaCassa: true });
        const [senza] = righeDesiderate([riga({ id: 3 })], 2, false, { copertoDellaCassa: true });
        expect(senza).toMatchObject({ chiave: 'coperto', pezzi: 2, prezzoDellaCassa: true });
        // Sul tavolo del palmare il coperto resta della cassa e il CRM non lo scrive.
        expect(righeDesiderate([riga({ id: 3 })], 2, true, { copertoDellaCassa: true }).map((r) => r.chiave)).toEqual(['oi:3']);
    });

    it('chi stampa: le uscite lanciate le manda la cassa; quella con righe stampate dal CRM resta del CRM', () => {
        const lanciata = '2026-10-08T20:00:00Z';
        const desiderate = righeDesiderate([
            riga({ id: 1, course_no: 1, fired_at: lanciata }),
            riga({ id: 2, course_no: 99, fired_at: lanciata }),
            riga({ id: 3, course_no: 2, fired_at: lanciata }),
            riga({ id: 4, course_no: 2, fired_at: lanciata }),
            riga({ id: 5, course_no: 3 }),
            riga({ id: 6, course_no: 4, fired_at: lanciata }),
        ], 0, false);
        const scritta = { pp_riga_id: 100, pezzi_scritti: 1, prezzo_cents_scritto: 1000, sparita: false };
        expect(usciteDaInviare(desiderate, [
            { chiave: 'oi:3', ...scritta, stampata_crm: true },
            { chiave: 'oi:6', ...scritta, inviata: true },
        ])).toEqual({
            // Il Bar va sull'uscita 1 della cassa, come le portate della 1.
            cassa: [1],
            // La 2 ha già una riga stampata dal CRM: il resto lo stampa il CRM.
            crm: [4],
        });
        // Non lanciata, o già mandata: niente da mandare.
        expect(usciteDaInviare(righeDesiderate([riga({ id: 5, course_no: 3 })], 0, false), [])).toEqual({ cassa: [], crm: [] });
    });
});

// ---------------------------------------------------------------------------
// La cassa finta: comande e righe in memoria, PutComanda come la cassa vera
// (righe con id = cambiate, senza id = aggiunte, DaCancellare = tolte se mai
// mandate, «Cancellato» se mandate).
// ---------------------------------------------------------------------------
interface RigaFinta { id: number; articolo: string; descrizione: string; pezzi: number; prezzo: number; uscita: number; stato: string; tipo: string; varianti: string[] }
interface ComandaFinta { id: number; note: string; sala: string; tavolo: string; coperti: number; pagata: boolean; righe: RigaFinta[] }

const CATALOGO = [
    { id: 1, codice: 'Coperti', descrizione: 'Coperti', prezzo: 3 },
    { id: 11, codice: 'Tagliatelle Silana', descrizione: 'Tagliatelle Silana', prezzo: 13 },
    { id: 12, codice: 'Gnocchi Silani', descrizione: 'Gnocchi Silani', prezzo: 12 },
    { id: 500, codice: 'VARIE', descrizione: 'Varie', prezzo: 0 },
];

function cassaFinta() {
    const comande = new Map<number, ComandaFinta>();
    let prossima = 80_000;
    let prossimaRiga = 900_000;
    const put: string[] = [];
    // Gli invii in produzione (InviaProduzioneComanda), e i tavoli su cui la
    // cassa rifiuta la scrittura (come la comanda vecchia della demo).
    const invii: Array<{ id: number; uscite: number[] }> = [];
    const rifiuta = new Set<string>();
    const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const un = (s: string) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&');
    const campo = (xml: string, nome: string) => {
        const m = new RegExp(`<c:${nome}>([^<]*)</c:${nome}>`).exec(xml);
        return m ? un(m[1]) : null;
    };
    const comandaXml = (c: ComandaFinta) =>
        `<a:Coperti>${c.coperti}</a:Coperti><a:IdGestionale>${c.id}</a:IdGestionale><a:IsPagato>${c.pagata}</a:IsPagato>` +
        `<a:Note>${esc(c.note)}</a:Note><a:Righe>` + c.righe.map((r) =>
            `<a:PMBRigaComanda><a:Articolo>${esc(r.articolo)}</a:Articolo><a:Descrizione>${esc(r.descrizione)}</a:Descrizione>` +
            `<a:IdGestionale>${r.id}</a:IdGestionale><a:Pezzi>${r.pezzi}</a:Pezzi><a:Prezzo>${r.prezzo.toFixed(4)}</a:Prezzo>` +
            `<a:StatoEnum>${r.stato}</a:StatoEnum><a:TipoEnum>${r.tipo}</a:TipoEnum><a:Totale>${(r.prezzo * r.pezzi).toFixed(4)}</a:Totale>` +
            `<a:Uscita>${r.uscita}</a:Uscita></a:PMBRigaComanda>`).join('') +
        `</a:Righe><a:Sala>${esc(c.sala)}</a:Sala><a:Tavolo>${esc(c.tavolo)}</a:Tavolo>`;

    function putComanda(body: string): ComandaFinta {
        put.push(body);
        const corpo = /<comanda[^>]*>([\s\S]*)<\/comanda>/.exec(body)![1];
        const [testa, resto = ''] = corpo.split('<c:Righe>');
        const [righeXml, coda = ''] = resto.split('</c:Righe>');
        const id = campo(testa, 'IdGestionale');
        let c: ComandaFinta;
        if (id) {
            c = comande.get(Number(id))!;
        } else {
            c = {
                id: ++prossima, note: campo(testa, 'Note') ?? '', sala: campo(coda, 'Sala') ?? '', tavolo: campo(coda, 'Tavolo') ?? '',
                coperti: Number(campo(testa, 'Coperti') ?? 0), pagata: false, righe: [],
            };
            comande.set(c.id, c);
        }
        for (const xml of righeXml.match(/<c:PMBRigaComanda>[\s\S]*?<\/c:PMBRigaComanda>/g) ?? []) {
            const varianti = [...xml.matchAll(/<c:PMBRigaVariante><c:Descrizione>([^<]*)<\/c:Descrizione><c:InAggiunta>(true|false)<\/c:InAggiunta>/g)]
                .map((m) => `${m[2] === 'true' ? '+' : '-'}${un(m[1])}`);
            const r = xml.replace(/<c:Varianti>[\s\S]*<\/c:Varianti>/, '');
            const idRiga = campo(r, 'IdGestionale');
            if (idRiga) {
                const esistente = c.righe.find((x) => x.id === Number(idRiga))!;
                if (campo(r, 'DaCancellare') === 'true') {
                    if (esistente.stato === 'Nuovo') c.righe = c.righe.filter((x) => x !== esistente);
                    else esistente.stato = 'Cancellato';
                } else {
                    esistente.pezzi = Number(campo(r, 'Pezzi'));
                    // Senza prezzo resta quello che c'è, come la cassa vera.
                    if (campo(r, 'Prezzo') != null) esistente.prezzo = Number(campo(r, 'Prezzo'));
                }
                continue;
            }
            const articolo = campo(r, 'Articolo') ?? '';
            const coperto = campo(r, 'TipoEnum') === 'Coperto';
            c.righe.push({
                id: ++prossimaRiga, articolo, descrizione: campo(r, 'Descrizione') ?? CATALOGO.find((a) => a.codice === articolo)?.descrizione ?? articolo,
                // Senza prezzo la cassa prende quello del suo listino (prova del 07/10).
                pezzi: Number(campo(r, 'Pezzi')),
                prezzo: campo(r, 'Prezzo') != null ? Number(campo(r, 'Prezzo')) : (CATALOGO.find((a) => a.codice === articolo)?.prezzo ?? 0),
                uscita: coperto ? 0 : Number(campo(r, 'Uscita') ?? 1),
                stato: 'Nuovo', tipo: coperto ? 'Coperto' : 'Semplice', varianti,
            });
        }
        return c;
    }

    const busta = (op: string, risultato: string) =>
        `<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body>` +
        `<${op}Response xmlns="http://tempuri.org/"><${op}Result xmlns:a="x" xmlns:i="http://www.w3.org/2001/XMLSchema-instance">${risultato}</${op}Result></${op}Response></s:Body></s:Envelope>`;
    const nil = (op: string) =>
        `<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body><${op}Response xmlns="http://tempuri.org/">` +
        `<${op}Result i:nil="true" xmlns:i="http://www.w3.org/2001/XMLSchema-instance"/></${op}Response></s:Body></s:Envelope>`;

    const server = http.createServer((req, res) => {
        let body = '';
        req.on('data', (d) => { body += d; });
        req.on('end', () => {
            const op = String(req.headers.soapaction ?? '').replace(/"/g, '').split('/').pop() ?? '';
            const ok = (xml: string) => { res.writeHead(200, { 'Content-Type': 'text/xml' }); res.end(xml); };
            if (op === 'GetArticoli') {
                return ok(busta(op, CATALOGO.map((a) =>
                    `<a:ContrattoArticolo><a:Codice>${a.codice}</a:Codice><a:Descrizione>${a.descrizione}</a:Descrizione>` +
                    `<a:IdGestionale>${a.id}</a:IdGestionale><a:IsAttivo>true</a:IsAttivo><a:Prezzo>${a.prezzo}</a:Prezzo></a:ContrattoArticolo>`).join('')));
            }
            if (op === 'GetComanda') {
                const c = comande.get(Number(/<idGestionale>(\d+)<\/idGestionale>/.exec(body)?.[1]));
                return ok(c ? busta(op, comandaXml(c)) : nil(op));
            }
            if (op === 'GetComandaTavolo') {
                const tavolo = /<tavolo>([^<]*)<\/tavolo>/.exec(body)?.[1] ?? '';
                const c = [...comande.values()].find((x) => x.tavolo === tavolo && !x.pagata);
                return ok(c ? busta(op, comandaXml(c)) : nil(op));
            }
            if (op === 'PutComanda') {
                const tavolo = /<c:Tavolo>([^<]*)<\/c:Tavolo>/.exec(body)?.[1];
                if (tavolo && rifiuta.has(tavolo)) {
                    return ok(`<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body><s:Fault><faultstring>Errore comanda: System.NullReferenceException</faultstring></s:Fault></s:Body></s:Envelope>`);
                }
                return ok(busta(op, comandaXml(putComanda(body))));
            }
            if (op === 'InviaProduzioneComanda') {
                const id = Number(/<idComanda>(\d+)<\/idComanda>/.exec(body)?.[1]);
                const uscite = [...body.matchAll(/<a:int>(\d+)<\/a:int>/g)].map((m) => Number(m[1]));
                invii.push({ id, uscite });
                for (const r of comande.get(id)?.righe ?? []) {
                    if (r.stato === 'Nuovo' && r.tipo !== 'Coperto' && (uscite.length === 0 || uscite.includes(r.uscita))) r.stato = 'InProduzione';
                }
                return ok(nil(op));
            }
            ok(`<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body><s:Fault><faultstring>op non prevista: ${op}</faultstring></s:Fault></s:Body></s:Envelope>`);
        });
    });
    return { server, comande, put, invii, rifiuta, sulTavolo: (t: string) => [...comande.values()].find((c) => c.tavolo === t && !c.pagata) ?? null };
}

describe('ordini del CRM nella comanda in cassa', () => {
    let token: string;
    let db: Client;
    let socket: Socket | null = null;
    const cassa = cassaFinta();
    const tavoli: Record<string, number> = {};
    const ordini: number[] = [];
    let piattoCassa: number;
    let piattoCrm: number;
    let comandePrima = false;
    // La memoria dell'agente (scripts/passepartout-agent.ts), qui in memoria.
    const memoria = new Map<string, MemoriaComandaViva>();
    let perdiRisposta = false;

    const finoA = async (cond: () => Promise<boolean>, descr: string, timeoutMs = 8_000) => {
        const deadline = Date.now() + timeoutMs;
        for (;;) {
            if (await cond()) return;
            if (Date.now() > deadline) throw new Error(`Timeout: ${descr}`);
            await sleep(150);
        }
    };
    const viva = async (orderId: number) => (await db.query(
        `SELECT stato, pp_comanda_id, palmare, error FROM passepartout_comande_vive WHERE tenant_id = 1 AND order_id = $1`, [orderId]
    )).rows[0];
    const scritte = async (orderId: number) => (await db.query(
        `SELECT chiave, pp_riga_id, pezzi_scritti, prezzo_cents_scritto FROM passepartout_righe_vive WHERE tenant_id = 1 AND order_id = $1 ORDER BY chiave`, [orderId]
    )).rows;
    const nuovoOrdine = async (tavolo: string, covers: number) => {
        const o = await api().post('/orders').set(bearer(token)).send({ table_id: tavoli[tavolo], covers });
        expect(o.status).toBe(201);
        ordini.push(o.body.order.id);
        return o.body.order.id as number;
    };
    const batti = async (orderId: number, items: Array<Record<string, unknown>>) => {
        expect((await api().post(`/orders/${orderId}/items`).set(bearer(token)).send({ items })).status).toBe(201);
        const sent = await api().post(`/orders/${orderId}/send`).set(bearer(token)).send({});
        expect(sent.status).toBe(200);
        return sent.body;
    };
    const rigaDi = async (orderId: number, dishId: number) => (await db.query(
        `SELECT id FROM order_items WHERE order_id = $1 AND dish_id = $2 AND status <> 'VOIDED' ORDER BY id LIMIT 1`, [orderId, dishId]
    )).rows[0]?.id as number;

    beforeAll(async () => {
        token = await ownerToken();
        db = new Client({ connectionString: process.env.DATABASE_URL || 'postgresql://localhost/ristotest_api' });
        await db.connect();
        await new Promise<void>((resolve) => cassa.server.listen(0, '127.0.0.1', () => resolve()));
        process.env.PASSEPARTOUT_WS_URL = `http://127.0.0.1:${(cassa.server.address() as AddressInfo).port}/AdapterWS`;
        process.env.PASSEPARTOUT_WS_USER = 'utente-prova';
        process.env.PASSEPARTOUT_WS_PASSWORD = 'segreto-prova';

        await api().put('/settings/entitlements').set(bearer(token)).send({ passepartout: true });
        comandePrima = (await api().get('/settings/features').set(bearer(token))).body.table_orders_enabled === true;
        await api().put('/settings/features').set(bearer(token)).send({ table_orders_enabled: true });

        const room = await api().post('/rooms').set(bearer(token)).send({ name: 'Sala Comanda Viva 2', width: 600, height: 400 });
        for (const [i, nome] of ['V1', 'V2', 'V3'].entries()) {
            const t = await api().post('/tables').set(bearer(token)).send({
                name: `CV${nome}`, shape: 'SQUARE', seats: 4, x: 40 + i * 80, y: 40, room_id: room.body.id, status: 'FREE',
            });
            tavoli[nome] = t.body.id;
            await db.query(
                `INSERT INTO passepartout_tavoli (table_id, tenant_id, pp_sala, pp_tavolo, origine, confermato)
                 VALUES ($1, 1, 'TETTOIA', $2, 'manuale', true)`,
                [t.body.id, nome]
            );
        }
        for (const [nome, prezzo, set] of [
            ['Tagliatelle Viva', 13, (id: number) => { piattoCassa = id; }],
            ['Vino della casa Viva', 5, (id: number) => { piattoCrm = id; }],
        ] as const) {
            const d = await api().post('/dishes').set(bearer(token)).send({ name: nome, description: null, price: prezzo, category: 'PRIMI', allergens: null });
            expect(d.status).toBe(201);
            set(d.body.id);
        }
        // Un piatto importato dalla cassa (porta l'id dell'articolo) e uno
        // del CRM, che va sull'articolo generico.
        await db.query(`UPDATE dishes SET external_ref = 'pp:articolo:11' WHERE id = $1`, [piattoCassa]);
        await db.query(
            `INSERT INTO passepartout_config (tenant_id, articolo_generico_id) VALUES (1, 500)
             ON CONFLICT (tenant_id) DO UPDATE SET articolo_generico_id = 500`
        );

        socket = ioClient(`${process.env.TEST_BASE_URL}/pp-agent`, {
            auth: { token: AGENT_TOKEN }, transports: ['websocket'], reconnection: false,
        });
        socket.on('pp:call', async (payload: any, ack: (r: unknown) => void) => {
            if (payload?.op !== 'comandaViva') return ack({ ok: false, error: `op non prevista: ${payload?.op}`, kind: 'agent' });
            try {
                const p = payload.params;
                const esito: EsitoComandaViva = await scriviComandaViva(p, memoria.get(p.tag) ?? { idComanda: null, righe: {} });
                const m = memoria.get(p.tag) ?? { idComanda: null, righe: {} };
                if (esito.idComanda != null) m.idComanda = esito.idComanda;
                for (const r of esito.righe) {
                    if (r.cancellata) delete m.righe[r.chiave];
                    else if (r.idRiga != null) m.righe[r.chiave] = r.idRiga;
                }
                memoria.set(p.tag, m);
                // La linea che cade dopo la scrittura: la cassa ha le righe,
                // il server non lo sa.
                if (perdiRisposta) { perdiRisposta = false; return ack({ ok: false, error: 'linea caduta', kind: 'agent' }); }
                ack({ ok: true, result: esito });
            } catch (err) {
                ack({ ok: false, error: (err as Error).message, kind: err instanceof PassepartoutError ? 'gestionale' : 'agent' });
            }
        });
        await new Promise<void>((resolve, reject) => {
            socket!.on('connect', () => resolve());
            socket!.on('connect_error', reject);
        });
        socket.emit('agent:hello', { hostname: 'agente-comanda-viva-2', capabilities: ['comanda-viva'] });
        await finoA(async () => ((await api().get('/passepartout/status').set(bearer(token))).body.capabilities ?? []).includes('comanda-viva'),
            'agente annunciato');
    });

    afterAll(async () => {
        await api().put('/passepartout/comande-vive/config').set(bearer(token)).send({ enabled: false });
        for (const id of ordini) {
            await api().delete(`/orders/${id}?forza=1`).set(bearer(token)).send({ motivo: 'fine prova' });
        }
        await sleep(300);
        socket?.close();
        await db.query(`DELETE FROM passepartout_comande_vive WHERE tenant_id = 1 AND order_id = ANY($1::int[])`, [ordini]);
        await db.query(`DELETE FROM passepartout_tavoli WHERE tenant_id = 1 AND table_id = ANY($1::int[])`, [Object.values(tavoli)]);
        await db.query(`UPDATE passepartout_config SET articolo_generico_id = NULL WHERE tenant_id = 1`);
        await api().put('/settings/features').set(bearer(token)).send({ table_orders_enabled: comandePrima });
        delete process.env.PASSEPARTOUT_WS_URL;
        delete process.env.PASSEPARTOUT_WS_USER;
        delete process.env.PASSEPARTOUT_WS_PASSWORD;
        await new Promise<void>((resolve) => cassa.server.close(() => resolve()));
        await db.end();
    });

    let prima: number;
    it('un ordine aperto prima di accendere non va in cassa', async () => {
        prima = await nuovoOrdine('V3', 2);
        await batti(prima, [{ dish_id: piattoCassa, qty: 1, course_no: 1 }]);
        expect((await api().put('/passepartout/comande-vive/config').set(bearer(token)).send({ enabled: true })).status).toBe(200);
        await api().patch(`/orders/${prima}`).set(bearer(token)).send({ covers: 3 });
        await sleep(400);
        expect(await viva(prima)).toBeUndefined();
        expect(cassa.sulTavolo('V3')).toBeNull();
    });

    let ordine: number;
    it('l\'ordine mandato nasce in cassa sul suo tavolo, con coperto, varianti e prezzi del CRM', async () => {
        ordine = await nuovoOrdine('V1', 2);
        await batti(ordine, [
            { dish_id: piattoCassa, qty: 2, course_no: 1, note: 'ben cotta' },
            { dish_id: piattoCrm, qty: 1, course_no: 99 },
        ]);
        await finoA(async () => (await viva(ordine))?.stato === 'SCRITTA', 'ordine scritto in cassa');
        const c = cassa.sulTavolo('V1')!;
        expect(c).toMatchObject({ note: `Ordine Sympotia sympotia-ordine:${ordine}`, sala: 'TETTOIA', coperti: 2 });
        expect(c.righe).toEqual(expect.arrayContaining([
            expect.objectContaining({ articolo: 'Coperti', tipo: 'Coperto', pezzi: 2, prezzo: 0 }),
            expect.objectContaining({ articolo: 'Tagliatelle Silana', descrizione: 'Tagliatelle Silana', pezzi: 2, prezzo: 13, uscita: 1, varianti: ['+ben cotta'] }),
            expect.objectContaining({ articolo: 'VARIE', descrizione: expect.stringMatching(/^vino della casa viva$/i), pezzi: 1, prezzo: 5, uscita: 1 }),
        ]));
        expect(c.righe).toHaveLength(3);
        // Mai in produzione da qui: le righe nascono senza invio.
        expect(cassa.put.every((b) => !b.includes('<c:Tool_EseguiInvio>true'))).toBe(true);
        expect(await viva(ordine)).toMatchObject({ pp_comanda_id: c.id, palmare: false, error: null });
        expect((await scritte(ordine)).map((r: any) => r.chiave).sort()).toEqual(['coperto', `oi:${await rigaDi(ordine, piattoCassa)}`, `oi:${await rigaDi(ordine, piattoCrm)}`].sort());
        const vista = await api().get(`/orders/${ordine}`).set(bearer(token));
        expect(vista.body.comanda_viva).toMatchObject({ stato: 'SCRITTA', pp_comanda_id: c.id });
    });

    it('lo storno di un pezzo cambia la stessa riga, quello intero la toglie', async () => {
        const c = cassa.sulTavolo('V1')!;
        const tagliatelle = c.righe.find((r) => r.articolo === 'Tagliatelle Silana')!;
        const idTagliatelle = await rigaDi(ordine, piattoCassa);
        expect((await api().post(`/orders/items/${idTagliatelle}/void`).set(bearer(token)).send({ reason: 'prova', qty: 1 })).status).toBe(200);
        await finoA(async () => cassa.sulTavolo('V1')!.righe.find((r) => r.id === tagliatelle.id)?.pezzi === 1, 'un pezzo in meno sulla stessa riga');
        expect(cassa.sulTavolo('V1')!.righe).toHaveLength(3);

        const idVino = await rigaDi(ordine, piattoCrm);
        expect((await api().post(`/orders/items/${idVino}/void`).set(bearer(token)).send({ reason: 'prova' })).status).toBe(200);
        await finoA(async () => !cassa.sulTavolo('V1')!.righe.some((r) => r.articolo === 'VARIE'), 'vino tolto dalla cassa');
        await finoA(async () => !(await scritte(ordine)).some((r: any) => r.chiave === `oi:${idVino}`), 'riga dimenticata');
        expect((await viva(ordine)).stato).toBe('SCRITTA');
    });

    it('i coperti cambiati nel CRM cambiano la riga coperto', async () => {
        const coperto = cassa.sulTavolo('V1')!.righe.find((r) => r.tipo === 'Coperto')!;
        expect((await api().patch(`/orders/${ordine}`).set(bearer(token)).send({ covers: 4 })).status).toBe(200);
        await finoA(async () => cassa.sulTavolo('V1')!.righe.find((r) => r.id === coperto.id)?.pezzi === 4, 'quattro coperti');
    });

    it('un ordine già in cassa non si sposta dal CRM', async () => {
        const r = await api().post(`/orders/${ordine}/transfer`).set(bearer(token)).send({ table_id: tavoli.V3 });
        expect(r.status).toBe(409);
        expect(r.body.code).toBe('comanda_in_cassa');
    });

    it('sul tavolo aperto dal palmare il CRM aggiunge le sue righe alla stessa comanda, senza coperto', async () => {
        cassa.comande.set(70_001, {
            id: 70_001, note: '', sala: 'TETTOIA', tavolo: 'V2', coperti: 3, pagata: false,
            righe: [
                { id: 700_001, articolo: 'Coperti', descrizione: 'Coperti', pezzi: 3, prezzo: 3, uscita: 0, stato: 'Nuovo', tipo: 'Coperto', varianti: [] },
                { id: 700_002, articolo: 'ACQUA', descrizione: 'Acqua naturale', pezzi: 1, prezzo: 2.5, uscita: 1, stato: 'Nuovo', tipo: 'Semplice', varianti: [] },
            ],
        });
        const o = await nuovoOrdine('V2', 3);
        await batti(o, [{ dish_id: piattoCassa, qty: 1, course_no: 2 }]);
        await finoA(async () => (await viva(o))?.stato === 'SCRITTA', 'righe nella comanda del palmare');
        expect(await viva(o)).toMatchObject({ pp_comanda_id: 70_001, palmare: true });
        const c = cassa.comande.get(70_001)!;
        expect(c.righe.map((r) => r.id).slice(0, 2)).toEqual([700_001, 700_002]);
        expect(c.righe).toHaveLength(3);
        expect(c.righe[2]).toMatchObject({ articolo: 'Tagliatelle Silana', uscita: 2, pezzi: 1 });
        expect(c.righe.filter((r) => r.tipo === 'Coperto')).toHaveLength(1);
    });

    it('una risposta persa non scrive due volte le stesse righe', async () => {
        perdiRisposta = true;
        await batti(ordine, [{ dish_id: piattoCrm, qty: 2, course_no: 1 }]);
        await finoA(async () => ((await viva(ordine))?.error ?? '').includes('linea caduta'), 'tentativo fallito');
        expect(cassa.sulTavolo('V1')!.righe.filter((r) => r.articolo === 'VARIE')).toHaveLength(1);
        // Il tentativo dopo (qui subito invece che fra un minuto).
        await db.query(`UPDATE passepartout_comande_vive SET next_at = now() WHERE tenant_id = 1 AND order_id = $1`, [ordine]);
        await api().patch(`/orders/${ordine}`).set(bearer(token)).send({ covers: 4 });
        await finoA(async () => (await viva(ordine))?.stato === 'SCRITTA' && (await viva(ordine))?.error == null, 'riscritto');
        expect(cassa.sulTavolo('V1')!.righe.filter((r) => r.articolo === 'VARIE')).toHaveLength(1);
        const idVino = await rigaDi(ordine, piattoCrm);
        expect((await scritte(ordine)).find((r: any) => r.chiave === `oi:${idVino}`)).toMatchObject({ pezzi_scritti: 2, prezzo_cents_scritto: 500 });
    });

    it('la cancellazione forzata dell\'ordine toglie dalla cassa le righe del CRM', async () => {
        const id = cassa.sulTavolo('V1')!.id;
        const r = await api().delete(`/orders/${ordine}?forza=1`).set(bearer(token)).send({ motivo: 'prova cancellazione' });
        expect(r.status).toBe(200);
        await finoA(async () => (await viva(ordine))?.stato === 'CHIUSA', 'ordine chiuso anche in cassa');
        expect(cassa.comande.get(id)!.righe).toHaveLength(0);
        expect(await scritte(ordine)).toHaveLength(0);
    });

    it('la scrittura in cassa senza articolo generico si ferma con un errore chiaro', async () => {
        await expect(scriviComandaViva({
            tag: 'sympotia-ordine:999999', idComanda: null, sala: 'TETTOIA', tavolo: 'V9', coperti: 1,
            righe: [{ chiave: 'oi:1', idRiga: null, idArticolo: null, descrizione: 'Piatto senza cassa', pezzi: 1, prezzoCents: 900, uscita: 1, varianti: [] }],
            idArticoloGenerico: null,
        })).rejects.toThrow(/non ha un articolo in cassa/);
        expect(cassa.sulTavolo('V9')).toBeNull();
    });
});

// ---------------------------------------------------------------------------
// Fase 3: chi stampa in cucina. Con «stampa: la cassa» e un agente che sa
// mandare in produzione ('comanda-viva-invio'), le uscite lanciate nel CRM
// le manda la cassa e il CRM non stampa; se la cassa non può, stampa il CRM
// e quell'uscita resta sua.
// ---------------------------------------------------------------------------
describe('ordini del CRM in cassa: chi stampa in cucina', () => {
    let token: string;
    let db: Client;
    let socket: Socket | null = null;
    const cassa = cassaFinta();
    const tavoli: Record<string, number> = {};
    const ordini: number[] = [];
    let piatto: number;
    let dolce: number;
    let stationId: number;
    let comandePrima = false;
    let firePrima: string | null = null;
    const memoria = new Map<string, MemoriaComandaViva>();
    // La scrittura in sospeso (tavolo aperto nel Menu Client della demo, 09/10):
    // la chiamata dell'agente scade, ma la cassa la fa lo stesso, senza invio.
    let inSospeso = false;

    const finoA = async (cond: () => Promise<boolean>, descr: string, timeoutMs = 8_000) => {
        const deadline = Date.now() + timeoutMs;
        for (;;) {
            if (await cond()) return;
            if (Date.now() > deadline) throw new Error(`Timeout: ${descr}`);
            await sleep(150);
        }
    };
    const viva = async (orderId: number) => (await db.query(
        `SELECT stato, pp_comanda_id, error FROM passepartout_comande_vive WHERE tenant_id = 1 AND order_id = $1`, [orderId]
    )).rows[0];
    const righeVive = async (orderId: number) => (await db.query(
        `SELECT chiave, pp_riga_id, inviata, stampata_crm FROM passepartout_righe_vive WHERE tenant_id = 1 AND order_id = $1 AND chiave LIKE 'oi:%' ORDER BY chiave`, [orderId]
    )).rows;
    const stampe = async (orderId: number) => (await db.query(
        `SELECT kind, payload FROM print_jobs WHERE tenant_id = 1 AND (payload->>'order_id')::int = $1 ORDER BY id`, [orderId]
    )).rows;
    const capacita = async () => (await api().get('/passepartout/status').set(bearer(token))).body.capabilities ?? [];
    const saluta = async (caps: string[]) => {
        socket!.emit('agent:hello', { hostname: 'agente-comanda-viva-3', capabilities: caps });
        await finoA(async () => {
            const c = await capacita();
            return caps.every((x) => c.includes(x)) && c.length === caps.length;
        }, `agente con ${caps.join(', ')}`);
    };
    const nuovoOrdine = async (tavolo: string) => {
        const o = await api().post('/orders').set(bearer(token)).send({ table_id: tavoli[tavolo], covers: 2 });
        expect(o.status).toBe(201);
        ordini.push(o.body.order.id);
        return o.body.order.id as number;
    };
    const batti = async (orderId: number, items: Array<Record<string, unknown>>) => {
        expect((await api().post(`/orders/${orderId}/items`).set(bearer(token)).send({ items })).status).toBe(201);
        expect((await api().post(`/orders/${orderId}/send`).set(bearer(token)).send({})).status).toBe(200);
    };
    const lancia = async (orderId: number, uscita: number) => {
        const r = await api().post(`/orders/${orderId}/courses/${uscita}/fire`).set(bearer(token)).send({});
        expect(r.status).toBe(200);
    };

    beforeAll(async () => {
        token = await ownerToken();
        db = new Client({ connectionString: process.env.DATABASE_URL || 'postgresql://localhost/ristotest_api' });
        await db.connect();
        await new Promise<void>((resolve) => cassa.server.listen(0, '127.0.0.1', () => resolve()));
        process.env.PASSEPARTOUT_WS_URL = `http://127.0.0.1:${(cassa.server.address() as AddressInfo).port}/AdapterWS`;
        process.env.PASSEPARTOUT_WS_USER = 'utente-prova';
        process.env.PASSEPARTOUT_WS_PASSWORD = 'segreto-prova';

        await api().put('/settings/entitlements').set(bearer(token)).send({ passepartout: true });
        comandePrima = (await api().get('/settings/features').set(bearer(token))).body.table_orders_enabled === true;
        await api().put('/settings/features').set(bearer(token)).send({ table_orders_enabled: true });
        firePrima = (await db.query(`SELECT text_value FROM app_settings WHERE tenant_id = 1 AND key = 'course_fire_mode'`)).rows[0]?.text_value ?? null;
        // Le uscite si lanciano a mano: il test decide quando.
        expect((await api().put('/sala/fire-mode').set(bearer(token)).send({ mode: 'MANUAL' })).status).toBe(200);

        // Una partita CON stampante: senza printer i foglietti non si accodano.
        stationId = Number((await db.query(
            `INSERT INTO stations (tenant_id, name, printer, sort_order) VALUES (1, 'Cucina Viva Stampa', 'termica-viva', 95) RETURNING id`
        )).rows[0].id);
        const room = await api().post('/rooms').set(bearer(token)).send({ name: 'Sala Comanda Viva 3', width: 600, height: 400 });
        for (const [i, nome] of ['W1', 'W2', 'W3', 'W4', 'W5', 'W6', 'W7'].entries()) {
            const t = await api().post('/tables').set(bearer(token)).send({
                name: `CV${nome}`, shape: 'SQUARE', seats: 4, x: 40 + i * 80, y: 40, room_id: room.body.id, status: 'FREE',
            });
            tavoli[nome] = t.body.id;
            await db.query(
                `INSERT INTO passepartout_tavoli (table_id, tenant_id, pp_sala, pp_tavolo, origine, confermato)
                 VALUES ($1, 1, 'TETTOIA', $2, 'manuale', true)`,
                [t.body.id, nome]
            );
        }
        for (const [nome, prezzo, set] of [
            ['Gnocchi Viva Stampa', 12, (id: number) => { piatto = id; }],
            ['Tiramisu Viva Stampa', 6, (id: number) => { dolce = id; }],
        ] as const) {
            const d = await api().post('/dishes').set(bearer(token)).send({
                name: nome, description: null, price: prezzo, category: 'PRIMI', allergens: null, station_id: stationId,
            });
            expect(d.status).toBe(201);
            set(d.body.id);
        }
        await db.query(`UPDATE dishes SET external_ref = 'pp:articolo:12' WHERE id = $1`, [piatto]);
        await db.query(
            `INSERT INTO passepartout_config (tenant_id, articolo_generico_id) VALUES (1, 500)
             ON CONFLICT (tenant_id) DO UPDATE SET articolo_generico_id = 500`
        );

        socket = ioClient(`${process.env.TEST_BASE_URL}/pp-agent`, {
            auth: { token: AGENT_TOKEN }, transports: ['websocket'], reconnection: false,
        });
        socket.on('pp:call', async (payload: any, ack: (r: unknown) => void) => {
            // Le letture con cui il giro si accorge delle comande chiuse in cassa.
            if (payload?.op === 'comandeAperte') {
                return ack({ ok: true, result: [...cassa.comande.values()].filter((c) => !c.pagata).map((c) => ({
                    idComanda: c.id, tavolo: c.tavolo, sala: c.sala, coperti: c.coperti, idPrenotazione: null, aperta: null,
                    totale: c.righe.filter((r) => r.stato !== 'Cancellato').reduce((t, r) => t + r.prezzo * r.pezzi, 0),
                })) });
            }
            if (payload?.op === 'comanda') {
                return ack({ ok: true, result: await getComanda(Number(payload.params?.idGestionale)) });
            }
            if (payload?.op !== 'comandaViva') return ack({ ok: false, error: `op non prevista: ${payload?.op}`, kind: 'agent' });
            try {
                const p = inSospeso ? { ...payload.params, inviaUscite: undefined } : payload.params;
                const esito: EsitoComandaViva = await scriviComandaViva(p, memoria.get(p.tag) ?? { idComanda: null, righe: {} });
                const m = memoria.get(p.tag) ?? { idComanda: null, righe: {} };
                if (esito.idComanda != null) m.idComanda = esito.idComanda;
                for (const r of esito.righe) {
                    if (r.cancellata) delete m.righe[r.chiave];
                    else if (r.idRiga != null) m.righe[r.chiave] = r.idRiga;
                }
                memoria.set(p.tag, m);
                if (inSospeso) return ack({ ok: false, error: 'Gestionale non raggiungibile (This operation was aborted)', kind: 'gestionale' });
                ack({ ok: true, result: esito });
            } catch (err) {
                ack({ ok: false, error: (err as Error).message, kind: err instanceof PassepartoutError ? 'gestionale' : 'agent' });
            }
        });
        await new Promise<void>((resolve, reject) => {
            socket!.on('connect', () => resolve());
            socket!.on('connect_error', reject);
        });
        await saluta(['comanda-viva', 'comanda-viva-invio']);
        const acceso = await api().put('/passepartout/comande-vive/config').set(bearer(token)).send({ enabled: true, stampa: 'cassa', conto: 'cassa' });
        expect(acceso.status).toBe(200);
    });

    afterAll(async () => {
        await api().put('/passepartout/comande-vive/config').set(bearer(token)).send({ enabled: false, stampa: 'cassa', conto: 'cassa' });
        for (const id of ordini) {
            await api().delete(`/orders/${id}?forza=1`).set(bearer(token)).send({ motivo: 'fine prova' });
        }
        await sleep(300);
        socket?.close();
        await db.query(`DELETE FROM print_jobs WHERE tenant_id = 1 AND (payload->>'order_id')::int = ANY($1::int[])`, [ordini]);
        await db.query(`DELETE FROM passepartout_comande_vive WHERE tenant_id = 1 AND order_id = ANY($1::int[])`, [ordini]);
        await db.query(`DELETE FROM passepartout_tavoli WHERE tenant_id = 1 AND table_id = ANY($1::int[])`, [Object.values(tavoli)]);
        await db.query(`UPDATE passepartout_config SET articolo_generico_id = NULL WHERE tenant_id = 1`);
        await db.query(`UPDATE dishes SET station_id = NULL WHERE tenant_id = 1 AND station_id = $1`, [stationId]);
        await db.query(`DELETE FROM stations WHERE id = $1`, [stationId]);
        if (firePrima == null) await db.query(`DELETE FROM app_settings WHERE tenant_id = 1 AND key = 'course_fire_mode'`);
        else await api().put('/sala/fire-mode').set(bearer(token)).send({ mode: firePrima });
        await api().put('/settings/features').set(bearer(token)).send({ table_orders_enabled: comandePrima });
        delete process.env.PASSEPARTOUT_WS_URL;
        delete process.env.PASSEPARTOUT_WS_USER;
        delete process.env.PASSEPARTOUT_WS_PASSWORD;
        await new Promise<void>((resolve) => cassa.server.close(() => resolve()));
        await db.end();
    });

    it('«stampa: il CRM» si sceglie solo con «conto: il CRM»', async () => {
        const salva = (body: Record<string, unknown>) => api().put('/passepartout/comande-vive/config').set(bearer(token)).send(body);
        const no = await salva({ stampa: 'crm' });
        expect(no.status).toBe(409);
        expect(no.body.error).toBe('stampa_crm_senza_conto_crm');
        expect((await salva({ stampa: 'crm', conto: 'crm' })).status).toBe(200);
        expect((await salva({ conto: 'cassa' })).status).toBe(409);
        expect((await salva({ stampa: 'cassa', conto: 'cassa' })).status).toBe(200);
    });

    let ordineW1: number;
    it('l\'uscita lanciata nel CRM la manda la cassa, e il CRM non stampa', async () => {
        const ordine = await nuovoOrdine('W1');
        ordineW1 = ordine;
        await batti(ordine, [
            { dish_id: piatto, qty: 1, course_no: 1 },
            { dish_id: dolce, qty: 1, course_no: 2 },
        ]);
        await finoA(async () => (await viva(ordine))?.stato === 'SCRITTA', 'ordine scritto in cassa');
        const c = cassa.sulTavolo('W1')!;
        // Mandato ma non lanciato: in cassa senza invio.
        expect(cassa.invii.filter((i) => i.id === c.id)).toEqual([]);

        await lancia(ordine, 1);
        await finoA(async () => cassa.invii.some((i) => i.id === c.id && i.uscite.join() === '1'), 'uscita 1 mandata dalla cassa');
        await lancia(ordine, 2);
        await finoA(async () => cassa.invii.some((i) => i.id === c.id && i.uscite.join() === '2'), 'uscita 2 mandata dalla cassa');
        await finoA(async () => (await righeVive(ordine)).every((r: any) => r.inviata), 'righe segnate come mandate');
        expect(c.righe.filter((r) => r.tipo !== 'Coperto').every((r) => r.stato === 'InProduzione')).toBe(true);
        // Nessun foglietto di partita dal CRM.
        expect(await stampe(ordine)).toEqual([]);
    });

    it('agente senza invio: stampa il CRM, e quell\'uscita resta del CRM anche dopo', async () => {
        await saluta(['comanda-viva']);
        const ordine = await nuovoOrdine('W2');
        await batti(ordine, [{ dish_id: piatto, qty: 1, course_no: 1 }]);
        await finoA(async () => (await viva(ordine))?.stato === 'SCRITTA', 'ordine scritto in cassa');
        await lancia(ordine, 1);
        expect((await stampe(ordine)).map((j: any) => j.kind)).toEqual(['COMANDA']);
        expect((await righeVive(ordine))[0]).toMatchObject({ stampata_crm: true });

        // L'agente nuovo torna: la stessa uscita non la manda la cassa (la
        // ristamperebbe), le righe nuove le stampa ancora il CRM.
        await saluta(['comanda-viva', 'comanda-viva-invio']);
        const c = cassa.sulTavolo('W2')!;
        expect((await api().post(`/orders/${ordine}/items`).set(bearer(token)).send({ items: [{ dish_id: piatto, qty: 2, course_no: 1 }] })).status).toBe(201);
        // Righe aggiunte a un'uscita già lanciata: partono all'«Invia».
        expect((await api().post(`/orders/${ordine}/send`).set(bearer(token)).send({})).status).toBe(200);
        await finoA(async () => (await stampe(ordine)).length === 2, 'riga aggiunta stampata dal CRM');
        await finoA(async () => (await righeVive(ordine)).length === 2 && (await righeVive(ordine)).every((r: any) => r.pp_riga_id != null), 'righe scritte in cassa');
        await sleep(300);
        expect(cassa.invii.filter((i) => i.id === c.id)).toEqual([]);
    });

    it('se la cassa non prende l\'ordine, dopo un attimo stampa il CRM', async () => {
        cassa.rifiuta.add('W3');
        try {
            const ordine = await nuovoOrdine('W3');
            await batti(ordine, [{ dish_id: piatto, qty: 1, course_no: 1 }]);
            await lancia(ordine, 1);
            await finoA(async () => (await viva(ordine))?.error != null, 'scrittura rifiutata dalla cassa');
            // Al lancio non ha stampato: la cassa doveva mandarla.
            expect(await stampe(ordine)).toEqual([]);
            // Passato il tempo del ripiego, alla prossima modifica stampa il CRM.
            await sleep(700);
            await api().patch(`/orders/${ordine}`).set(bearer(token)).send({ covers: 3 });
            await finoA(async () => (await stampe(ordine)).length === 1, 'stampa di ripiego dal CRM');
            expect((await righeVive(ordine))[0]).toMatchObject({ stampata_crm: true });
        } finally {
            cassa.rifiuta.delete('W3');
        }
    });

    it('scrittura in sospeso: il CRM non stampa, e quando passa l\'uscita la manda la cassa', async () => {
        inSospeso = true;
        let ordine: number;
        try {
            ordine = await nuovoOrdine('W5');
            await batti(ordine, [{ dish_id: piatto, qty: 1, course_no: 1 }]);
            await lancia(ordine, 1);
            await finoA(async () => ((await viva(ordine))?.error ?? '').includes('aborted'), 'scrittura senza risposta');
            // Passato il tempo del ripiego la cassa risponde: niente stampa dal CRM.
            await sleep(700);
            await api().patch(`/orders/${ordine}`).set(bearer(token)).send({ covers: 3 });
            await sleep(800);
            expect(await stampe(ordine)).toEqual([]);
        } finally {
            inSospeso = false;
        }
        // Il tentativo dopo (qui subito invece che fra un minuto) trova le righe e manda l'uscita.
        await db.query(`UPDATE passepartout_comande_vive SET next_at = now() WHERE tenant_id = 1 AND order_id = $1`, [ordine]);
        await api().patch(`/orders/${ordine}`).set(bearer(token)).send({ covers: 2 });
        const c = cassa.sulTavolo('W5')!;
        await finoA(async () => cassa.invii.some((i) => i.id === c.id && i.uscite.join() === '1'), 'uscita 1 mandata dalla cassa');
        await finoA(async () => (await righeVive(ordine)).every((r: any) => r.inviata), 'righe segnate come mandate');
        expect(c.righe.filter((r) => r.articolo !== 'Coperti')).toHaveLength(1);
        expect(await stampe(ordine)).toEqual([]);
    });

    it('la cassa ha già mandato l\'uscita dal suo «Invia»: il CRM la segna mandata, non la stampa e non la rimanda', async () => {
        const ordine = await nuovoOrdine('W6');
        await batti(ordine, [{ dish_id: piatto, qty: 1, course_no: 1 }]);
        await finoA(async () => (await viva(ordine))?.stato === 'SCRITTA', 'ordine scritto in cassa');
        const c = cassa.sulTavolo('W6')!;
        inSospeso = true;
        try {
            await lancia(ordine, 1);
            await finoA(async () => ((await viva(ordine))?.error ?? '').includes('aborted'), 'invio senza risposta');
            // Intanto in cassa premono «Invia».
            for (const r of c.righe) if (r.tipo !== 'Coperto') r.stato = 'InProduzione';
            await sleep(700);
            await api().patch(`/orders/${ordine}`).set(bearer(token)).send({ covers: 3 });
            await finoA(async () => (await righeVive(ordine)).every((r: any) => r.inviata), 'righe segnate come mandate');
        } finally {
            inSospeso = false;
        }
        await db.query(`UPDATE passepartout_comande_vive SET next_at = now() WHERE tenant_id = 1 AND order_id = $1`, [ordine]);
        await api().patch(`/orders/${ordine}`).set(bearer(token)).send({ covers: 2 });
        await finoA(async () => (await viva(ordine))?.error == null, 'scrittura riuscita');
        expect(await stampe(ordine)).toEqual([]);
        expect(cassa.invii.filter((i) => i.id === c.id)).toEqual([]);
    });

    it('l\'agente non rimanda un\'uscita che la cassa ha già mandato', async () => {
        const base = {
            tag: 'sympotia-ordine:prova-guardia', idComanda: null, sala: 'TETTOIA', tavolo: 'W9', coperti: 0, idArticoloGenerico: 500,
            righe: [{ chiave: 'oi:1', idRiga: null, idArticolo: 12, descrizione: 'Gnocchi', pezzi: 1, prezzoCents: 1200, uscita: 1, varianti: [] }],
        };
        const scritta = await scriviComandaViva(base, { idComanda: null, righe: {} });
        const c = cassa.comande.get(scritta.idComanda!)!;
        for (const r of c.righe) r.stato = 'InProduzione';
        const esito = await scriviComandaViva(
            { ...base, idComanda: scritta.idComanda, righe: [], inviaUscite: [1] },
            { idComanda: scritta.idComanda, righe: { 'oi:1': scritta.righe[0].idRiga! } },
        );
        expect(esito.inviate).toEqual([1]);
        expect(cassa.invii.filter((i) => i.id === c.id)).toEqual([]);
        c.pagata = true;
    });

    it('le righe battute in cassa si vedono nel CRM: senza quelle del CRM e gli storni, col totale del tavolo in cassa', async () => {
        const ordine = await nuovoOrdine('W7');
        await batti(ordine, [{ dish_id: piatto, qty: 1, course_no: 1 }]);
        await finoA(async () => (await viva(ordine))?.stato === 'SCRITTA', 'ordine scritto in cassa');
        const altro = ordini[ordini.indexOf(ordineW1) + 1];
        const giro = async (coperti: number) => {
            await api().patch(`/orders/${altro}`).set(bearer(token)).send({ covers: coperti });
            await sleep(400);
        };
        // Un giro che vede la comanda: da qui un cambio di totale in cassa si nota.
        await giro(3);
        const righe = () => api().get(`/orders/${ordine}/righe-cassa`).set(bearer(token));
        const prima = await righe();
        expect(prima.status).toBe(200);
        expect(prima.body).toMatchObject({ disponibile: true, righe: [] });
        expect(prima.body.totale_cents).toBeGreaterThanOrEqual(1200);

        // In cassa battono una tisana, e una riga poi stornata.
        const c = cassa.sulTavolo('W7')!;
        c.righe.push({ id: 990_101, articolo: 'VARIE', descrizione: 'Tisana', pezzi: 1, prezzo: 1.5, uscita: 1, stato: 'Nuovo', tipo: 'Semplice', varianti: [] });
        c.righe.push({ id: 990_102, articolo: 'VARIE', descrizione: 'Caffè', pezzi: 1, prezzo: 1.2, uscita: 1, stato: 'Cancellato', tipo: 'Semplice', varianti: [] });
        await giro(4);
        await finoA(async () => (await righe()).body.righe?.length === 1, 'tisana nel CRM');
        const dopo = (await righe()).body;
        expect(dopo.righe).toEqual([{ id: 990_101, descrizione: 'Tisana', pezzi: 1, prezzo_cents: 150, totale_cents: 150, uscita: 1, stato: 'Nuovo' }]);
        expect(dopo.totale_cents).toBe(prima.body.totale_cents + 150);

        // Un ordine che non va in cassa non ha righe della cassa.
        const fuori = await api().get(`/orders/${altro + 100_000}/righe-cassa`).set(bearer(token));
        expect(fuori.body).toMatchObject({ disponibile: true, righe: [], totale_cents: null });
    });

    it('la comanda chiusa in cassa chiude l\'ordine nel CRM, senza un conto del CRM', async () => {
        const c = cassa.sulTavolo('W1')!;
        c.pagata = true;
        // Il giro passa a ogni modifica di un ordine del ristorante.
        await api().patch(`/orders/${ordini[ordini.length - 1]}`).set(bearer(token)).send({ covers: 4 });
        await finoA(async () => (await viva(ordineW1))?.stato === 'CHIUSA', 'ordine segnato chiuso in cassa');
        const o = (await db.query(`SELECT status, closed_by_user_id, table_bill_id FROM orders WHERE id = $1`, [ordineW1])).rows[0];
        expect(o).toMatchObject({ status: 'CLOSED', closed_by_user_id: null, table_bill_id: null });
        // Gli altri, con la comanda ancora aperta in cassa, restano aperti.
        const w2 = ordini[ordini.indexOf(ordineW1) + 1];
        expect((await db.query(`SELECT status FROM orders WHERE id = $1`, [w2])).rows[0].status).toBe('OPEN');
    });

    it('conto della cassa: coperto della cassa, e chiudendo dal CRM il conto è la comanda in cassa', async () => {
        await saluta(['comanda-viva', 'comanda-viva-invio', 'comanda-viva-coperto']);
        const ordine = await nuovoOrdine('W4');
        await batti(ordine, [{ dish_id: piatto, qty: 1, course_no: 1 }]);
        await finoA(async () => (await viva(ordine))?.stato === 'SCRITTA', 'ordine scritto in cassa');
        const c = cassa.sulTavolo('W4')!;
        // Il coperto è quello della cassa: due coperti al prezzo del suo listino.
        expect(c.righe.find((r) => r.tipo === 'Coperto')).toMatchObject({ articolo: 'Coperti', pezzi: 2, prezzo: 3 });
        const scritto = cassa.put.find((b) => b.includes('<c:Tavolo>W4</c:Tavolo>'))!;
        const copertoXml = /<c:PMBRigaComanda>(?:(?!<\/c:PMBRigaComanda>)[\s\S])*<c:TipoEnum>Coperto<\/c:TipoEnum>[\s\S]*?<\/c:PMBRigaComanda>/.exec(scritto)![0];
        expect(copertoXml).not.toContain('<c:Prezzo>');
        // In cassa battono anche una tisana.
        c.righe.push({ id: 990_001, articolo: 'VARIE', descrizione: 'Tisana', pezzi: 1, prezzo: 1.5, uscita: 1, stato: 'Nuovo', tipo: 'Semplice', varianti: [] });

        const chiusa = await api().post(`/orders/${ordine}/close`).set(bearer(token)).send({});
        expect(chiusa.status).toBe(200);
        // 2 coperti × 3 € + gnocchi 12 € + tisana 1,50 €.
        expect(chiusa.body.bill).toMatchObject({ external_ref: `pp:comanda:${c.id}`, total_cents: 600 + 1200 + 150, residual_cents: 1950 });
        expect((chiusa.body.bill.items as any[]).map((i) => i.name)).toEqual(expect.arrayContaining(['Tisana']));
        const o = (await db.query(`SELECT status, table_bill_id FROM orders WHERE id = $1`, [ordine])).rows[0];
        expect(o).toMatchObject({ status: 'CLOSED', table_bill_id: chiusa.body.bill.id });
        await db.query(`DELETE FROM table_bills WHERE id = $1`, [chiusa.body.bill.id]);
    });
});

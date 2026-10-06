import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Client } from 'pg';
import { io as ioClient, type Socket } from 'socket.io-client';
import { api, bearer, ownerToken } from './helpers';

// Conti della cassa Passepartout nel CRM (sola lettura): import dal giro,
// collegamento a prenotazione e tavolo, origine «crm» per i conti del CRM
// chiusi in cassa (niente doppio conteggio), e le letture: dettaglio
// prenotazione, spesa del cliente, riquadro nei report, riscontro.

const AGENT_TOKEN = 'test-pp-agent-token';
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const oggi = () => new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Rome' }).format(new Date());
const TELEFONO = '347 909 1234';

describe('conti della cassa Passepartout nel CRM', () => {
    let token: string;
    let db: Client;
    let socket: Socket | null = null;
    let reservationId: number;
    let customerId: number;
    let tableId: number;
    const bill: Record<string, number> = {};

    const conto = (o: Record<string, any>) => ({
        idComanda: null, chiusoAt: `${oggi()}T21:30:00`, coperti: 2, totaleDocumento: 0, totalePagato: 0, sospeso: 0,
        stato: 'Pagato', tipoConto: 'Unico', tipoDocumento: 'Scontrino', numeroScontrino: null, pagamenti: [],
        tavolo: null, sala: null, idPrenotazione: null, ...o,
    });

    const contiDiOggi = () => [
        // Tavolo aperto dal planning e chiuso in cassa: è della prenotazione.
        conto({
            idConto: 7002, idComanda: 5002, idPrenotazione: 900, tavolo: 'PPC40', sala: 'DENTRO', coperti: 4,
            totaleDocumento: 120.5, totalePagato: 120.5, numeroScontrino: '0001-0001',
            pagamenti: [{ codice: 'CONTANTI', categoria: 'Contanti', importo: 100 }, { codice: 'POS', categoria: 'CartaCredito1', importo: 20.5 }],
        }),
        // Conto del CRM importato dalla cassa e chiuso lì: già nei table_bills.
        conto({ idConto: 7001, idComanda: 5001, totaleDocumento: 50, totalePagato: 50, pagamenti: [{ codice: 'ESTERNO', categoria: 'Varie1', importo: 50 }] }),
        // Pagato «esterno» ma il CRM non ne ha il conto: da riscontrare.
        conto({ idConto: 7003, idComanda: 5003, totaleDocumento: 30, totalePagato: 30, pagamenti: [{ codice: 'ESTERNO', categoria: 'Varie1', importo: 30 }] }),
        // Annullato: non è incasso.
        conto({ idConto: 7004, idComanda: 5004, totaleDocumento: 10, totalePagato: 10, stato: 'Annullato', pagamenti: [{ codice: 'CONTANTI', importo: 10 }] }),
        // Conto del CRM chiuso in cassa con un importo diverso.
        conto({ idConto: 7005, idComanda: 5005, totaleDocumento: 41, totalePagato: 41, pagamenti: [{ codice: 'ESTERNO', importo: 41 }] }),
    ];

    const finoA = async (cond: () => Promise<boolean>, descr: string, timeoutMs = 8_000) => {
        const deadline = Date.now() + timeoutMs;
        for (;;) {
            if (await cond()) return;
            if (Date.now() > deadline) throw new Error(`Timeout: ${descr}`);
            await sleep(150);
        }
    };

    const contoBill = async (ref: string, cents: number) => {
        const r = await db.query(
            `INSERT INTO table_bills (tenant_id, table_id, total_cents, covers, status, closed_at, external_ref, service_date)
             VALUES (1, $4, $1, 2, 'CLOSED', now(), $2, $3::date) RETURNING id`,
            [cents, ref, oggi(), tableId]
        );
        return Number(r.rows[0].id);
    };

    beforeAll(async () => {
        token = await ownerToken();
        db = new Client({ connectionString: process.env.DATABASE_URL || 'postgresql://localhost/ristotest_api' });
        await db.connect();
        await api().put('/settings/entitlements').set(bearer(token)).send({ passepartout: true });

        const room = await api().post('/rooms').set(bearer(token)).send({ name: 'Sala Conti PP', width: 600, height: 400 });
        const table = await api().post('/tables').set(bearer(token)).send({
            name: 'PPC40', shape: 'SQUARE', seats: 4, x: 40, y: 40, room_id: room.body.id, status: 'FREE',
        });
        tableId = table.body.id;
        await db.query(
            `INSERT INTO passepartout_tavoli (table_id, tenant_id, pp_sala, pp_tavolo, origine, confermato) VALUES ($1, 1, 'DENTRO', 'PPC40', 'manuale', true)`,
            [tableId]
        );
        const resv = await api().post('/reservations').set(bearer(token)).send({
            customer_name: 'Conti Cassa', phone: TELEFONO, reservation_time: new Date(Date.now() + 3600_000).toISOString(),
            shift: 'DINNER', guests: 4, table_id: tableId,
        });
        expect(resv.status).toBe(201);
        reservationId = resv.body.id;
        await db.query(
            `INSERT INTO passepartout_prenotazioni (tenant_id, reservation_id, tag, pp_id, pp_giorno, stato_scritto)
             VALUES (1, $1, $2, 900, $3::date, 'Confermata')`,
            [reservationId, `sympotia:${reservationId}`, oggi()]
        );
        const cust = await db.query(
            `INSERT INTO customers (tenant_id, name, phone) VALUES (1, 'Conti Cassa', $1)
             ON CONFLICT DO NOTHING RETURNING id`, [TELEFONO]
        );
        // La prenotazione può aver già aperto la scheda in rubrica (col numero
        // normalizzato): si cerca per ultime 10 cifre, come fa la rubrica.
        customerId = cust.rows[0]?.id ?? (await db.query(
            `SELECT id FROM customers WHERE tenant_id = 1 AND right(regexp_replace(phone, '\\D', '', 'g'), 10) = $1 ORDER BY id LIMIT 1`,
            [TELEFONO.replace(/\D/g, '')]
        )).rows[0].id;

        bill.uguale = await contoBill('pp:comanda:5001', 5000);
        bill.mancante = await contoBill('pp:comanda:5009', 2000);
        bill.diverso = await contoBill('pp:comanda:5005', 4000);

        socket = ioClient(`${process.env.TEST_BASE_URL}/pp-agent`, {
            auth: { token: AGENT_TOKEN }, transports: ['websocket'], reconnection: false,
        });
        socket.on('pp:call', (payload: any, ack: (r: unknown) => void) => {
            if (payload?.op === 'contiGiorno') {
                return ack({ ok: true, result: payload.params?.giorno === oggi() ? contiDiOggi() : [] });
            }
            ack({ ok: false, error: `op non prevista: ${payload?.op}`, kind: 'agent' });
        });
        await new Promise<void>((resolve, reject) => {
            socket!.on('connect', () => resolve());
            socket!.on('connect_error', reject);
        });
        socket.emit('agent:hello', { hostname: 'agente-conti', capabilities: ['conti'] });
        await finoA(async () => ((await api().get('/passepartout/status').set(bearer(token))).body.capabilities ?? []).includes('conti'),
            'agente annunciato');
    });

    afterAll(async () => {
        await api().put('/passepartout/conti').set(bearer(token)).send({ enabled: false });
        socket?.close();
        // Niente resti per i file dopo: la prenotazione su un tavolo abbinato
        // e col suo collegamento verrebbe presa dal giro delle prenotazioni.
        await db.query(`DELETE FROM passepartout_conti WHERE tenant_id = 1`);
        await db.query(`DELETE FROM passepartout_prenotazioni WHERE reservation_id = $1`, [reservationId]);
        await db.query(`DELETE FROM passepartout_tavoli WHERE table_id = $1`, [tableId]);
        await api().delete(`/reservations/${reservationId}`).set(bearer(token));
        await db.end();
    });

    it('spenti non si leggono; accesi si importano, con origine e collegamenti', async () => {
        expect((await api().post('/passepartout/conti/importa').set(bearer(token))).status).toBe(409);
        await api().put('/passepartout/conti').set(bearer(token)).send({ enabled: true });

        const r = await api().post('/passepartout/conti/importa').set(bearer(token));
        expect(r.status).toBe(200);
        expect(r.body.esiti).toEqual([{ giorno: oggi(), conti: 5, collegati: 1, crm: 3 }]);

        const rows = (await db.query(
            `SELECT pp_conto_id, origine, reservation_id, table_id, table_bill_id, totale_cents, coperti, numero_scontrino
               FROM passepartout_conti WHERE tenant_id = 1 ORDER BY pp_conto_id`
        )).rows;
        const per = (id: number) => rows.find(x => x.pp_conto_id === id);
        expect(per(7002)).toMatchObject({ origine: 'cassa', reservation_id: reservationId, table_id: tableId, totale_cents: 12050, coperti: 4, numero_scontrino: '0001-0001' });
        expect(per(7001)).toMatchObject({ origine: 'crm', table_bill_id: bill.uguale });
        expect(per(7003)).toMatchObject({ origine: 'crm', table_bill_id: null });

        // Rileggere lo stesso giorno aggiorna, non duplica.
        await api().post('/passepartout/conti/importa').set(bearer(token));
        expect((await db.query(`SELECT COUNT(*)::int AS n FROM passepartout_conti WHERE tenant_id = 1`)).rows[0].n).toBe(5);

        const stato = await api().get('/passepartout/conti').set(bearer(token));
        expect(stato.body).toMatchObject({ enabled: true, oggi: { conti: 1, totale_cents: 12050 }, agente: { collegato: true, aggiornato: true } });
    });

    it('la prenotazione mostra il suo conto in cassa, e il cliente quanto ha speso', async () => {
        const c = await api().get(`/reservations/${reservationId}/conto-cassa`).set(bearer(token));
        expect(c.status).toBe(200);
        expect(c.body.conti).toHaveLength(1);
        expect(c.body.conti[0]).toMatchObject({ totale_cents: 12050, tavolo: 'PPC40', coperti: 4, numero_scontrino: '0001-0001' });

        const s = await api().get(`/customers/${customerId}/spesa`).set(bearer(token));
        expect(s.status).toBe(200);
        expect(s.body).toMatchObject({ totale_cents: 12050, visite: 1, medio_coperto_cents: 3013, conti_cassa: 1 });
    });

    it('il report incassi ha i tavoli chiusi solo in cassa, fuori dai totali CRM', async () => {
        const r = await api().get(`/reports/revenue?from=${oggi()}&to=${oggi()}`).set(bearer(token));
        expect(r.status).toBe(200);
        expect(r.body.cassa_passepartout).toMatchObject({ totale_cents: 12050, conti: 1, coperti: 4 });
        expect(r.body.cassa_passepartout.per_metodo).toEqual([
            { codice: 'CONTANTI', importo_cents: 10000 },
            { codice: 'POS', importo_cents: 2050 },
        ]);
    });

    it('il riscontro trova il conto mancante in cassa, l\'importo diverso e l\'esterno senza conto CRM', async () => {
        const r = await api().get(`/reports/riscontro-cassa?date=${oggi()}`).set(bearer(token));
        expect(r.status).toBe(200);
        expect(r.body.importato).toBe(true);
        expect(r.body.mancanti_in_cassa.map((m: any) => m.bill_id)).toContain(bill.mancante);
        expect(r.body.importi_diversi).toEqual(expect.arrayContaining([
            expect.objectContaining({ bill_id: bill.diverso, crm_cents: 4000, cassa_cents: 4100 }),
        ]));
        expect(r.body.importi_diversi.map((d: any) => d.bill_id)).not.toContain(bill.uguale);
        expect(r.body.esterni_senza_crm.map((e: any) => e.pp_conto_id)).toEqual([7003]);
        expect(r.body.cassa_solo).toMatchObject({ conti: 1, totale_cents: 12050 });
    });
});

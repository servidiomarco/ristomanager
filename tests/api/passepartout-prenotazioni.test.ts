import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Client } from 'pg';
import { io as ioClient, type Socket } from 'socket.io-client';
import { api, bearer, ownerToken } from './helpers';

// Prenotazioni del CRM nel planning della cassa Passepartout, e arrivi di
// ritorno (prova sulla cassa vera del 06/10/2026). Un agente finto tiene
// le prenotazioni «della cassa» in una Map e risponde come l'agente vero:
// scrive solo se lo stato in cassa è quello che il CRM si aspetta.

const AGENT_TOKEN = 'test-pp-agent-token';
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

const PIANTA = [
    { sala: 'DENTRO', tavoli: [{ nome: 'PP40', coperti: 4 }, { nome: 'PP41', coperti: 4 }, { nome: 'PP24.', coperti: 2 }, { nome: 'PP23.', coperti: 2 }] },
    { sala: 'FIUME', tavoli: [{ nome: 'PP23', coperti: 2 }, { nome: 'PP3BIS', coperti: 2 }] },
];

interface InCassa { idGestionale: number; stato: string; tag: string; dataOra: string; [k: string]: any }

describe('prenotazioni in cassa Passepartout', () => {
    let token: string;
    let db: Client;
    let socket: Socket | null = null;
    const calls: Array<{ op: string; params: any }> = [];
    const cassa = new Map<number, InCassa>();
    let nextId = 500;
    const tavoli: Record<string, number> = {};

    const romaLocale = (iso: string) => {
        const d = new Date(iso);
        const giorno = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Rome' }).format(d);
        const ora = new Intl.DateTimeFormat('it-IT', { timeZone: 'Europe/Rome', hour: '2-digit', minute: '2-digit', hour12: false }).format(d);
        return `${giorno}T${ora}:00`;
    };
    const fraGiorni = (giorni: number, oraUtc: number) => {
        const d = new Date(Date.now() + giorni * 86_400_000);
        d.setUTCHours(oraUtc, 0, 0, 0);
        return d.toISOString();
    };

    const finoA = async (cond: () => Promise<boolean>, descr: string, timeoutMs = 8_000) => {
        const deadline = Date.now() + timeoutMs;
        for (;;) {
            if (await cond()) return;
            if (Date.now() > deadline) throw new Error(`Timeout: ${descr}`);
            await sleep(150);
        }
    };

    const startAgent = async () => {
        socket = ioClient(`${process.env.TEST_BASE_URL}/pp-agent`, {
            auth: { token: AGENT_TOKEN }, transports: ['websocket'], reconnection: false,
        });
        socket.on('pp:call', (payload: any, ack: (r: unknown) => void) => {
            const p = payload?.params ?? {};
            calls.push({ op: payload?.op, params: p });
            if (payload?.op === 'piantaSale') return ack({ ok: true, result: PIANTA });
            if (payload?.op === 'prenotazioniGiorno') {
                return ack({ ok: true, result: [...cassa.values()].filter(c => c.dataOra.startsWith(p.giorno)) });
            }
            if (payload?.op === 'prenotazione') {
                if (p.azione === 'annulla') {
                    const c = p.idGestionale != null ? cassa.get(p.idGestionale) : [...cassa.values()].find(x => x.tag === p.tag);
                    if (!c) return ack({ ok: true, result: { esito: 'mancante', prenotazione: null } });
                    if (p.statoAtteso && c.stato !== p.statoAtteso && c.stato !== 'Mancata') {
                        return ack({ ok: true, result: { esito: 'cambiata_in_cassa', prenotazione: c } });
                    }
                    c.stato = 'Mancata';
                    return ack({ ok: true, result: { esito: 'scritta', prenotazione: c } });
                }
                let id = p.idGestionale;
                if (id == null) id = [...cassa.values()].find(x => x.tag === p.tag)?.idGestionale ?? null;
                if (id != null) {
                    const c = cassa.get(id);
                    if (!c) return ack({ ok: true, result: { esito: 'mancante', prenotazione: null } });
                    if (p.statoAtteso && c.stato !== p.statoAtteso) {
                        return ack({ ok: true, result: { esito: 'cambiata_in_cassa', prenotazione: c } });
                    }
                }
                const salvata: InCassa = { ...p, idGestionale: id ?? nextId++, stato: p.stato };
                delete salvata.statoAtteso;
                cassa.set(salvata.idGestionale, salvata);
                return ack({ ok: true, result: { esito: 'scritta', prenotazione: salvata } });
            }
            ack({ ok: false, error: `op non prevista: ${payload?.op}`, kind: 'agent' });
        });
        await new Promise<void>((resolve, reject) => {
            socket!.on('connect', () => resolve());
            socket!.on('connect_error', reject);
        });
        socket.emit('agent:hello', { hostname: 'agente-di-prova', capabilities: ['chiudi-riprendi', 'prenotazioni'] });
        await finoA(async () => {
            const st = await api().get('/passepartout/status').set(bearer(token));
            return st.body.connected === true && (st.body.capabilities ?? []).includes('prenotazioni');
        }, 'agente annunciato');
    };

    const sincronizza = async () => {
        const res = await api().post('/passepartout/prenotazioni/sincronizza').set(bearer(token));
        expect(res.status).toBe(200);
        return res.body;
    };
    const chiamate = (op: string) => calls.filter(c => c.op === op);
    const link = async (reservationId: number) => (await db.query(
        `SELECT * FROM passepartout_prenotazioni WHERE reservation_id = $1`, [reservationId]
    )).rows[0];

    const creaPrenotazione = async (body: Record<string, any>) => {
        const res = await api().post('/reservations').set(bearer(token)).send({
            shift: 'DINNER', guests: 2, phone: '340 555 4040', ...body,
        });
        expect(res.status).toBe(201);
        return res.body;
    };
    const aggiorna = async (resv: any, patch: Record<string, any>) => {
        const res = await api().put(`/reservations/${resv.id}`).set(bearer(token)).send({
            customer_name: resv.customer_name, phone: resv.phone, reservation_time: resv.reservation_time,
            shift: resv.shift, guests: resv.guests, children: resv.children, table_id: resv.table_id,
            notes: resv.notes, ...patch,
        });
        expect(res.status).toBe(200);
        return res.body;
    };

    beforeAll(async () => {
        token = await ownerToken();
        db = new Client({ connectionString: process.env.DATABASE_URL || 'postgresql://localhost/ristotest_api' });
        await db.connect();
        await api().put('/settings/entitlements').set(bearer(token)).send({ passepartout: true });
        const veranda = await api().post('/rooms').set(bearer(token)).send({ name: 'Veranda PP', width: 900, height: 600 });
        const fuori = await api().post('/rooms').set(bearer(token)).send({ name: 'Fuori PP', width: 900, height: 600 });
        let x = 40;
        for (const [nome, roomId] of [['PP40', veranda.body.id], ['PP41', veranda.body.id], ['PP24', veranda.body.id], ['PP23', veranda.body.id], ['PP3 Bis', fuori.body.id]] as const) {
            const t = await api().post('/tables').set(bearer(token)).send({
                name: nome, shape: 'SQUARE', seats: 4, x, y: 300, room_id: roomId, status: 'FREE',
            });
            expect(t.status).toBe(201);
            tavoli[nome] = t.body.id;
            x += 80;
        }
    });

    afterAll(async () => {
        await api().put('/passepartout/prenotazioni').set(bearer(token)).send({ enabled: false });
        socket?.close();
        await db.end();
    });

    it('senza l\'add-on la scheda non risponde; senza agente non si sincronizza', async () => {
        await api().put('/settings/entitlements').set(bearer(token)).send({ passepartout: false });
        expect((await api().get('/passepartout/prenotazioni').set(bearer(token))).status).toBe(403);
        await api().put('/settings/entitlements').set(bearer(token)).send({ passepartout: true });

        const st = await api().get('/passepartout/prenotazioni').set(bearer(token));
        expect(st.status).toBe(200);
        expect(st.body.enabled).toBe(false);
        expect(st.body.agente.collegato).toBe(false);
        expect((await api().post('/passepartout/prenotazioni/sincronizza').set(bearer(token))).status).toBe(503);
    });

    it('abbina i tavoli: nome identico nella sala della stanza = sicuro, somiglianza da confermare', async () => {
        await startAgent();
        const res = await api().post('/passepartout/tavoli/abbina').set(bearer(token));
        expect(res.status).toBe(200);
        const per = (nome: string) => res.body.tavoli.find((t: any) => t.table_id === tavoli[nome]);
        expect(per('PP40')).toMatchObject({ pp_sala: 'DENTRO', pp_tavolo: 'PP40', origine: 'auto', confermato: true });
        // «24» → «24.»: la variante col punto, da confermare.
        expect(per('PP24')).toMatchObject({ pp_sala: 'DENTRO', pp_tavolo: 'PP24.', confermato: false });
        // «23» esiste identico in FIUME, ma la stanza finisce in DENTRO (40 e
        // 41 identici lì): in DENTRO c'è «23.».
        expect(per('PP23')).toMatchObject({ pp_sala: 'DENTRO', pp_tavolo: 'PP23.', confermato: false });
        // Stanza senza voti: la somiglianza unica in tutta la cassa.
        expect(per('PP3 Bis')).toMatchObject({ pp_sala: 'FIUME', pp_tavolo: 'PP3BIS', confermato: false });
        expect(res.body.pianta).toEqual(PIANTA);

        // Conferma a mano; un tavolo che in cassa non c'è viene rifiutato.
        const ok = await api().put(`/passepartout/tavoli/${tavoli['PP3 Bis']}`).set(bearer(token))
            .send({ pp_sala: 'FIUME', pp_tavolo: 'PP3BIS' });
        expect(ok.body).toMatchObject({ origine: 'manuale', confermato: true });
        const ko = await api().put(`/passepartout/tavoli/${tavoli['PP3 Bis']}`).set(bearer(token))
            .send({ pp_sala: 'FIUME', pp_tavolo: 'NON-ESISTE' });
        expect(ko.status).toBe(400);

        // Un secondo abbinamento non tocca quello fatto a mano.
        const di_nuovo = await api().post('/passepartout/tavoli/abbina').set(bearer(token));
        expect(di_nuovo.body.tavoli.find((t: any) => t.table_id === tavoli['PP3 Bis'])).toMatchObject({ origine: 'manuale', confermato: true });
    });

    it('spenta non scrive niente; accesa scrive la prenotazione con tavolo confermato, e solo quando cambia', async () => {
        const resv = await creaPrenotazione({
            customer_name: 'Rossi Cassa', reservation_time: fraGiorni(2, 18), guests: 4, children: 1,
            notes: 'Seggiolone', table_id: tavoli.PP40,
        });
        // Tavolo con abbinamento ancora da confermare: non va in cassa.
        await creaPrenotazione({ customer_name: 'Bianchi Dubbio', reservation_time: fraGiorni(2, 18), table_id: tavoli.PP24 });

        const spenta = await sincronizza();
        expect(spenta.saltato).toBe('spento');
        expect(chiamate('prenotazione')).toHaveLength(0);

        await api().put('/passepartout/prenotazioni').set(bearer(token)).send({ enabled: true });
        const giro = await sincronizza();
        expect(giro).toMatchObject({ scritte: 1, errori: 0 });
        const [scritta] = chiamate('prenotazione');
        expect(scritta.params).toMatchObject({
            tag: `sympotia:${resv.id}`, sala: 'DENTRO', tavoli: ['PP40'], intestazione: 'Rossi Cassa',
            numeroPersone: 4, adulti: 3, bambini: 1, note: 'Seggiolone', telefono: resv.phone,
            dataOra: romaLocale(resv.reservation_time), durata: 120, stato: 'Confermata', idGestionale: null,
        });
        const l = await link(resv.id);
        expect(l).toMatchObject({ pp_id: 500, stato_scritto: 'Confermata', gestita_in_cassa: false, last_error: null });

        // Niente di nuovo: nessuna scrittura.
        expect(await sincronizza()).toMatchObject({ scritte: 0 });
        expect(chiamate('prenotazione')).toHaveLength(1);

        // La nota cambia: si aggiorna la STESSA prenotazione della cassa.
        await aggiorna(resv, { notes: 'Seggiolone, celiaco' });
        expect(await sincronizza()).toMatchObject({ scritte: 1 });
        const seconda = chiamate('prenotazione')[1];
        expect(seconda.params).toMatchObject({ idGestionale: 500, statoAtteso: 'Confermata', note: 'Seggiolone, celiaco' });
        expect(cassa.size).toBe(1);
    });

    it('la caparra pagata online finisce nella nota in cassa; rimborsata, sparisce', async () => {
        const resv = await creaPrenotazione({
            customer_name: 'Caparra Cassa', reservation_time: fraGiorni(7, 18), table_id: tavoli.PP40, notes: 'Compleanno',
        });
        const pr = await db.query(
            `INSERT INTO payment_requests (tenant_id, reservation_id, amount_cents, status, provider, completed_at)
             VALUES (1, $1, 4000, 'COMPLETED', 'revolut', now()) RETURNING id`,
            [resv.id]
        );
        // Una richiesta non pagata non conta.
        await db.query(
            `INSERT INTO payment_requests (tenant_id, reservation_id, amount_cents, status, provider) VALUES (1, $1, 999, 'PENDING', 'revolut')`,
            [resv.id]
        );
        await sincronizza();
        const scritta = chiamate('prenotazione').filter(c => c.params.tag === `sympotia:${resv.id}`).pop();
        expect(scritta?.params.note).toBe('Compleanno · Caparra pagata 40,00 euro');

        await db.query(`UPDATE payment_requests SET status = 'REFUNDED' WHERE id = $1`, [pr.rows[0].id]);
        await sincronizza();
        const dopo = chiamate('prenotazione').filter(c => c.params.tag === `sympotia:${resv.id}`).pop();
        expect(dopo?.params.note).toBe('Compleanno');
        await api().delete(`/reservations/${resv.id}`).set(bearer(token));
        await sincronizza();
    });

    it('annullata nel CRM → «Mancata» in cassa; cancellata → «Mancata» anche senza la prenotazione', async () => {
        const annullata = await creaPrenotazione({ customer_name: 'Verdi Annulla', reservation_time: fraGiorni(3, 18), table_id: tavoli.PP40 });
        const cancellata = await creaPrenotazione({ customer_name: 'Neri Cancella', reservation_time: fraGiorni(4, 18), table_id: tavoli.PP40 });
        await sincronizza();
        const idAnnullata = (await link(annullata.id)).pp_id;
        const idCancellata = (await link(cancellata.id)).pp_id;
        expect(cassa.get(idAnnullata)?.stato).toBe('Confermata');

        await aggiorna(annullata, { reservation_status: 'CANCELLED' });
        expect((await api().delete(`/reservations/${cancellata.id}`).set(bearer(token))).status).toBeLessThan(300);
        const giro = await sincronizza();
        expect(giro.annullate).toBe(2);
        expect(cassa.get(idAnnullata)?.stato).toBe('Mancata');
        expect(cassa.get(idCancellata)?.stato).toBe('Mancata');
        expect((await link(annullata.id)).stato_scritto).toBe('Mancata');
        const orfana = (await db.query(`SELECT * FROM passepartout_prenotazioni WHERE pp_id = $1`, [idCancellata])).rows[0];
        expect(orfana).toMatchObject({ reservation_id: null, stato_scritto: 'Mancata' });

        // Già annullate: il giro dopo non le riscrive.
        const prima = chiamate('prenotazione').length;
        await sincronizza();
        expect(chiamate('prenotazione').length).toBe(prima);
    });

    it('tavolo aperto in cassa dalla prenotazione → «Arrivato» nel CRM, e la cassa non viene più toccata', async () => {
        const resv = await creaPrenotazione({ customer_name: 'Gialli Arriva', reservation_time: fraGiorni(5, 18), table_id: tavoli.PP40 });
        await sincronizza();
        const l = await link(resv.id);
        // Il giro degli arrivi guarda le prenotazioni di oggi in cassa.
        const oggi = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Rome' }).format(new Date());
        await db.query(`UPDATE passepartout_prenotazioni SET pp_giorno = $2::date WHERE id = $1`, [l.id, oggi]);
        const c = cassa.get(l.pp_id)!;
        c.dataOra = `${oggi}T20:00:00`;
        c.stato = 'Chiusa';

        const giro = await sincronizza();
        expect(giro.arrivi).toBe(1);
        const dopo = (await db.query(`SELECT arrival_status FROM reservations WHERE id = $1`, [resv.id])).rows[0];
        expect(dopo.arrival_status).toBe('ARRIVED');
        expect(await link(resv.id)).toMatchObject({ gestita_in_cassa: true, stato_cassa: 'Chiusa' });
        const ev = await db.query(
            `SELECT actor FROM outbox_events WHERE event = 'reservation:service-updated' AND aggregate = $1 ORDER BY id DESC LIMIT 1`,
            [`reservation:${resv.id}`]
        );
        expect(ev.rows[0].actor).toEqual({ channel: 'passepartout' });

        // Cambi successivi nel CRM non toccano più la prenotazione della cassa.
        const prima = chiamate('prenotazione').length;
        await aggiorna({ ...resv, arrival_status: 'ARRIVED' }, { notes: 'Dopo l\'arrivo', arrival_status: 'ARRIVED' });
        await sincronizza();
        expect(chiamate('prenotazione').length).toBe(prima);
    });

    it('la cassa ha cambiato lo stato prima di un aggiornamento: il CRM non lo sovrascrive', async () => {
        const resv = await creaPrenotazione({ customer_name: 'Blu Mancata', reservation_time: fraGiorni(6, 18), table_id: tavoli.PP40 });
        await sincronizza();
        const l = await link(resv.id);
        cassa.get(l.pp_id)!.stato = 'Mancata';

        await aggiorna(resv, { notes: 'Arriva in ritardo' });
        const giro = await sincronizza();
        expect(giro).toMatchObject({ scritte: 0, prese_in_cassa: 1 });
        expect(cassa.get(l.pp_id)?.stato).toBe('Mancata');
        expect(await link(resv.id)).toMatchObject({ gestita_in_cassa: true, stato_cassa: 'Mancata' });
        const stato = await api().get('/passepartout/prenotazioni').set(bearer(token));
        expect(stato.body).toMatchObject({ enabled: true, agente: { collegato: true, aggiornato: true } });
    });
});

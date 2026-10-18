import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import crypto from 'crypto';
import { Client } from 'pg';
import { io as ioClient, type Socket } from 'socket.io-client';
import { api, ownerToken, bearer } from './helpers';
// Il sorgente, non dist: la logica non ha dipendenze (vedi event-registry).
import { reservationUpdateNotice } from '../../utils/reservationNotice';
import type { Reservation } from '../../types';

// Gli esiti dei messaggi all'ospite e i toast. Il 18/10 una prenotazione
// appena creata ha dato quattro «Prenotazione aggiornata» in mezzo minuto,
// una per stato di Twilio (invio, sent, delivered, read), uguali e impilate.
// Ora il toast dice che cosa è cambiato («Conferma WhatsApp consegnata a
// …»), uno stato ripetuto o in ritardo non produce niente, e la riga
// trasmessa è arricchita come nella GET.

const AUTH_TOKEN = 'test-twilio-auth-token';

const connetti = (token: string): Promise<Socket> => new Promise((resolve, reject) => {
    const socket = ioClient(process.env.TEST_BASE_URL as string, {
        transports: ['websocket', 'polling'],
        auth: { token },
        timeout: 10_000,
    });
    const fallisci = (e: Error) => { clearTimeout(t); socket.close(); reject(e); };
    const t = setTimeout(() => fallisci(new Error('socket non connesso')), 10_000);
    socket.on('connect', () => { clearTimeout(t); resolve(socket); });
    socket.on('connect_error', fallisci);
});

const riga = (extra: Partial<Reservation> = {}): Reservation => ({
    id: 1, customer_name: 'Calafiore Antonio', reservation_time: '2026-10-19T18:30:00.000Z',
    shift: 'DINNER' as Reservation['shift'], guests: 2, payment_status: 'PENDING' as Reservation['payment_status'],
    reservation_status: 'CONFIRMED' as Reservation['reservation_status'], arrival_status: 'WAITING' as Reservation['arrival_status'],
    confirmation_status: null, confirmation_channel: null, reminder_sent: false,
    guest_confirmed_at: null, guest_cancelled_at: null,
    ...extra,
});

describe('quale toast per un reservation:updated', () => {
    const inviata = riga({ confirmation_status: 'queued', confirmation_channel: 'whatsapp', confirmation_sent_at: '2026-10-18T11:23:35.847Z' });

    it('ogni passo della conferma ha la sua frase, e queued → sent tace', () => {
        expect(reservationUpdateNotice(riga(), inviata)).toEqual({ key: 'confirmSentNamed', vars: { canale: 'WhatsApp' } });
        expect(reservationUpdateNotice(inviata, { ...inviata, confirmation_status: 'sent' })).toBeNull();
        const consegnata = { ...inviata, confirmation_status: 'delivered' as const, confirmation_delivered_at: '2026-10-18T11:23:42.839Z' };
        expect(reservationUpdateNotice({ ...inviata, confirmation_status: 'sent' }, consegnata))
            .toEqual({ key: 'confirmDeliveredNamed', vars: { canale: 'WhatsApp' } });
        expect(reservationUpdateNotice(consegnata, { ...consegnata, confirmation_status: 'read' }))
            .toEqual({ key: 'confirmReadNamed', vars: { canale: 'WhatsApp' } });
        expect(reservationUpdateNotice(inviata, { ...inviata, confirmation_status: 'undelivered', confirmation_error: '63016' }))
            .toMatchObject({ key: 'confirmFailedNamed', tone: 'error' });
        expect(reservationUpdateNotice(riga(), riga({ confirmation_status: 'sent', confirmation_channel: 'email' })))
            .toEqual({ key: 'confirmSentNamed', vars: { canale: 'email' } });
    });

    it("stato, arrivo e risposte dell'ospite hanno la loro frase", () => {
        // La frase del picker di stato («…: stato → Arrivato»), che l'eco
        // ripete identica a chi ha cambiato lo stato: il dedup le fonde.
        expect(reservationUpdateNotice(riga({ reservation_status: 'PENDING' as Reservation['reservation_status'] }), riga()))
            .toEqual({ key: 'stateChangedNamed', state: 'waiting' });
        expect(reservationUpdateNotice(riga(), riga({ arrival_status: 'ARRIVED' as Reservation['arrival_status'] })))
            .toEqual({ key: 'stateChangedNamed', state: 'arrived' });
        // Arrivato su un tavolo in ritardo allunga la durata; annullata stacca il tavolo.
        expect(reservationUpdateNotice(riga({ table_id: 4 }), riga({ table_id: 4, arrival_status: 'ARRIVED' as Reservation['arrival_status'], duration_minutes: 150 })))
            .toEqual({ key: 'stateChangedNamed', state: 'arrived' });
        expect(reservationUpdateNotice(riga({ table_id: 4 }), riga({ reservation_status: 'CANCELLED' as Reservation['reservation_status'] })))
            .toEqual({ key: 'stateChangedNamed', state: 'cancelled' });
        expect(reservationUpdateNotice(riga(), riga({ guest_confirmed_at: '2026-10-18T12:00:00.000Z' })))
            .toEqual({ key: 'guestConfirmedNamed' });
        // L'annullamento dell'ospite si porta dietro lo stato: vince la frase dell'ospite.
        expect(reservationUpdateNotice(riga(), riga({ guest_cancelled_at: '2026-10-18T12:00:00.000Z', reservation_status: 'CANCELLED' as Reservation['reservation_status'] })))
            .toEqual({ key: 'guestCancelledNamed' });
    });

    it('il resto resta «Prenotazione aggiornata», anche quando cambia più di una cosa', () => {
        expect(reservationUpdateNotice(riga(), riga({ guests: 4 }))).toEqual({ key: 'bookingUpdatedNamed' });
        expect(reservationUpdateNotice(riga(), riga({ guests: 4, arrival_status: 'ARRIVED' as Reservation['arrival_status'] })))
            .toEqual({ key: 'bookingUpdatedNamed' });
        // Riga sconosciuta, o l'eco di una modifica già applicata dalla risposta HTTP.
        expect(reservationUpdateNotice(undefined, riga())).toEqual({ key: 'bookingUpdatedNamed' });
        expect(reservationUpdateNotice(riga(), riga())).toEqual({ key: 'bookingUpdatedNamed' });
    });

    it("il join della GET non conta: né la sua assenza in una riga nuda, né l'autore", () => {
        const arricchita = riga({ customer_is_vip: true, created_by_user_name: 'Marco', latest_payment_status: null });
        expect(reservationUpdateNotice(arricchita, { ...riga(), confirmation_status: 'queued', confirmation_channel: 'sms' }))
            .toEqual({ key: 'confirmSentNamed', vars: { canale: 'SMS' } });
    });
});

describe('esiti dei messaggi dal webhook di Twilio', () => {
    let db: Client;
    let token = '';
    let socket: Socket;
    let id = 0;
    let sid = '';

    const statoTwilio = (MessageSid: string, MessageStatus: string) => {
        const params: Record<string, string> = { MessageSid, MessageStatus, To: 'whatsapp:+393405551199' };
        const url = `${process.env.TEST_BASE_URL}/webhook/twilio-whatsapp-status`;
        const data = Object.keys(params).sort().reduce((acc, k) => acc + k + params[k], url);
        const signature = crypto.createHmac('sha1', AUTH_TOKEN).update(data).digest('base64');
        return api().post('/webhook/twilio-whatsapp-status').set('X-Twilio-Signature', signature).type('form').send(params);
    };

    /** Gli eventi di questa prenotazione mentre gira `azione`, più una coda. */
    const eventiDurante = async (azione: () => Promise<unknown>, codaMs = 800) => {
        const visti: Array<{ evento: string; riga: any }> = [];
        const su = (evento: string) => (r: any) => { if (r?.id === id) visti.push({ evento, riga: r }); };
        const aggiornata = su('reservation:updated');
        const sincronizzata = su('reservation:synced');
        socket.on('reservation:updated', aggiornata);
        socket.on('reservation:synced', sincronizzata);
        try {
            await azione();
            await new Promise(r => setTimeout(r, codaMs));
        } finally {
            socket.off('reservation:updated', aggiornata);
            socket.off('reservation:synced', sincronizzata);
        }
        return visti;
    };

    beforeAll(async () => {
        token = await ownerToken();
        db = new Client({ connectionString: process.env.DATABASE_URL || 'postgresql://localhost/ristotest_api' });
        await db.connect();
        socket = await connetti(token);
        // Senza telefono né email: nessuna conferma automatica che riscriva
        // il SID sotto al test.
        const res = await api().post('/reservations').set(bearer(token)).send({
            customer_name: 'Esito Messaggio', reservation_time: '2027-04-12T19:30:00.000Z', shift: 'DINNER', guests: 2,
        });
        expect(res.status).toBe(201);
        id = res.body.id;
        sid = `SMesito${Date.now()}`;
        await db.query(
            `UPDATE reservations SET confirmation_provider_sid = $1, confirmation_status = 'queued', confirmation_channel = 'whatsapp' WHERE id = $2`,
            [sid, id]
        );
    });

    afterAll(async () => {
        socket?.disconnect();
        await db.end();
    });

    it('la consegna arriva come reservation:updated arricchita, una volta sola', async () => {
        const visti = await eventiDurante(async () => {
            expect((await statoTwilio(sid, 'delivered')).status).toBe(200);
        });
        expect(visti.map(v => v.evento)).toEqual(['reservation:updated']);
        expect(visti[0].riga.confirmation_status).toBe('delivered');
        // Le colonne del join della GET ci sono: il client sostituisce la
        // riga, e senza di loro il badge VIP si spegneva.
        expect(visti[0].riga).toHaveProperty('customer_is_vip');
        expect(visti[0].riga).toHaveProperty('latest_payment_status');

        const log = await db.query(
            `SELECT payload FROM outbox_events WHERE aggregate = $1 AND event = 'reservation:updated' ORDER BY id DESC LIMIT 1`,
            [`reservation:${id}`]
        );
        expect(log.rows[0]?.payload).toEqual({ reservation_id: id });
    });

    it('lo stesso stato ripetuto, o un «sent» in ritardo, non cambia niente e non trasmette', async () => {
        const visti = await eventiDurante(async () => {
            expect((await statoTwilio(sid, 'delivered')).status).toBe(200);
            expect((await statoTwilio(sid, 'sent')).status).toBe(200);
        });
        expect(visti).toEqual([]);
        const r = await db.query(`SELECT confirmation_status FROM reservations WHERE id = $1`, [id]);
        expect(r.rows[0].confirmation_status).toBe('delivered');
    });

    it('la lettura avanza ancora', async () => {
        const visti = await eventiDurante(async () => {
            expect((await statoTwilio(sid, 'read')).status).toBe(200);
        });
        expect(visti.map(v => [v.evento, v.riga.confirmation_status])).toEqual([['reservation:updated', 'read']]);
    });
});

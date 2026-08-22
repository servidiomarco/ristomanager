import { describe, it, expect, beforeAll } from 'vitest';
import { api, bearer, ownerToken } from './helpers';

// Orario naive: interpretato come wall-clock Europe/Rome (sessione pg del
// pool). Data futura per non dipendere dall'orologio della macchina.
const ORARIO_CENA = '2027-03-10T20:00:00';

describe('reservations', () => {
    let token: string;
    let roomId: number;
    let tableId: number;

    beforeAll(async () => {
        token = await ownerToken();
        const room = await api().post('/rooms').set(bearer(token)).send({
            name: 'Sala Test Prenotazioni',
            width: 800,
            height: 600,
        });
        expect(room.status).toBe(201);
        roomId = room.body.id;

        const table = await api().post('/tables').set(bearer(token)).send({
            name: 'TP1',
            shape: 'SQUARE',
            seats: 4,
            x: 100,
            y: 100,
            room_id: roomId,
            status: 'FREE',
        });
        expect(table.status).toBe(201);
        tableId = table.body.id;
    });

    it('rifiuta la creazione senza token', async () => {
        const res = await api().post('/reservations').send({ customer_name: 'Nessuno' });
        expect(res.status).toBe(401);
    });

    it('rifiuta un turno sconosciuto con 400 (non più 500 dal constraint)', async () => {
        const res = await api().post('/reservations').set(bearer(token)).send({
            customer_name: 'Turno Strano',
            reservation_time: ORARIO_CENA,
            shift: 'BRUNCH',
            guests: 2,
            table_id: tableId,
        });
        expect(res.status).toBe(400);
        expect(res.body.error).toBe('invalid_shift');
    });

    it('crea, lista, aggiorna e cancella una prenotazione', async () => {
        const created = await api().post('/reservations').set(bearer(token)).send({
            customer_name: 'Prova Collaudo',
            reservation_time: ORARIO_CENA,
            shift: 'DINNER',
            guests: 4,
            children: 0,
            table_id: tableId,
            notes: 'smoke test',
        });
        expect(created.status).toBe(201);
        expect(created.body.id).toBeTruthy();
        expect(created.body.customer_name).toBe('Prova Collaudo');
        expect(created.body.reservation_status).toBe('CONFIRMED');
        expect(created.body.arrival_status).toBe('WAITING');
        const id = created.body.id as number;

        const list = await api().get('/reservations').set(bearer(token));
        expect(list.status).toBe(200);
        expect(list.body.some((r: any) => r.id === id)).toBe(true);

        // La PUT non è una PATCH: riscrive tutti i campi, vanno rimandati tutti.
        const updated = await api().put(`/reservations/${id}`).set(bearer(token)).send({
            customer_name: 'Prova Collaudo',
            reservation_time: ORARIO_CENA,
            shift: 'DINNER',
            guests: 6,
            children: 1,
            table_id: tableId,
            notes: 'smoke test aggiornato',
            payment_status: 'PENDING',
            arrival_status: 'WAITING',
            reservation_status: 'CONFIRMED',
        });
        expect(updated.status).toBe(200);
        expect(updated.body.guests).toBe(6);
        expect(updated.body.children).toBe(1);

        const deleted = await api().delete(`/reservations/${id}`).set(bearer(token));
        expect(deleted.status).toBe(204);

        const listDopo = await api().get('/reservations').set(bearer(token));
        expect(listDopo.body.some((r: any) => r.id === id)).toBe(false);
    });

    it('blocca con 409 la doppia prenotazione sullo stesso tavolo e orario', async () => {
        const prima = await api().post('/reservations').set(bearer(token)).send({
            customer_name: 'Primo Ospite',
            reservation_time: ORARIO_CENA,
            shift: 'DINNER',
            guests: 2,
            table_id: tableId,
        });
        expect(prima.status).toBe(201);

        const seconda = await api().post('/reservations').set(bearer(token)).send({
            customer_name: 'Secondo Ospite',
            reservation_time: ORARIO_CENA,
            shift: 'DINNER',
            guests: 2,
            table_id: tableId,
        });
        expect(seconda.status).toBe(409);
        expect(Array.isArray(seconda.body.conflicts)).toBe(true);

        await api().delete(`/reservations/${prima.body.id}`).set(bearer(token));
    });

    it('reminder manuale: guardie su id, telefono e stato; senza provider SMS l\'invio fallisce rumoroso', async () => {
        // Prenotazione senza telefono → 400 no_phone.
        const senzaTel = await api().post('/reservations').set(bearer(token)).send({
            customer_name: 'Reminder Senza Tel',
            reservation_time: ORARIO_CENA,
            shift: 'DINNER',
            guests: 2,
            table_id: tableId,
        });
        expect(senzaTel.status).toBe(201);
        const r1 = await api().post(`/reservations/${senzaTel.body.id}/send-reminder`).set(bearer(token));
        expect(r1.status).toBe(400);
        expect(r1.body.error).toBe('no_phone');

        // Con telefono ma Twilio non configurato nei test: l'endpoint deve
        // fallire ESPLICITO (502), mai fingere l'invio — il vecchio pulsante
        // marcava reminder_sent senza spedire niente.
        const conTel = await api().post('/reservations').set(bearer(token)).send({
            customer_name: 'Reminder Con Tel',
            reservation_time: ORARIO_CENA,
            shift: 'DINNER',
            guests: 2,
            phone: '+39 333 0000001',
        });
        expect(conTel.status).toBe(201);
        const r2 = await api().post(`/reservations/${conTel.body.id}/send-reminder`).set(bearer(token));
        expect(r2.status).toBe(502);
        expect(r2.body.error).toBe('send_failed');
        // E reminder_sent NON deve risultare marcato.
        const dopo = await api().get('/reservations').set(bearer(token));
        const row = dopo.body.find((x: any) => x.id === conTel.body.id);
        expect(row.reminder_sent).toBe(false);

        // Prenotazione cancellata → 409.
        await api().put(`/reservations/${conTel.body.id}`).set(bearer(token)).send({
            customer_name: 'Reminder Con Tel',
            reservation_time: ORARIO_CENA,
            shift: 'DINNER',
            guests: 2,
            phone: '+39 333 0000001',
            reservation_status: 'CANCELLED',
        });
        const r3 = await api().post(`/reservations/${conTel.body.id}/send-reminder`).set(bearer(token));
        expect(r3.status).toBe(409);

        const r404 = await api().post('/reservations/999999/send-reminder').set(bearer(token));
        expect(r404.status).toBe(404);

        await api().delete(`/reservations/${senzaTel.body.id}`).set(bearer(token));
        await api().delete(`/reservations/${conTel.body.id}`).set(bearer(token));
    });
});

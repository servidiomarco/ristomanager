import { describe, it, expect, beforeAll } from 'vitest';
import { api, bearer, ownerToken } from './helpers';

// Identificazione della prenotazione nei tool voce di modifica/cancellazione
// (Tammaro 2026-08-29): il tool ElevenLabs mandava il placeholder letterale
// '{{system__caller_id}}' come phone, e il cliente chiamava comunque da un
// numero diverso da quello registrato. Tre difese sotto test:
//  1. i placeholder non sostituiti vengono scartati (resta il caller_id);
//  2. se il telefono non trova nulla si cerca per nome+data, accenti inclusi;
//  3. senza né cifre né nome il tool risponde invalid_phone, non un 500.
//
// Data futura e telefoni unici per non collidere con gli altri file (i test
// girano sequenziali sullo stesso DB).
const DATA = '2027-05-19';
const ORARIO_CENA = `${DATA}T20:30:00`;
const TELEFONO = '3399911223';
const TELEFONO_ALTRO = '3311144556';

describe('voce: identificazione prenotazione per telefono e nome', () => {
    let token: string;
    let reservationId: number;

    beforeAll(async () => {
        token = await ownerToken();

        // I webhook passano da voiceChannelOpen: serve l'entitlement voice.
        const ent = await api().put('/settings/entitlements').set(bearer(token)).send({ voice: true });
        expect(ent.status).toBe(200);

        // Un tavolo libero per la riassegnazione: la prenotazione nasce senza
        // tavolo e la modifica di orario ne cerca uno.
        const room = await api().post('/rooms').set(bearer(token)).send({
            name: 'Sala Voce Identificazione',
            width: 800,
            height: 600,
        });
        expect(room.status).toBe(201);
        const table = await api().post('/tables').set(bearer(token)).send({
            name: 'VI1',
            shape: 'SQUARE',
            seats: 6,
            x: 100,
            y: 100,
            room_id: room.body.id,
            status: 'FREE',
        });
        expect(table.status).toBe(201);

        const created = await api().post('/reservations').set(bearer(token)).send({
            customer_name: 'Tammaro Prova',
            phone: TELEFONO,
            reservation_time: ORARIO_CENA,
            shift: 'DINNER',
            guests: 4,
            children: 0,
        });
        expect(created.status).toBe(201);
        reservationId = created.body.id;
    });

    it('placeholder non sostituito in phone: vince il caller_id', async () => {
        const res = await api().post('/webhook/elevenlabs/modify-reservation').send({
            phone: '{{system__caller_id}}',
            caller_id: TELEFONO,
            date: DATA,
            new_time: '21:00',
        });
        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.status).toBe('modified');
        expect(res.body.reservation_id).toBe(reservationId);
    });

    it('numero diverso da quello registrato: trova per nome, accenti inclusi', async () => {
        const res = await api().post('/webhook/elevenlabs/modify-reservation').send({
            phone: TELEFONO_ALTRO,
            customer_name: 'Tàmmaro',
            date: DATA,
            new_guests: 5,
        });
        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.status).toBe('modified');
        expect(res.body.reservation_id).toBe(reservationId);
    });

    it('né cifre né nome: invalid_phone, non un errore tecnico', async () => {
        const res = await api().post('/webhook/elevenlabs/modify-reservation').send({
            phone: '{{system__caller_id}}',
            caller_id: '{{system__caller_id}}',
            date: DATA,
            new_time: '21:30',
        });
        expect(res.status).toBe(200);
        expect(res.body.success).toBe(false);
        expect(res.body.error).toBe('invalid_phone');
    });

    it('cancellazione per nome quando il telefono non corrisponde', async () => {
        const res = await api().post('/webhook/elevenlabs/cancel-reservation').send({
            phone: TELEFONO_ALTRO,
            customer_name: 'tammaro',
            date: DATA,
        });
        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.status).toBe('cancelled');
        expect(res.body.reservation_id).toBe(reservationId);
    });
});

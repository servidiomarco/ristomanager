import { describe, it, expect, beforeAll } from 'vitest';
import { api, bearer, ownerToken } from './helpers';

// Modifica via agente vocale quando lo staff ha piazzato più coperti dei
// posti nominali del tavolo (sedia aggiunta). Il check di capienza vale solo
// per gli aumenti: un posticipo di solo orario deve tenere il tavolo, non
// rispondere "unavailable" perché seats < guests (Ciccolini 2026-08-27).
//
// Orario naive: wall-clock Europe/Rome (sessione pg del pool). Data futura
// per non dipendere dall'orologio della macchina; telefono unico per non
// collidere con le prenotazioni degli altri file (la modifica identifica per
// ultime 10 cifre + data).
const DATA = '2027-04-14';
const ORARIO_CENA = `${DATA}T20:30:00`;
const TELEFONO = '3387654321';

describe('modifica voce: capienza del tavolo già assegnato', () => {
    let token: string;
    let tableId: number;
    let reservationId: number;

    const reservationById = async (id: number) => {
        const res = await api().get('/reservations').set(bearer(token));
        expect(res.status).toBe(200);
        return res.body.find((r: any) => r.id === id);
    };

    beforeAll(async () => {
        token = await ownerToken();

        // Il webhook di modifica passa da voiceChannelOpen: serve
        // l'entitlement voice acceso sul tenant.
        const ent = await api().put('/settings/entitlements').set(bearer(token)).send({ voice: true });
        expect(ent.status).toBe(200);

        const room = await api().post('/rooms').set(bearer(token)).send({
            name: 'Sala Voce Modifiche',
            width: 800,
            height: 600,
        });
        expect(room.status).toBe(201);

        const table = await api().post('/tables').set(bearer(token)).send({
            name: 'VM1',
            shape: 'SQUARE',
            seats: 6,
            x: 100,
            y: 100,
            room_id: room.body.id,
            status: 'FREE',
        });
        expect(table.status).toBe(201);
        tableId = table.body.id;

        // 7 coperti su un tavolo da 6: assegnazione manuale dello staff.
        const created = await api().post('/reservations').set(bearer(token)).send({
            customer_name: 'Test Sedia Aggiunta',
            phone: TELEFONO,
            reservation_time: ORARIO_CENA,
            shift: 'DINNER',
            guests: 7,
            children: 0,
            table_id: tableId,
        });
        expect(created.status).toBe(201);
        reservationId = created.body.id;
    });

    it('posticipo di solo orario: modifica riuscita e tavolo mantenuto', async () => {
        const res = await api().post('/webhook/elevenlabs/modify-reservation').send({
            phone: TELEFONO,
            date: DATA,
            new_time: '21:30',
        });
        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.status).toBe('modified');
        expect(res.body.reservation_id).toBe(reservationId);

        const after = await reservationById(reservationId);
        expect(after.table_id).toBe(tableId);
        expect(after.guests).toBe(7);
        // L'API restituisce l'istante UTC: 21:30 Europe/Rome in ora legale.
        expect(String(after.reservation_time)).toBe('2027-04-14T19:30:00.000Z');
    });

    it('aumento coperti: il check di capienza resta attivo', async () => {
        const res = await api().post('/webhook/elevenlabs/modify-reservation').send({
            phone: TELEFONO,
            date: DATA,
            new_guests: 8,
        });
        expect(res.status).toBe(200);

        if (res.body.success) {
            // C'era un tavolo da 8+ libero (creato da altri file di test):
            // la riassegnazione è legittima, ma il tavolo da 6 non basta più.
            const after = await reservationById(reservationId);
            expect(after.table_id).not.toBe(tableId);
        } else {
            expect(res.body.status).toBe('unavailable');
        }
    });
});

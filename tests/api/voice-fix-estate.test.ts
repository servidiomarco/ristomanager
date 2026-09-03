import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { api, bearer, ownerToken } from './helpers';

// I fix nati dall'analisi delle chiamate dell'estate 2026 (2.125 telefonate):
//  - check_availability valida anche l'orario richiesto contro la griglia
//    slot, così l'agente non promette "c'è posto" su orari inesistenti per
//    poi scoprirlo al salvataggio (71 chiamate, 9 clienti persi);
//  - il rifiuto invalid_slot propone i due orari adiacenti, non la lista
//    completa recitata a voce;
//  - la sospensione delle prenotazioni vocali risponde 200 con success:false:
//    ElevenLabs non passa al modello i corpi non-2xx, e col 503 Sofia
//    travestiva la pausa voluta da "problema tecnico" (23 chiamate);
//  - save_callback_request salva il promemoria di richiamata che per tutta
//    l'estate è rimasto solo una frase (0 lead persistiti su 32 promesse);
//  - i cognomi con particella non vengono più troncati ("Confermato De");
//  - "Ferragosto" è una data valida.
// Slot cena del seed: 19:30–23:30 a mezz'ore, quindi 21:15 è fuori griglia.
const DATA = '2027-07-21';

describe('fix estate 2026 del canale voce', () => {
    let token: string;

    beforeAll(async () => {
        token = await ownerToken();
        const ent = await api().put('/settings/entitlements').set(bearer(token)).send({ voice: true });
        expect(ent.status).toBe(200);
    });

    afterAll(async () => {
        await api().put('/settings/features').set(bearer(token)).send({ voice_bookings_suspended: false });
    });

    it('check_availability con orario fuori griglia: lo segnala subito e propone gli adiacenti', async () => {
        const res = await api().post('/webhook/elevenlabs/check-availability').send({
            date: DATA,
            shift: 'DINNER',
            guests: 2,
            time: '21:15',
        });
        expect(res.status).toBe(200);
        expect(res.body.requested_time).toBe('21:15');
        expect(res.body.requested_time_available).toBe(false);
        expect(res.body.nearest_slots).toEqual(['21:00', '21:30']);
        expect(res.body.message).toContain('21:00');
        expect(res.body.message).toContain('21:30');
    });

    it('check_availability con orario in griglia: requested_time_available true', async () => {
        const res = await api().post('/webhook/elevenlabs/check-availability').send({
            date: DATA,
            shift: 'DINNER',
            guests: 2,
            time: '21:00',
        });
        expect(res.status).toBe(200);
        expect(res.body.requested_time).toBe('21:00');
        expect(res.body.requested_time_available).toBe(true);
        // Il message di findAvailability ("siamo al completo" ecc.) resta
        // quello suo: l'orario valido non deve aggiungere avvisi di griglia.
        expect(res.body.nearest_slots).toBeUndefined();
    });

    it('create_reservation fuori griglia: rifiuto con i due orari adiacenti', async () => {
        const res = await api().post('/webhook/elevenlabs/create-reservation').send({
            customer_name: 'Test Adiacenti',
            phone: '3390000001',
            date: DATA,
            time: '21:15',
            shift: 'DINNER',
            guests: 2,
        });
        expect(res.status).toBe(200);
        expect(res.body.success).toBe(false);
        expect(res.body.error).toBe('invalid_slot');
        expect(res.body.nearest_slots).toEqual(['21:00', '21:30']);
        expect(res.body.message).toContain('21:00');
    });

    it('cognome con particella: la conferma non tronca a "De"', async () => {
        const res = await api().post('/webhook/elevenlabs/create-reservation').send({
            customer_name: 'De Franco Chiara',
            phone: '3390000002',
            date: DATA,
            time: '20:30',
            shift: 'DINNER',
            guests: 2,
        });
        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.confirmation_phrase).toContain('De Franco Chiara');
        expect(res.body.confirmation_phrase).not.toMatch(/Confermato De,/);
    });

    it('"Ferragosto" è una data valida, non un invalid_date', async () => {
        const res = await api().post('/webhook/elevenlabs/check-availability').send({
            date: 'Ferragosto',
            shift: 'DINNER',
            guests: 2,
        });
        expect(res.status).toBe(200);
        expect(res.body.error).not.toBe('invalid_date');
        expect(res.body.date_readback).toContain('agosto');
    });

    it('save_callback_request: salva il lead e compare in Conversazioni', async () => {
        const res = await api().post('/webhook/elevenlabs/save-callback-request').send({
            customer_name: 'Gruppo Grande Rossi',
            phone: '3390000003',
            reason: 'gruppo da 14 per sabato sera',
            requested_date: DATA,
            requested_time: '21:00',
            guests: 14,
            conversation_id: 'conv_test_callback_1',
        });
        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.confirmation_phrase).toContain('richiamiamo');

        const list = await api().get('/voice-calls').set(bearer(token)).query({ q: '3390000003' });
        expect(list.status).toBe(200);
        const row = list.body.items.find((c: any) => c.conversation_id === 'conv_test_callback_1');
        expect(row).toBeTruthy();
        expect(row.callback_requested).toBe(true);
        expect(row.callback_name).toContain('Rossi');
        expect(row.callback_reason).toContain('14');
        expect(row.follow_up_status ?? 'PENDING').toBe('PENDING');
    });

    it('save_callback_request senza numero: chiede di raccoglierlo', async () => {
        const res = await api().post('/webhook/elevenlabs/save-callback-request').send({
            customer_name: 'Senza Numero',
            reason: 'come sopra',
        });
        expect(res.status).toBe(200);
        expect(res.body.success).toBe(false);
        expect(res.body.error).toBe('invalid_phone');
    });

    it('sospensione vocale: 200 con success:false e il messaggio da rileggere', async () => {
        const put = await api().put('/settings/features').set(bearer(token)).send({ voice_bookings_suspended: true });
        expect(put.status).toBe(200);

        const res = await api().post('/webhook/elevenlabs/create-reservation').send({
            customer_name: 'Sospeso Test',
            phone: '3390000004',
            date: DATA,
            time: '20:30',
            shift: 'DINNER',
            guests: 2,
        });
        expect(res.status).toBe(200);
        expect(res.body.success).toBe(false);
        expect(res.body.error).toBe('voice_bookings_suspended');
        expect(typeof res.body.message).toBe('string');
        expect(res.body.message.length).toBeGreaterThan(10);

        // Il promemoria di richiamata deve funzionare ANCHE a canale sospeso:
        // è proprio lì che serve di più.
        const cb = await api().post('/webhook/elevenlabs/save-callback-request').send({
            customer_name: 'Sospeso Callback',
            phone: '3390000005',
            reason: 'richiamare quando riaprono le prenotazioni',
            conversation_id: 'conv_test_callback_2',
        });
        expect(cb.status).toBe(200);
        expect(cb.body.success).toBe(true);

        await api().put('/settings/features').set(bearer(token)).send({ voice_bookings_suspended: false });
    });
});

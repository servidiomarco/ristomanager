import { describe, it, expect, beforeAll } from 'vitest';
import { api, bearer, ownerToken } from './helpers';

// Card #34 — i tool voce rispondono nella lingua della chiamata: con
// language/language_code = 'en' nel payload ElevenLabs, confirmation_phrase,
// message e date_readback tornano in inglese (prima il prompt chiedeva
// all'agente di tradurre al volo le risposte italiane). Senza language il
// comportamento resta l'italiano storico: la regressione è il primo test.
// Slot cena del seed: 19:30–23:30 a mezz'ore.
const DATA = '2027-08-03';
const TELEFONO_UK = '+44 7700 900123';

describe('canale voce in inglese', () => {
    beforeAll(async () => {
        const token = await ownerToken();
        const ent = await api().put('/settings/entitlements').set(bearer(token)).send({ voice: true });
        expect(ent.status).toBe(200);
    });

    it('senza language resta tutto in italiano (regressione)', async () => {
        const res = await api().post('/webhook/elevenlabs/check-availability').send({
            date: DATA, shift: 'DINNER', guests: 2,
        });
        expect(res.status).toBe(200);
        expect(res.body.date_readback).toContain('agosto');
    });

    it('check_availability con language en: date_readback e messaggi in inglese', async () => {
        const res = await api().post('/webhook/elevenlabs/check-availability').send({
            date: DATA, shift: 'DINNER', guests: 2, time: '21:15', language_code: 'en',
        });
        expect(res.status).toBe(200);
        expect(res.body.date_readback).toContain('August');
        expect(res.body.requested_time_available).toBe(false);
        expect(res.body.message).toContain('closest times');
    });

    it('create_reservation con language en: confirmation_phrase inglese e lingua salvata', async () => {
        const res = await api().post('/webhook/elevenlabs/create-reservation').send({
            customer_name: 'Emily Watson',
            phone: TELEFONO_UK,
            date: DATA, time: '21:00', shift: 'DINNER', guests: 2,
            language: 'en',
        });
        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.confirmation_phrase).toContain('Confirmed');
        expect(res.body.confirmation_phrase).toContain('August');
        expect(res.body.date_readback).toContain('August');
    });

    it('cancel_reservation con language en: frase di annullo inglese', async () => {
        const res = await api().post('/webhook/elevenlabs/cancel-reservation').send({
            phone: TELEFONO_UK, date: DATA, language: 'en',
        });
        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.confirmation_phrase).toContain('Cancellation confirmed');
    });
});

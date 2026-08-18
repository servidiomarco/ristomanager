import { describe, it, expect } from 'vitest';
import { api } from './helpers';

// Data futura fissa: per la data odierna l'endpoint scarta gli slot già
// passati (ora locale del processo), e il test diventerebbe dipendente
// dall'orologio. Il seed copre tutti e 7 i giorni della settimana.
const DATA_FUTURA = '2027-03-10';

describe('public availability', () => {
    it('rifiuta la richiesta senza data', async () => {
        const res = await api().get('/public/availability');
        expect(res.status).toBe(400);
        expect(res.body.error).toBe('invalid_date');
    });

    it('rifiuta un formato data non valido', async () => {
        const res = await api().get('/public/availability').query({ date: '10/03/2027' });
        expect(res.status).toBe(400);
    });

    it('ritorna gli slot del seed (pranzo 13-14, cena 19:30-23:30, passo 30\')', async () => {
        const res = await api().get('/public/availability').query({ date: DATA_FUTURA });
        expect(res.status).toBe(200);
        expect(res.body.date).toBe(DATA_FUTURA);
        expect(res.body.lunch.slots).toEqual(['13:00', '13:30', '14:00']);
        expect(res.body.dinner.slots).toEqual([
            '19:30', '20:00', '20:30', '21:00', '21:30',
            '22:00', '22:30', '23:00', '23:30',
        ]);
    });
});

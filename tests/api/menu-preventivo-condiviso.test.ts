import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { api, ownerToken, bearer } from './helpers';

// Preventivo condivisibile:
// - POST /banquet-menus/:id/share conia il token una volta sola (link stabile);
// - GET /preventivo/:token è pubblico e racconta menù, tariffe e totali —
//   niente note operative;
// - POST /banquet-menus/:id/send-quote-email valida email e configurazione SMTP.

describe('preventivo condivisibile', () => {
    let token: string;
    let banquetId: number;
    let dishId: number;
    let shareToken: string;

    beforeAll(async () => {
        token = await ownerToken();
        const dish = await api().post('/dishes').set(bearer(token)).send({
            name: 'Piatto preventivo', description: 'Descrizione visibile', price: 20,
            category: 'Secondi', allergens: ['Glutine'],
        });
        expect(dish.status).toBe(201);
        dishId = dish.body.id;
        const created = await api().post('/banquet-menus').set(bearer(token)).send({
            name: 'Preventivo condiviso', description: '', price_per_person: 60,
            guests: 40, children: 10, children_price: 30,
            discount_type: 'AMOUNT', discount_value: 100,
            deposit_amount: 500,
            courses: [{ name: '1ª Uscita', dish_ids: [dishId], notes: 'a scelta' }],
            event_date: '2027-07-01', shift: 'DINNER',
            notes_courses: 'nota interna cucina',
        });
        expect(created.status).toBe(201);
        banquetId = created.body.id;
    });

    afterAll(async () => {
        if (banquetId) await api().delete(`/banquet-menus/${banquetId}`).set(bearer(token));
        if (dishId) await api().delete(`/dishes/${dishId}`).set(bearer(token));
    });

    it('il token nasce alla prima condivisione e poi resta stabile', async () => {
        const first = await api().post(`/banquet-menus/${banquetId}/share`).set(bearer(token));
        expect(first.status).toBe(200);
        expect(first.body.token.length).toBeGreaterThanOrEqual(24);
        expect(first.body.url).toContain(`/preventivo/${first.body.token}`);
        shareToken = first.body.token;

        const second = await api().post(`/banquet-menus/${banquetId}/share`).set(bearer(token));
        expect(second.status).toBe(200);
        expect(second.body.token).toBe(shareToken);
    });

    it('la pagina pubblica racconta menù e totali, senza note operative', async () => {
        const res = await api().get(`/preventivo/${shareToken}`);
        expect(res.status).toBe(200);
        expect(res.body.business.name).toBeTruthy();
        const q = res.body.quote;
        expect(q.name).toBe('Preventivo condiviso');
        expect(q.status).toBe('QUOTE');
        expect(q.event_date).toBe('2027-07-01');
        expect(q.guests).toBe(40);
        expect(q.courses).toHaveLength(1);
        expect(q.courses[0].dishes[0].name).toBe('Piatto preventivo');
        expect(q.courses[0].dishes[0].allergens).toContain('Glutine');
        expect(q.courses[0].notes).toBe('a scelta');
        // 30 adulti × 60 + 10 bambini × 30 = 2100, sconto 100 → 2000
        expect(q.totals).toEqual({ gross: 2100, discount: 100, total: 2000 });
        expect(q.deposit_amount).toBe(500);
        expect(JSON.stringify(res.body)).not.toContain('nota interna cucina');
    });

    it('un token sbagliato è un 404, senza indizi', async () => {
        const res = await api().get('/preventivo/token-inventato-abbastanza-lungo');
        expect(res.status).toBe(404);
    });

    it("senza template approvato il canale WhatsApp è dichiarato spento", async () => {
        const share = await api().post(`/banquet-menus/${banquetId}/share`).set(bearer(token));
        expect(share.status).toBe(200);
        expect(share.body.whatsapp_ready).toBe(false);

        const res = await api().post(`/banquet-menus/${banquetId}/send-quote-whatsapp`).set(bearer(token))
            .send({ phone: '3331234567' });
        expect(res.status).toBe(503);
        expect(res.body.error).toBe('whatsapp_non_configurato');
    });

    it("l'invio email valida indirizzo e configurazione SMTP", async () => {
        const noEmail = await api().post(`/banquet-menus/${banquetId}/send-quote-email`).set(bearer(token)).send({});
        expect(noEmail.status).toBe(400);

        // Nell'ambiente di test SMTP non è configurato: l'errore deve dirlo
        // chiaro invece di fingere un invio.
        const res = await api().post(`/banquet-menus/${banquetId}/send-quote-email`).set(bearer(token))
            .send({ email: 'cliente@example.com' });
        expect(res.status).toBe(400);
        expect(res.body.error).toMatch(/SMTP/i);
    });
});

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { api, ownerToken, bearer } from './helpers';

// Abbinamenti vino:
// - la spunta «vino» di categoria vive in PUT /menu/category-wine;
// - PUT /dishes con paired_wine_dish_ids sostituisce gli abbinamenti (array
//   assente = non toccare), GET /dishes e GET /menu/catalogue li espongono;
// - il menu pubblico mostra i NOMI dei vini in `abbinati`;
// - l'endpoint AI risponde 503 ai_disabled a flag spento (la proposta vera
//   non si testa: niente chiave in CI).

describe('abbinamenti vino', () => {
    let token: string;
    const dishIds: number[] = [];
    let vinoId: number;
    let vino2Id: number;
    let piattoId: number;

    beforeAll(async () => {
        token = await ownerToken();

        const vino = await api().post('/dishes').set(bearer(token)).send({
            name: 'Primitivo test', description: 'rosso', price: 24, category: 'Vini test', allergens: [],
        });
        expect(vino.status).toBe(201);
        vinoId = vino.body.id; dishIds.push(vinoId);

        const vino2 = await api().post('/dishes').set(bearer(token)).send({
            name: 'Negroamaro test', description: 'rosso', price: 22, category: 'Vini test', allergens: [],
        });
        expect(vino2.status).toBe(201);
        vino2Id = vino2.body.id; dishIds.push(vino2Id);

        const piatto = await api().post('/dishes').set(bearer(token)).send({
            name: 'Brasato test', description: '', price: 18, category: 'Secondi', allergens: [],
        });
        expect(piatto.status).toBe(201);
        piattoId = piatto.body.id; dishIds.push(piattoId);
    });

    afterAll(async () => {
        for (const id of dishIds) {
            await api().delete(`/dishes/${id}`).set(bearer(token));
        }
        await api().put('/settings/features').set(bearer(token))
            .send({ digital_menu_enabled: false, ai_wine_pairing_enabled: false });
    });

    it('la categoria si marca vino e si smarca', async () => {
        const on = await api().put('/menu/category-wine').set(bearer(token))
            .send({ category: 'Vini test', wine: true });
        expect(on.status).toBe(200);
        const cats = await api().get('/menu/categories').set(bearer(token));
        expect(cats.status).toBe(200);
        const cat = cats.body.categories.find((c: any) => c.name === 'Vini Test');
        expect(cat?.wine).toBe(true);
    });

    it('senza category o wine boolean risponde 400, categoria fantasma 404', async () => {
        const senza = await api().put('/menu/category-wine').set(bearer(token))
            .send({ category: 'Vini test' });
        expect(senza.status).toBe(400);
        const fantasma = await api().put('/menu/category-wine').set(bearer(token))
            .send({ category: 'Categoria che non esiste', wine: true });
        expect(fantasma.status).toBe(404);
    });

    it('PUT /dishes con paired_wine_dish_ids salva ordinato e deduplicato', async () => {
        const put = await api().put(`/dishes/${piattoId}`).set(bearer(token)).send({
            name: 'Brasato test', description: '', price: 18, category: 'Secondi', allergens: [],
            paired_wine_dish_ids: [vino2Id, vinoId, vino2Id, piattoId],
        });
        expect(put.status).toBe(200);
        // dedupe, l'autoabbinamento cade, l'ordine del form resta
        expect(put.body.paired_wine_dish_ids).toEqual([vino2Id, vinoId]);

        const list = await api().get('/dishes').set(bearer(token));
        expect(list.status).toBe(200);
        const piatto = list.body.find((d: any) => d.id === piattoId);
        expect(piatto?.paired_wine_dish_ids).toEqual([vino2Id, vinoId]);
    });

    it('array assente = abbinamenti intatti, presente = sostituisce', async () => {
        const senzaCampo = await api().put(`/dishes/${piattoId}`).set(bearer(token)).send({
            name: 'Brasato test', description: 'con cipolle', price: 18, category: 'Secondi', allergens: [],
        });
        expect(senzaCampo.status).toBe(200);
        expect(senzaCampo.body.paired_wine_dish_ids).toEqual([vino2Id, vinoId]);

        const sostituisce = await api().put(`/dishes/${piattoId}`).set(bearer(token)).send({
            name: 'Brasato test', description: 'con cipolle', price: 18, category: 'Secondi', allergens: [],
            paired_wine_dish_ids: [vinoId],
        });
        expect(sostituisce.status).toBe(200);
        expect(sostituisce.body.paired_wine_dish_ids).toEqual([vinoId]);
    });

    it('il catalogo del palmare porta le coppie', async () => {
        const res = await api().get('/menu/catalogue').set(bearer(token));
        expect(res.status).toBe(200);
        const mie = (res.body.dish_wine_pairings ?? []).filter((p: any) => p.dish_id === piattoId);
        expect(mie.map((p: any) => p.wine_dish_id)).toEqual([vinoId]);
    });

    it('il menu pubblico mostra i nomi in abbinati', async () => {
        await api().put('/settings/features').set(bearer(token)).send({ digital_menu_enabled: true });
        const res = await api().get('/public/menu');
        expect(res.status).toBe(200);
        const brasato = res.body.piatti.find((p: any) => p.name === 'Brasato Test');
        expect(brasato?.abbinati).toEqual(['Primitivo Test']);
        // Un vino spento sparisce dalla vetrina senza toccare gli abbinamenti.
        await api().put(`/dishes/${vinoId}/enabled`).set(bearer(token)).send({ enabled: false });
        const dopo = await api().get('/public/menu');
        const brasatoDopo = dopo.body.piatti.find((p: any) => p.name === 'Brasato Test');
        expect(brasatoDopo?.abbinati).toEqual([]);
        await api().put(`/dishes/${vinoId}/enabled`).set(bearer(token)).send({ enabled: true });
    });

    it('a flag spento il sommelier risponde ai_disabled', async () => {
        const res = await api().post(`/dishes/${piattoId}/suggest-pairings`).set(bearer(token)).send({});
        expect(res.status).toBe(503);
        expect(res.body.error).toBe('ai_disabled');
        const bulk = await api().post('/menu/pair-wines').set(bearer(token)).send({});
        expect(bulk.status).toBe(503);
        expect(bulk.body.error).toBe('ai_disabled');
    });
});

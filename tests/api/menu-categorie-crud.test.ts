import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { api, ownerToken, bearer } from './helpers';

// CRUD delle categorie del menu (nomi liberi sui piatti + blob prefs):
// - POST /menu/categories crea una categoria anche vuota (manual nel blob);
// - PUT /menu/categories/rename sposta i piatti e migra le preferenze;
// - DELETE /menu/categories elimina solo una categoria vuota;
// - il riordino (PUT /menu/categories) non perde le categorie vuote.

describe('categorie: crud', () => {
    let token: string;
    const dishIds: number[] = [];
    const NUOVA = 'Fritture Crud Test';
    const RINOMINATA = 'Fritture Speciali Crud';
    const ALTRA = 'Altra Categoria Crud';

    beforeAll(async () => {
        token = await ownerToken();
    });

    afterAll(async () => {
        for (const id of dishIds) {
            await api().delete(`/dishes/${id}`).set(bearer(token));
        }
        for (const name of [NUOVA, RINOMINATA, ALTRA]) {
            await api().delete(`/menu/categories?name=${encodeURIComponent(name)}`).set(bearer(token));
        }
    });

    it('una categoria nuova nasce vuota e compare in elenco', async () => {
        const created = await api().post('/menu/categories').set(bearer(token)).send({ name: NUOVA });
        expect(created.status).toBe(201);

        const dup = await api().post('/menu/categories').set(bearer(token)).send({ name: NUOVA });
        expect(dup.status).toBe(409);

        const cats = await api().get('/menu/categories').set(bearer(token));
        const mine = cats.body.categories.find((c: any) => c.name === NUOVA);
        expect(mine).toBeTruthy();
        expect(mine.dishes).toBe(0);
        expect(mine.enabled).toBe(true);
    });

    it('il riordino non perde una categoria vuota', async () => {
        const cats = await api().get('/menu/categories').set(bearer(token));
        const order = cats.body.categories.map((c: any) => ({ name: c.name, enabled: c.enabled }));
        const saved = await api().put('/menu/categories').set(bearer(token)).send({ categories: order });
        expect(saved.status).toBe(200);
        const after = await api().get('/menu/categories').set(bearer(token));
        expect(after.body.categories.some((c: any) => c.name === NUOVA)).toBe(true);
    });

    it('la rinomina sposta i piatti e le preferenze sul nuovo nome', async () => {
        const dish = await api().post('/dishes').set(bearer(token)).send({
            name: 'Frittura crud', description: '', price: 11, category: NUOVA, allergens: [],
        });
        expect(dish.status).toBe(201);
        dishIds.push(dish.body.id);

        const altra = await api().post('/menu/categories').set(bearer(token)).send({ name: ALTRA });
        expect(altra.status).toBe(201);
        const clash = await api().put('/menu/categories/rename').set(bearer(token))
            .send({ from: NUOVA, to: ALTRA });
        expect(clash.status).toBe(409);

        const renamed = await api().put('/menu/categories/rename').set(bearer(token))
            .send({ from: NUOVA, to: RINOMINATA });
        expect(renamed.status).toBe(200);
        expect(renamed.body.piatti).toBe(1);

        const dishes = await api().get('/dishes').set(bearer(token));
        expect(dishes.body.find((d: any) => d.id === dish.body.id).category).toBe(RINOMINATA);

        const cats = await api().get('/menu/categories').set(bearer(token));
        expect(cats.body.categories.some((c: any) => c.name === NUOVA)).toBe(false);
        const mine = cats.body.categories.find((c: any) => c.name === RINOMINATA);
        expect(mine).toBeTruthy();
        expect(mine.dishes).toBe(1);
    });

    it('una categoria con piatti non si elimina; svuotata sì', async () => {
        const blocked = await api().delete(`/menu/categories?name=${encodeURIComponent(RINOMINATA)}`).set(bearer(token));
        expect(blocked.status).toBe(409);

        for (const id of dishIds.splice(0)) {
            await api().delete(`/dishes/${id}`).set(bearer(token));
        }
        const gone = await api().delete(`/menu/categories?name=${encodeURIComponent(RINOMINATA)}`).set(bearer(token));
        expect(gone.status).toBe(204);
        const cats = await api().get('/menu/categories').set(bearer(token));
        expect(cats.body.categories.some((c: any) => c.name === RINOMINATA)).toBe(false);
    });
});

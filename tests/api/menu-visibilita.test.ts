import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { api, ownerToken, bearer } from './helpers';

// Visibilità e ordinamento del menu decisi dal CRM:
// - PUT /dishes/:id/enabled — interruttore crm_enabled, separato da is_active
//   che appartiene alla cassa;
// - PUT /menu/dish-order — l'array di id è l'ordine dentro la categoria;
// - GET/PUT /menu/categories — accensione e ordine delle categorie (blob
//   app_settings, le categorie restano stringhe libere sui piatti);
// - il menu pubblico rispetta entrambi gli interruttori e l'ordine.

const CAT = 'Prova Visibilità';

describe('menu: visibilità e ordinamento CRM', () => {
    let token: string;
    const ids: number[] = [];

    beforeAll(async () => {
        token = await ownerToken();
        for (const name of ['Alfa', 'Beta', 'Gamma']) {
            const res = await api().post('/dishes').set(bearer(token)).send({
                name: `${name} test`, description: '', price: 10, category: CAT, allergens: [],
            });
            expect(res.status).toBe(201);
            ids.push(res.body.id);
        }
    });

    afterAll(async () => {
        for (const id of ids) {
            await api().delete(`/dishes/${id}`).set(bearer(token));
        }
        await api().put('/settings/features').set(bearer(token)).send({ digital_menu_enabled: false });
    });

    it('un piatto nuovo nasce acceso (crm_enabled true)', async () => {
        const res = await api().get('/dishes').set(bearer(token));
        expect(res.status).toBe(200);
        const mine = res.body.filter((d: any) => ids.includes(d.id));
        expect(mine).toHaveLength(3);
        for (const d of mine) expect(d.crm_enabled).toBe(true);
    });

    it('il toggle spegne il piatto senza toccare is_active', async () => {
        const off = await api().put(`/dishes/${ids[0]}/enabled`).set(bearer(token)).send({ enabled: false });
        expect(off.status).toBe(200);
        expect(off.body.crm_enabled).toBe(false);
        expect(off.body.is_active).toBe(true);

        const on = await api().put(`/dishes/${ids[0]}/enabled`).set(bearer(token)).send({ enabled: true });
        expect(on.status).toBe(200);
        expect(on.body.crm_enabled).toBe(true);
    });

    it('enabled non booleano → 400', async () => {
        const res = await api().put(`/dishes/${ids[0]}/enabled`).set(bearer(token)).send({ enabled: 'no' });
        expect(res.status).toBe(400);
    });

    it("l'ordine dei piatti segue l'array di dish-order", async () => {
        const inverted = [...ids].reverse();
        const put = await api().put('/menu/dish-order').set(bearer(token)).send({ dish_ids: inverted });
        expect(put.status).toBe(200);

        const res = await api().get('/dishes').set(bearer(token));
        const mine = res.body.filter((d: any) => d.category === CAT).map((d: any) => d.id);
        expect(mine).toEqual(inverted);
    });

    it('GET /menu/categories elenca la categoria coi suoi piatti, accesa', async () => {
        const res = await api().get('/menu/categories').set(bearer(token));
        expect(res.status).toBe(200);
        const cat = res.body.categories.find((c: any) => c.name === CAT);
        expect(cat).toBeTruthy();
        expect(cat.dishes).toBe(3);
        expect(cat.enabled).toBe(true);
    });

    it('categoria spenta: sparisce dal menu pubblico insieme ai piatti', async () => {
        await api().put('/settings/features').set(bearer(token)).send({ digital_menu_enabled: true });

        // Piatto spento dal CRM: fuori dal menu pubblico anche con categoria accesa.
        await api().put(`/dishes/${ids[0]}/enabled`).set(bearer(token)).send({ enabled: false });
        let pub = await api().get('/public/menu');
        expect(pub.status).toBe(200);
        let nomi = pub.body.piatti.map((p: any) => p.name);
        expect(nomi).not.toContain('Alfa test');
        expect(nomi).toContain('Beta test');

        // Categoria spenta: spariscono tutti.
        const cats = (await api().get('/menu/categories').set(bearer(token))).body.categories;
        const put = await api().put('/menu/categories').set(bearer(token)).send({
            categories: cats.map((c: any) => c.name === CAT ? { ...c, enabled: false } : c),
        });
        expect(put.status).toBe(200);
        pub = await api().get('/public/menu');
        nomi = pub.body.piatti.map((p: any) => p.name);
        expect(nomi).not.toContain('Beta test');
        expect(nomi).not.toContain('Gamma test');

        // Riaccesa: tornano (Alfa resta spento dal toggle piatto).
        await api().put('/menu/categories').set(bearer(token)).send({
            categories: cats.map((c: any) => ({ name: c.name, enabled: true })),
        });
        pub = await api().get('/public/menu');
        nomi = pub.body.piatti.map((p: any) => p.name);
        expect(nomi).toContain('Beta test');
        expect(nomi).not.toContain('Alfa test');
    });

    it("l'ordine delle categorie arriva al menu pubblico in categorie_ordine", async () => {
        const cats = (await api().get('/menu/categories').set(bearer(token))).body.categories;
        // La categoria di prova in testa: l'ordine dell'array È l'ordine.
        const reordered = [
            { name: CAT, enabled: true },
            ...cats.filter((c: any) => c.name !== CAT).map((c: any) => ({ name: c.name, enabled: c.enabled })),
        ];
        await api().put('/menu/categories').set(bearer(token)).send({ categories: reordered });

        const pub = await api().get('/public/menu');
        expect(pub.status).toBe(200);
        expect(pub.body.categorie_ordine[0]).toBe(CAT);

        const after = (await api().get('/menu/categories').set(bearer(token))).body.categories;
        expect(after[0].name).toBe(CAT);
    });
});

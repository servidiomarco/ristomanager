import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { api, ownerToken, bearer } from './helpers';

// Menu multipli e stato dei banchetti:
// - GET /menus — i due menu di sistema (Alla carta, Banchetti) nascono da
//   soli; POST/PUT/DELETE valgono solo per i menu del ristoratore;
// - i piatti appartengono ai menu via menu_ids (default: Alla carta);
// - il menu pubblico mostra solo i piatti del menu Alla carta;
// - un banchetto nasce QUOTE e si conferma da PUT /banquet-menus/:id/status.

describe('menu multipli e stato banchetti', () => {
    let token: string;
    let cartaId: number;
    let banquetsId: number;
    const dishIds: number[] = [];
    let customMenuId: number;
    let banquetId: number;

    beforeAll(async () => {
        token = await ownerToken();
    });

    afterAll(async () => {
        for (const id of dishIds) {
            await api().delete(`/dishes/${id}`).set(bearer(token));
        }
        if (banquetId) await api().delete(`/banquet-menus/${banquetId}`).set(bearer(token));
        if (customMenuId) await api().delete(`/menus/${customMenuId}`).set(bearer(token));
        await api().put('/settings/features').set(bearer(token)).send({ digital_menu_enabled: false });
    });

    it('i due menu di sistema esistono (o nascono alla prima lettura)', async () => {
        const res = await api().get('/menus').set(bearer(token));
        expect(res.status).toBe(200);
        const carta = res.body.find((m: any) => m.system_key === 'ALLA_CARTA');
        const banquets = res.body.find((m: any) => m.system_key === 'BANQUETS');
        expect(carta).toBeTruthy();
        expect(banquets).toBeTruthy();
        cartaId = carta.id;
        banquetsId = banquets.id;
    });

    it('un piatto nuovo senza menu_ids nasce in Alla carta', async () => {
        const res = await api().post('/dishes').set(bearer(token)).send({
            name: 'Piatto default menu', description: '', price: 12, category: 'Primi', allergens: [],
        });
        expect(res.status).toBe(201);
        dishIds.push(res.body.id);
        expect(res.body.menu_ids).toEqual([cartaId]);
    });

    it('le spunte del form decidono le appartenenze, e il PUT le sostituisce', async () => {
        const created = await api().post('/dishes').set(bearer(token)).send({
            name: 'Piatto due menu', description: '', price: 18, category: 'Secondi', allergens: [],
            menu_ids: [cartaId, banquetsId],
        });
        expect(created.status).toBe(201);
        dishIds.push(created.body.id);
        expect([...created.body.menu_ids].sort()).toEqual([cartaId, banquetsId].sort());

        const updated = await api().put(`/dishes/${created.body.id}`).set(bearer(token)).send({
            name: 'Piatto due menu', description: '', price: 18, category: 'Secondi', allergens: [],
            menu_ids: [banquetsId],
        });
        expect(updated.status).toBe(200);
        expect(updated.body.menu_ids).toEqual([banquetsId]);

        // Un client vecchio che non manda menu_ids non azzera le spunte.
        const legacy = await api().put(`/dishes/${created.body.id}`).set(bearer(token)).send({
            name: 'Piatto due menu', description: '', price: 19, category: 'Secondi', allergens: [],
        });
        expect(legacy.status).toBe(200);
        expect(legacy.body.menu_ids).toEqual([banquetsId]);
    });

    it('GET /dishes riporta menu_ids', async () => {
        const res = await api().get('/dishes').set(bearer(token));
        expect(res.status).toBe(200);
        const mine = res.body.find((d: any) => d.id === dishIds[0]);
        expect(mine.menu_ids).toEqual([cartaId]);
    });

    it('i menu del ristoratore si creano, rinominano ed eliminano; quelli di sistema no', async () => {
        const created = await api().post('/menus').set(bearer(token)).send({ name: 'Ferragosto' });
        expect(created.status).toBe(201);
        expect(created.body.system_key).toBeNull();
        customMenuId = created.body.id;

        const renamed = await api().put(`/menus/${customMenuId}`).set(bearer(token)).send({ name: 'Pasqua' });
        expect(renamed.status).toBe(200);
        expect(renamed.body.name).toBe('Pasqua');

        const renameSystem = await api().put(`/menus/${cartaId}`).set(bearer(token)).send({ name: 'Altro nome' });
        expect(renameSystem.status).toBe(404);
        const deleteSystem = await api().delete(`/menus/${banquetsId}`).set(bearer(token));
        expect(deleteSystem.status).toBe(404);
    });

    it('il menu pubblico mostra solo i piatti di Alla carta', async () => {
        const flags = await api().put('/settings/features').set(bearer(token)).send({ digital_menu_enabled: true });
        expect(flags.status).toBe(200);

        const res = await api().get('/public/menu');
        expect(res.status).toBe(200);
        const names = res.body.piatti.map((p: any) => p.name);
        expect(names).toContain('Piatto default menu');       // in Alla carta
        expect(names).not.toContain('Piatto due menu');       // solo in Banchetti
    });

    it('la spunta di menu su una categoria applica in blocco e fa da default per i piatti nuovi', async () => {
        const CAT = 'Categoria Menu Test';
        for (const name of ['Cat uno', 'Cat due']) {
            const res = await api().post('/dishes').set(bearer(token)).send({
                name, description: '', price: 9, category: CAT, allergens: [],
            });
            expect(res.status).toBe(201);
            dishIds.push(res.body.id);
        }

        // In blocco dentro Banchetti: entrambi i piatti guadagnano il menu.
        const on = await api().put('/menu/category-menus').set(bearer(token))
            .send({ category: CAT, menu_id: banquetsId, member: true });
        expect(on.status).toBe(200);
        expect(on.body.piatti).toBe(2);
        const after = await api().get('/dishes').set(bearer(token));
        for (const d of after.body.filter((d: any) => d.category === CAT)) {
            expect(d.menu_ids).toContain(banquetsId);
        }

        // Il default della categoria vale per i piatti nuovi senza spunte.
        const cats = await api().get('/menu/categories').set(bearer(token));
        const mine = cats.body.categories.find((c: any) => c.name === CAT);
        expect([...mine.menu_ids].sort()).toEqual([cartaId, banquetsId].sort());
        const born = await api().post('/dishes').set(bearer(token)).send({
            name: 'Cat tre', description: '', price: 9, category: CAT, allergens: [],
        });
        expect(born.status).toBe(201);
        dishIds.push(born.body.id);
        expect([...born.body.menu_ids].sort()).toEqual([cartaId, banquetsId].sort());

        // Riordinare le categorie non azzera i menu della categoria.
        const order = cats.body.categories.map((c: any) => ({ name: c.name, enabled: c.enabled }));
        const saved = await api().put('/menu/categories').set(bearer(token)).send({ categories: order });
        expect(saved.status).toBe(200);
        const cats2 = await api().get('/menu/categories').set(bearer(token));
        const mine2 = cats2.body.categories.find((c: any) => c.name === CAT);
        expect([...mine2.menu_ids].sort()).toEqual([cartaId, banquetsId].sort());

        // In blocco fuori da Alla carta: tolto da tutti e tre.
        const off = await api().put('/menu/category-menus').set(bearer(token))
            .send({ category: CAT, menu_id: cartaId, member: false });
        expect(off.status).toBe(200);
        expect(off.body.piatti).toBe(3);
        const final = await api().get('/dishes').set(bearer(token));
        for (const d of final.body.filter((d: any) => d.category === CAT)) {
            expect(d.menu_ids).toEqual([banquetsId]);
        }
    });

    it('un banchetto nasce preventivo e si conferma dalla rotta di stato', async () => {
        const created = await api().post('/banquet-menus').set(bearer(token)).send({
            name: 'Prova stato', description: '', price_per_person: 50,
            courses: [], event_date: '2027-06-01',
        });
        expect(created.status).toBe(201);
        banquetId = created.body.id;
        expect(created.body.status).toBe('QUOTE');

        const bad = await api().put(`/banquet-menus/${banquetId}/status`).set(bearer(token)).send({ status: 'FORSE' });
        expect(bad.status).toBe(400);

        const confirmed = await api().put(`/banquet-menus/${banquetId}/status`).set(bearer(token)).send({ status: 'CONFIRMED' });
        expect(confirmed.status).toBe(200);
        expect(confirmed.body.status).toBe('CONFIRMED');

        const list = await api().get('/banquet-menus').set(bearer(token));
        const mine = list.body.find((b: any) => b.id === banquetId);
        expect(mine.status).toBe('CONFIRMED');
    });
});

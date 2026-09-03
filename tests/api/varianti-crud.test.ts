import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Client } from 'pg';
import { api, bearer, ownerToken } from './helpers';

// Gestione varianti: CRUD gruppi/opzioni, isolamento dei gruppi della cassa
// (external_ref pp:varianti:%), assegnazione ai piatti, piatti composti e
// sovrapprezzi percentuali, con la validazione min/max sugli ordini.
//
// Il file si chiama varianti-* (non menu-*) apposta: gira DOPO orders-bills
// (ordine alfabetico = contratto della suite), che accende
// table_orders_enabled — qui servono ordini veri per la validazione, e
// accendere il flag da un file menu-* romperebbe l'assert «flag spento» in
// testa a orders-bills.

describe('varianti: crud, gruppi cassa, composti, percentuali', () => {
    let token: string;
    let db: Client;
    let tableId: number;
    const dishIds: number[] = [];
    const orderIds: number[] = [];
    const groupIds: number[] = [];
    let ppGroupId: number;

    const newDish = async (name: string, price: number, extra: Record<string, unknown> = {}) => {
        const res = await api().post('/dishes').set(bearer(token)).send({
            name, description: null, price, category: 'Varianti Test', allergens: null, ...extra,
        });
        expect(res.status).toBe(201);
        dishIds.push(res.body.id);
        return res.body;
    };

    beforeAll(async () => {
        token = await ownerToken();
        db = new Client({ connectionString: process.env.DATABASE_URL || 'postgresql://localhost/ristotest_api' });
        await db.connect();

        const room = await api().post('/rooms').set(bearer(token)).send({
            name: 'Sala Varianti Test', width: 800, height: 600,
        });
        expect(room.status).toBe(201);
        const table = await api().post('/tables').set(bearer(token)).send({
            name: 'VRT1', shape: 'SQUARE', seats: 4, x: 50, y: 50,
            room_id: room.body.id, status: 'FREE',
        });
        expect(table.status).toBe(201);
        tableId = table.body.id;

        // Un gruppo «della cassa», seminato come lo scriverebbe il sync: il
        // CRUD deve trattarlo da ospite, non da proprietario.
        const g = await db.query(
            `INSERT INTO modifier_groups (tenant_id, name, min_select, max_select, external_ref)
             VALUES (1, 'Varianti (test cassa)', 0, 2, 'pp:varianti:vrt-a|vrt-b') RETURNING id`
        );
        ppGroupId = Number(g.rows[0].id);
        await db.query(
            `INSERT INTO modifiers (tenant_id, group_id, name, price_delta_cents, sort_order)
             VALUES (1, $1, 'Con burrata', 250, 0), (1, $1, 'Senza sale', 0, 1)`,
            [ppGroupId]
        );
    });

    afterAll(async () => {
        // Cleanup diretto: le comande di prova restano in bozza e l'API non
        // ha una cancellazione di comanda — via pg è la strada robusta.
        if (orderIds.length > 0) {
            await db.query('DELETE FROM order_items WHERE order_id = ANY($1::int[])', [orderIds]);
            await db.query('DELETE FROM orders WHERE id = ANY($1::int[])', [orderIds]);
        }
        for (const id of dishIds) {
            await api().delete(`/dishes/${id}`).set(bearer(token));
        }
        await db.query('DELETE FROM modifier_groups WHERE tenant_id = 1 AND id = ANY($1::int[])', [[...groupIds, ppGroupId]]);
        await db.end();
    });

    it('un gruppo nasce con le sue opzioni e il nome è unico fra i manuali', async () => {
        const created = await api().post('/menu/modifier-groups').set(bearer(token)).send({
            name: 'Cottura Vrt', min_select: 1, max_select: 1,
            modifiers: [{ name: 'Al sangue' }, { name: 'Ben cotta' }],
        });
        expect(created.status).toBe(201);
        expect(created.body.external_ref).toBeNull();
        expect(created.body.is_active).toBe(true);
        expect(created.body.modifiers.map((m: any) => m.name)).toEqual(['Al sangue', 'Ben cotta']);
        groupIds.push(created.body.id);

        const dup = await api().post('/menu/modifier-groups').set(bearer(token)).send({ name: 'cottura vrt' });
        expect(dup.status).toBe(409);

        const invalid = await api().post('/menu/modifier-groups').set(bearer(token)).send({
            name: 'Rotto Vrt', min_select: 3, max_select: 1,
        });
        expect(invalid.status).toBe(400);
    });

    it('spegnere un gruppo lo toglie dal catalogue ma non dalla gestione', async () => {
        const g = await api().post('/menu/modifier-groups').set(bearer(token)).send({ name: 'Stagionale Vrt' });
        expect(g.status).toBe(201);
        groupIds.push(g.body.id);

        const off = await api().put(`/menu/modifier-groups/${g.body.id}`).set(bearer(token)).send({ is_active: false });
        expect(off.status).toBe(200);
        expect(off.body.is_active).toBe(false);

        const catalogue = await api().get('/menu/catalogue').set(bearer(token));
        expect(catalogue.body.modifier_groups.some((x: any) => x.id === g.body.id)).toBe(false);
        const admin = await api().get('/menu/modifier-groups').set(bearer(token));
        expect(admin.body.groups.some((x: any) => x.id === g.body.id)).toBe(true);
    });

    it('il riordino segue l\'array e /order non viene catturata come id', async () => {
        const admin = await api().get('/menu/modifier-groups').set(bearer(token));
        const ids = admin.body.groups.map((g: any) => g.id);
        const reversed = [...ids].reverse();
        const saved = await api().put('/menu/modifier-groups/order').set(bearer(token)).send({ group_ids: reversed });
        expect(saved.status).toBe(200);
        const after = await api().get('/menu/modifier-groups').set(bearer(token));
        expect(after.body.groups.map((g: any) => g.id)).toEqual(reversed);
    });

    it('le opzioni si aggiornano: percentuale, ritorno all\'assoluto, sconto negativo', async () => {
        const groupId = groupIds[0];
        const pct = await api().post(`/menu/modifier-groups/${groupId}/modifiers`).set(bearer(token)).send({
            name: 'Extra Vrt', price_delta_pct: 10,
        });
        expect(pct.status).toBe(201);
        expect(Number(pct.body.price_delta_pct)).toBe(10);
        expect(pct.body.price_delta_cents).toBe(0);

        const abs = await api().put(`/menu/modifiers/${pct.body.id}`).set(bearer(token)).send({
            price_delta_pct: null, price_delta_cents: -150,
        });
        expect(abs.status).toBe(200);
        expect(abs.body.price_delta_pct).toBeNull();
        expect(abs.body.price_delta_cents).toBe(-150);

        const gone = await api().delete(`/menu/modifiers/${pct.body.id}`).set(bearer(token));
        expect(gone.status).toBe(204);
    });

    it('i gruppi della cassa: max e opzioni bloccati, min/nome/interruttore liberi', async () => {
        const max = await api().put(`/menu/modifier-groups/${ppGroupId}`).set(bearer(token)).send({ max_select: 5 });
        expect(max.status).toBe(409);
        const addMod = await api().post(`/menu/modifier-groups/${ppGroupId}/modifiers`).set(bearer(token)).send({ name: 'Intruso' });
        expect(addMod.status).toBe(409);
        const del = await api().delete(`/menu/modifier-groups/${ppGroupId}`).set(bearer(token));
        expect(del.status).toBe(409);

        const ok = await api().put(`/menu/modifier-groups/${ppGroupId}`).set(bearer(token)).send({
            name: 'Aggiunte pizza', min_select: 1,
        });
        expect(ok.status).toBe(200);
        expect(ok.body.name).toBe('Aggiunte pizza');
        expect(ok.body.min_select).toBe(1);
        // Si riporta a 0 per non far scattare il min nei test successivi.
        const back = await api().put(`/menu/modifier-groups/${ppGroupId}`).set(bearer(token)).send({ min_select: 0 });
        expect(back.status).toBe(200);
    });

    it('l\'assegnazione via piatto sostituisce l\'insieme; assente non tocca', async () => {
        const dish = await newDish('Tagliata Vrt', 22);
        const groupId = groupIds[0];

        const assigned = await api().put(`/dishes/${dish.id}`).set(bearer(token)).send({
            name: dish.name, description: null, price: 22, category: dish.category,
            allergens: null, modifier_group_ids: [groupId],
        });
        expect(assigned.status).toBe(200);
        expect(assigned.body.modifier_group_ids).toEqual([groupId]);

        const untouched = await api().put(`/dishes/${dish.id}`).set(bearer(token)).send({
            name: dish.name, description: 'ritocco', price: 22, category: dish.category, allergens: null,
        });
        expect(untouched.status).toBe(200);
        const admin = await api().get('/menu/modifier-groups').set(bearer(token));
        const mine = admin.body.groups.find((g: any) => g.id === groupId);
        expect(mine.dish_ids).toContain(dish.id);
    });

    it('un legame manuale a un gruppo della cassa sopravvive alla pulizia del sync', async () => {
        const dishA = await newDish('Pizza Cassa Vrt', 8);
        const dishB = await newDish('Piatto Mio Vrt', 12);
        // dishA come lo lascerebbe l'import: legame del sync.
        await db.query(
            `INSERT INTO dish_modifier_groups (tenant_id, dish_id, group_id, source)
             VALUES (1, $1, $2, 'pp')`,
            [dishA.id, ppGroupId]
        );
        // dishB: l'operatore aggancia il gruppo della cassa a mano.
        const manual = await api().put(`/dishes/${dishB.id}`).set(bearer(token)).send({
            name: dishB.name, description: null, price: 12, category: dishB.category,
            allergens: null, modifier_group_ids: [ppGroupId],
        });
        expect(manual.status).toBe(200);

        // La pulizia dell'import, riga per riga: «l'articolo non ha più
        // varianti» (group corrente = NULL). Stessa DELETE del server.
        for (const dishId of [dishA.id, dishB.id]) {
            await db.query(
                `DELETE FROM dish_modifier_groups l USING modifier_groups g
                 WHERE l.dish_id = $1 AND l.group_id = g.id AND l.source = 'pp'
                   AND g.external_ref LIKE 'pp:varianti:%' AND g.id IS DISTINCT FROM $2`,
                [dishId, null]
            );
        }
        const links = await db.query(
            'SELECT dish_id, source FROM dish_modifier_groups WHERE group_id = $1 ORDER BY dish_id',
            [ppGroupId]
        );
        expect(links.rows.map((r: any) => Number(r.dish_id))).toEqual([dishB.id]);
        expect(links.rows[0].source).toBe('manual');
    });

    it('un gruppo usato da un piatto non si elimina; sganciato sì', async () => {
        const g = await api().post('/menu/modifier-groups').set(bearer(token)).send({ name: 'Effimero Vrt' });
        expect(g.status).toBe(201);
        const dish = await newDish('Piatto Effimero Vrt', 9, { modifier_group_ids: [g.body.id] });
        expect(dish.modifier_group_ids).toEqual([g.body.id]);

        const blocked = await api().delete(`/menu/modifier-groups/${g.body.id}`).set(bearer(token));
        expect(blocked.status).toBe(409);

        const unlink = await api().put(`/dishes/${dish.id}`).set(bearer(token)).send({
            name: dish.name, description: null, price: 9, category: dish.category,
            allergens: null, modifier_group_ids: [],
        });
        expect(unlink.status).toBe(200);
        const gone = await api().delete(`/menu/modifier-groups/${g.body.id}`).set(bearer(token));
        expect(gone.status).toBe(204);
    });

    it('il piatto composto tiene gli id degli ingredienti fra un salvataggio e l\'altro', async () => {
        const dish = await newDish('Antipasto Vrt', 15, {
            dish_type: 'COMPOSED',
            components: [
                { name: 'Cipolla', removal_delta_cents: -100 },
                { name: 'Olive' },
            ],
        });
        expect(dish.dish_type).toBe('COMPOSED');
        expect(dish.components).toHaveLength(2);
        const cipollaId = dish.components.find((c: any) => c.name === 'Cipolla').id;

        // Keep-by-id: il secondo salvataggio ritocca e aggiunge, gli id dei
        // presenti non si muovono (i palmari li hanno nel catalogue).
        const again = await api().put(`/dishes/${dish.id}`).set(bearer(token)).send({
            name: dish.name, description: null, price: 15, category: dish.category, allergens: null,
            components: [
                { id: cipollaId, name: 'Cipolla rossa', removal_delta_cents: -100 },
                { name: 'Capperi' },
            ],
        });
        expect(again.status).toBe(200);
        const rossa = again.body.components.find((c: any) => c.name === 'Cipolla rossa');
        expect(rossa.id).toBe(cipollaId);
        expect(again.body.components.some((c: any) => c.name === 'Olive')).toBe(false);

        const fetched = await api().get(`/dishes/${dish.id}/components`).set(bearer(token));
        expect(fetched.status).toBe(200);
        expect(fetched.body.components.map((c: any) => c.name)).toEqual(['Cipolla rossa', 'Capperi']);

        const sovrapprezzo = await api().put(`/dishes/${dish.id}`).set(bearer(token)).send({
            name: dish.name, description: null, price: 15, category: dish.category, allergens: null,
            components: [{ name: 'Errore', removal_delta_cents: 100 }],
        });
        expect(sovrapprezzo.status).toBe(400);
    });

    it('«Senza X» finisce nello snapshot con lo sconto; sui semplici è un 400', async () => {
        const composed = await newDish('Composto Ordine Vrt', 18, {
            dish_type: 'COMPOSED',
            components: [{ name: 'Guanciale', removal_delta_cents: -200 }, { name: 'Pecorino' }],
        });
        const simple = await newDish('Semplice Ordine Vrt', 7);
        const guancialeId = composed.components.find((c: any) => c.name === 'Guanciale').id;

        // 201 alla prima apertura, 200 se il tavolo ha già la comanda
        // aperta da un test precedente: la riapertura è idempotente.
        const order = await api().post('/orders').set(bearer(token)).send({ table_id: tableId });
        expect([200, 201]).toContain(order.status);
        const orderId = order.body.order.id as number;
        orderIds.push(orderId);

        const ok = await api().post(`/orders/${orderId}/items`).set(bearer(token)).send({
            items: [{ dish_id: composed.id, qty: 1, removed_component_ids: [guancialeId] }],
        });
        expect(ok.status).toBe(201);
        const line = ok.body.items.find((i: any) => i.dish_id === composed.id);
        const senza = line.modifiers.find((m: any) => m.name === 'Senza Guanciale');
        expect(senza).toBeTruthy();
        expect(senza.price_delta_cents).toBe(-200);
        expect(senza.component_id).toBe(guancialeId);

        const onSimple = await api().post(`/orders/${orderId}/items`).set(bearer(token)).send({
            items: [{ dish_id: simple.id, qty: 1, removed_component_ids: [guancialeId] }],
        });
        expect(onSimple.status).toBe(400);

        const foreign = await api().post(`/orders/${orderId}/items`).set(bearer(token)).send({
            items: [{ dish_id: composed.id, qty: 1, removed_component_ids: [999999] }],
        });
        expect(foreign.status).toBe(400);
    });

    it('min e max dei gruppi valgono anche per un client che li ignora', async () => {
        const cottura = await api().post('/menu/modifier-groups').set(bearer(token)).send({
            name: 'Cottura Obbligo Vrt', min_select: 1, max_select: 1,
            modifiers: [{ name: 'Al sangue' }, { name: 'Media' }],
        });
        expect(cottura.status).toBe(201);
        groupIds.push(cottura.body.id);
        const [sangue, media] = cottura.body.modifiers.map((m: any) => m.id);
        const dish = await newDish('Fiorentina Obbligo Vrt', 45, { modifier_group_ids: [cottura.body.id] });

        // 201 alla prima apertura, 200 se il tavolo ha già la comanda
        // aperta da un test precedente: la riapertura è idempotente.
        const order = await api().post('/orders').set(bearer(token)).send({ table_id: tableId });
        expect([200, 201]).toContain(order.status);
        orderIds.push(order.body.order.id);
        const orderId = order.body.order.id as number;

        const nudo = await api().post(`/orders/${orderId}/items`).set(bearer(token)).send({
            items: [{ dish_id: dish.id, qty: 1 }],
        });
        expect(nudo.status).toBe(400);
        expect(nudo.body.error).toContain('Cottura Obbligo Vrt');

        const doppio = await api().post(`/orders/${orderId}/items`).set(bearer(token)).send({
            items: [{ dish_id: dish.id, qty: 1, modifier_ids: [sangue, media] }],
        });
        expect(doppio.status).toBe(400);

        const giusto = await api().post(`/orders/${orderId}/items`).set(bearer(token)).send({
            items: [{ dish_id: dish.id, qty: 1, modifier_ids: [sangue] }],
        });
        expect(giusto.status).toBe(201);

        // Gruppo spento = nessun obbligo: spegnere non blocca la battitura.
        const off = await api().put(`/menu/modifier-groups/${cottura.body.id}`).set(bearer(token)).send({ is_active: false });
        expect(off.status).toBe(200);
        const senzaObbligo = await api().post(`/orders/${orderId}/items`).set(bearer(token)).send({
            items: [{ dish_id: dish.id, qty: 1 }],
        });
        expect(senzaObbligo.status).toBe(201);
    });

    it('la percentuale si risolve sul prezzo battuto e resta nello snapshot', async () => {
        const extra = await api().post('/menu/modifier-groups').set(bearer(token)).send({
            name: 'Extra Pct Vrt', max_select: 3,
            modifiers: [{ name: 'Porzione XL', price_delta_pct: 10 }],
        });
        expect(extra.status).toBe(201);
        groupIds.push(extra.body.id);
        const xlId = extra.body.modifiers[0].id;
        const dish = await newDish('Pct Vrt', 20, { modifier_group_ids: [extra.body.id] });

        // 201 alla prima apertura, 200 se il tavolo ha già la comanda
        // aperta da un test precedente: la riapertura è idempotente.
        const order = await api().post('/orders').set(bearer(token)).send({ table_id: tableId });
        expect([200, 201]).toContain(order.status);
        orderIds.push(order.body.order.id);

        const battuta = await api().post(`/orders/${order.body.order.id}/items`).set(bearer(token)).send({
            items: [{ dish_id: dish.id, qty: 1, modifier_ids: [xlId] }],
        });
        expect(battuta.status).toBe(201);
        const line = battuta.body.items.find((i: any) => i.dish_id === dish.id);
        // 10% di 20,00 € = 2,00 €, congelati in centesimi nello snapshot.
        expect(line.modifiers[0].price_delta_cents).toBe(200);

        // Il prezzo di anagrafica cambia DOPO: la riga battuta non si muove.
        const upd = await api().put(`/dishes/${dish.id}`).set(bearer(token)).send({
            name: dish.name, description: null, price: 40, category: dish.category, allergens: null,
        });
        expect(upd.status).toBe(200);
        const view = await api().get(`/orders/${order.body.order.id}`).set(bearer(token));
        const still = view.body.items.find((i: any) => i.dish_id === dish.id);
        expect(still.modifiers[0].price_delta_cents).toBe(200);
    });
});

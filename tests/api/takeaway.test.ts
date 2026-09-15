import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Client } from 'pg';
import { api, ownerToken, bearer } from './helpers';

// Modulo asporto, fase 1: entità + slot con capienza. Il tenant 1 nasce con
// l'entitlement 'takeaway' acceso (seed della migration modulo-asporto).
//
// Data futura fissa come in availability.test.ts: gli slot passano da
// getAvailableSlots e per la data odierna il test dipenderebbe
// dall'orologio. Slot del seed: pranzo 13:00-14:00, cena 19:30-23:30,
// passo 30'. La data è diversa da quella degli altri file così i conteggi
// di capienza partono da zero qualunque cosa abbiano fatto i test prima.
const DATA_ASPORTO = '2027-04-14';

let token: string;
let dishId: number;

beforeAll(async () => {
    token = await ownerToken();
    const dish = await api().post('/dishes').set(bearer(token))
        .send({ name: 'Pizza Asporto Test', price: 8.5, category: 'Pizze Test Asporto' });
    expect(dish.status).toBe(201);
    dishId = dish.body.id;
});

afterAll(async () => {
    // Il tenant 1 torna com'era: i file girano in sequenza sullo stesso
    // server e gli altri contano sugli add-on attivi e sui default.
    await api().put('/settings/entitlements').set(bearer(token)).send({ takeaway: true });
    await api().put('/takeaway/config').set(bearer(token))
        .send({ capacity_per_slot: 4, prep_minutes: 20, stop_date: null });
});

describe('asporto — slot e capienza', () => {
    it('richiede autenticazione', async () => {
        const res = await api().get('/takeaway/orders');
        expect(res.status).toBe(401);
    });

    it('la griglia slot viene dagli orari di apertura, con capienza default', async () => {
        const res = await api().get('/takeaway/slots').set(bearer(token)).query({ date: DATA_ASPORTO });
        expect(res.status).toBe(200);
        expect(res.body.date).toBe(DATA_ASPORTO);
        expect(res.body.stopped).toBe(false);
        expect(res.body.capacity_per_slot).toBe(4);
        expect(res.body.lunch.map((s: any) => s.time)).toEqual(['13:00', '13:30', '14:00']);
        expect(res.body.dinner[0]).toEqual({ time: '19:30', booked: 0, capacity: 4 });
    });

    it('la config espone capienza e minuti di preparazione', async () => {
        const res = await api().get('/takeaway/config').set(bearer(token));
        expect(res.status).toBe(200);
        expect(res.body).toEqual({ capacity_per_slot: 4, prep_minutes: 20, stop_date: null, online_enabled: false });
    });
});

describe('asporto — ciclo dell\'ordine', () => {
    let orderId: number;

    it('crea un ordine su uno slot valido, con snapshot e totale dal server', async () => {
        const res = await api().post('/takeaway/orders').set(bearer(token)).send({
            customer_name: 'Rossi Mario',
            customer_phone: '+39 333 1234567',
            pickup_date: DATA_ASPORTO,
            pickup_time: '19:30',
            notes: 'senza origano',
            items: [{ dish_id: dishId, qty: 2, note: 'ben cotta' }],
        });
        expect(res.status).toBe(201);
        orderId = res.body.id;
        expect(res.body.status).toBe('CONFIRMED');
        expect(res.body.channel).toBe('STAFF');
        expect(res.body.shift).toBe('DINNER');
        expect(res.body.pickup_date).toBe(DATA_ASPORTO);
        expect(res.body.pickup_time).toBe('19:30');
        expect(res.body.items).toHaveLength(1);
        expect(res.body.items[0].name_snapshot).toBe('Pizza Asporto Test');
        expect(res.body.items[0].unit_price_cents).toBe(850);
        expect(res.body.total_cents).toBe(1700);
    });

    it('rifiuta uno slot fuori dalla griglia di apertura', async () => {
        const res = await api().post('/takeaway/orders').set(bearer(token)).send({
            customer_name: 'Bianchi Anna',
            pickup_date: DATA_ASPORTO,
            pickup_time: '18:00',
            items: [{ dish_id: dishId, qty: 1 }],
        });
        expect(res.status).toBe(400);
        expect(res.body.error).toBe('invalid_slot');
    });

    it('rifiuta un ordine senza righe', async () => {
        const res = await api().post('/takeaway/orders').set(bearer(token)).send({
            customer_name: 'Bianchi Anna',
            pickup_date: DATA_ASPORTO,
            pickup_time: '19:30',
            items: [],
        });
        expect(res.status).toBe(400);
        expect(res.body.error).toBe('invalid_items');
    });

    it('slot al completo → 409, ma force passa (decisione del banco)', async () => {
        for (let i = 0; i < 3; i++) {
            const r = await api().post('/takeaway/orders').set(bearer(token)).send({
                customer_name: `Cliente ${i + 2}`,
                pickup_date: DATA_ASPORTO,
                pickup_time: '19:30',
                items: [{ dish_id: dishId, qty: 1 }],
            });
            expect(r.status).toBe(201);
        }
        const pieno = await api().post('/takeaway/orders').set(bearer(token)).send({
            customer_name: 'Cliente Di Troppo',
            pickup_date: DATA_ASPORTO,
            pickup_time: '19:30',
            items: [{ dish_id: dishId, qty: 1 }],
        });
        expect(pieno.status).toBe(409);
        expect(pieno.body.error).toBe('slot_full');

        const forzato = await api().post('/takeaway/orders').set(bearer(token)).send({
            customer_name: 'Cliente Di Troppo',
            pickup_date: DATA_ASPORTO,
            pickup_time: '19:30',
            items: [{ dish_id: dishId, qty: 1 }],
            force: true,
        });
        expect(forzato.status).toBe(201);
    });

    it('la griglia slot riflette il prenotato', async () => {
        const res = await api().get('/takeaway/slots').set(bearer(token)).query({ date: DATA_ASPORTO });
        const cena = res.body.dinner.find((s: any) => s.time === '19:30');
        expect(cena.booked).toBe(5);
    });

    it('la lista del giorno ritorna gli ordini in ordine di ritiro', async () => {
        const res = await api().get('/takeaway/orders').set(bearer(token)).query({ date: DATA_ASPORTO });
        expect(res.status).toBe(200);
        expect(res.body.orders).toHaveLength(5);
        expect(res.body.orders[0].items.length).toBeGreaterThan(0);
    });

    it('i cambi di stato muovono i timestamp, e tornare indietro li azzera', async () => {
        const pronto = await api().post(`/takeaway/orders/${orderId}/status`).set(bearer(token)).send({ status: 'READY' });
        expect(pronto.status).toBe(200);
        expect(pronto.body.status).toBe('READY');
        expect(pronto.body.ready_at).not.toBeNull();

        const ritirato = await api().post(`/takeaway/orders/${orderId}/status`).set(bearer(token)).send({ status: 'PICKED_UP' });
        expect(ritirato.body.picked_up_at).not.toBeNull();

        // Correzione: un «ritirato» per sbaglio torna «pronto».
        const corretto = await api().post(`/takeaway/orders/${orderId}/status`).set(bearer(token)).send({ status: 'READY' });
        expect(corretto.body.status).toBe('READY');
        expect(corretto.body.picked_up_at).toBeNull();
        expect(corretto.body.ready_at).not.toBeNull();

        const invalido = await api().post(`/takeaway/orders/${orderId}/status`).set(bearer(token)).send({ status: 'FANTASIA' });
        expect(invalido.status).toBe(400);
    });

    it('un annullato libera lo slot per la capienza', async () => {
        const annulla = await api().post(`/takeaway/orders/${orderId}/status`).set(bearer(token)).send({ status: 'CANCELLED' });
        expect(annulla.body.cancelled_at).not.toBeNull();
        const res = await api().get('/takeaway/slots').set(bearer(token)).query({ date: DATA_ASPORTO });
        const cena = res.body.dinner.find((s: any) => s.time === '19:30');
        expect(cena.booked).toBe(4);
    });

    it('la modifica ricalcola turno e righe', async () => {
        // Riporta l'ordine attivo e spostalo a pranzo con righe nuove.
        await api().post(`/takeaway/orders/${orderId}/status`).set(bearer(token)).send({ status: 'CONFIRMED' });
        const res = await api().patch(`/takeaway/orders/${orderId}`).set(bearer(token)).send({
            pickup_time: '13:00',
            items: [{ dish_id: dishId, qty: 3 }],
        });
        expect(res.status).toBe(200);
        expect(res.body.shift).toBe('LUNCH');
        expect(res.body.pickup_time).toBe('13:00');
        expect(res.body.total_cents).toBe(2550);
    });
});

describe('asporto — cucina', () => {
    // La comanda si verifica direttamente a DB: le route /orders e /kds
    // stanno dietro il flag table_orders_enabled, che qui resta com'è.
    let pg: Client;
    let asportoId = 0;
    let kitchenId = 0;

    beforeAll(async () => {
        pg = new Client({ connectionString: process.env.DATABASE_URL || 'postgresql://localhost/ristotest_api' });
        await pg.connect();
    });
    afterAll(async () => { await pg.end(); });

    it('«manda in cucina» genera la comanda TAKEAWAY senza tavolo e lancia l\'uscita', async () => {
        const created = await api().post('/takeaway/orders').set(bearer(token)).send({
            customer_name: 'Verdi Luigi',
            pickup_date: DATA_ASPORTO,
            pickup_time: '20:00',
            items: [
                { dish_id: dishId, qty: 2, note: 'doppia mozzarella' },
                { dish_id: dishId, qty: 1 },
            ],
        });
        expect(created.status).toBe(201);
        asportoId = created.body.id;

        const fired = await api().post(`/takeaway/orders/${asportoId}/fire`).set(bearer(token)).send({});
        expect(fired.status).toBe(200);
        expect(fired.body.status).toBe('IN_PREPARATION');
        expect(typeof fired.body.kitchen_order_id).toBe('number');
        kitchenId = fired.body.kitchen_order_id;

        const order = await pg.query('SELECT * FROM orders WHERE id = $1', [kitchenId]);
        expect(order.rows[0].order_type).toBe('TAKEAWAY');
        expect(order.rows[0].table_id).toBeNull();
        expect(order.rows[0].reservation_id).toBeNull();
        expect(order.rows[0].shift).toBe('DINNER');
        expect(order.rows[0].notes).toContain('Asporto 20:00');

        // Righe lanciate (SENT), snapshot e note conservati.
        const items = await pg.query(
            'SELECT name_snapshot, qty, note, status, course_no FROM order_items WHERE order_id = $1 ORDER BY id',
            [kitchenId]
        );
        expect(items.rows).toHaveLength(2);
        expect(items.rows[0]).toMatchObject({ name_snapshot: 'Pizza Asporto Test', qty: 2, note: 'doppia mozzarella', status: 'SENT', course_no: 1 });
    });

    it('un secondo lancio non duplica la comanda', async () => {
        const again = await api().post(`/takeaway/orders/${asportoId}/fire`).set(bearer(token)).send({});
        expect(again.status).toBe(409);
        expect(again.body.error).toBe('already_fired');
        const count = await pg.query(
            "SELECT COUNT(*)::int AS n FROM orders WHERE order_type = 'TAKEAWAY' AND notes LIKE '%Verdi Luigi%'",
        );
        expect(count.rows[0].n).toBe(1);
    });

    it('il «pronto» del monitor porta l\'ordine asporto a READY da solo', async () => {
        // Le route KDS stanno dietro il flag: si accende, si usa, si rispegne.
        const flagOn = await api().put('/settings/features').set(bearer(token)).send({ table_orders_enabled: true });
        expect(flagOn.status).toBe(200);
        try {
            const items = await pg.query('SELECT id FROM order_items WHERE order_id = $1 ORDER BY id', [kitchenId]);
            for (const row of items.rows) {
                const r = await api().post(`/kds/items/${row.id}/status`).set(bearer(token)).send({ status: 'READY' });
                expect(r.status).toBe(200);
            }
            const list = await api().get('/takeaway/orders').set(bearer(token)).query({ date: DATA_ASPORTO });
            const mine = list.body.orders.find((o: any) => o.id === asportoId);
            expect(mine.status).toBe('READY');
            expect(mine.ready_at).not.toBeNull();
        } finally {
            await api().put('/settings/features').set(bearer(token)).send({ table_orders_enabled: false });
        }
    });
});

describe('asporto — impostazioni', () => {
    it('capienza, minuti e stop si regolano e mordono subito', async () => {
        const put = await api().put('/takeaway/config').set(bearer(token))
            .send({ capacity_per_slot: 2, prep_minutes: 30 });
        expect(put.status).toBe(200);
        expect(put.body.capacity_per_slot).toBe(2);
        expect(put.body.prep_minutes).toBe(30);

        // 19:30 ha ancora 4 ordini attivi dai test sopra: con capienza 2 è pieno.
        const slots = await api().get('/takeaway/slots').set(bearer(token)).query({ date: DATA_ASPORTO });
        expect(slots.body.capacity_per_slot).toBe(2);
        const pieno = await api().post('/takeaway/orders').set(bearer(token)).send({
            customer_name: 'Oltre Capienza',
            pickup_date: DATA_ASPORTO,
            pickup_time: '19:30',
            items: [{ dish_id: dishId, qty: 1 }],
        });
        expect(pieno.status).toBe(409);
        expect(pieno.body.error).toBe('slot_full');

        const stop = await api().put('/takeaway/config').set(bearer(token)).send({ stop_date: DATA_ASPORTO });
        expect(stop.body.stop_date).toBe(DATA_ASPORTO);
        const fermo = await api().post('/takeaway/orders').set(bearer(token)).send({
            customer_name: 'A Stop Attivo',
            pickup_date: DATA_ASPORTO,
            pickup_time: '13:30',
            items: [{ dish_id: dishId, qty: 1 }],
        });
        expect(fermo.status).toBe(409);
        expect(fermo.body.error).toBe('takeaway_stopped');

        const invalido = await api().put('/takeaway/config').set(bearer(token)).send({ capacity_per_slot: 0 });
        expect(invalido.status).toBe(400);

        const ripristino = await api().put('/takeaway/config').set(bearer(token))
            .send({ capacity_per_slot: 4, prep_minutes: 20, stop_date: null });
        expect(ripristino.body).toEqual({ capacity_per_slot: 4, prep_minutes: 20, stop_date: null, online_enabled: false });
    });

    it('l\'interruttore online passa dalla config e accende la pagina pubblica', async () => {
        const on = await api().put('/takeaway/config').set(bearer(token)).send({ online_enabled: true });
        expect(on.status).toBe(200);
        expect(on.body.online_enabled).toBe(true);
        const info = await api().get('/public/takeaway/info');
        expect(info.body.takeawayEnabled).toBe(true);
        const off = await api().put('/takeaway/config').set(bearer(token)).send({ online_enabled: false });
        expect(off.body.online_enabled).toBe(false);
    });
});

describe('asporto — pubblico (/ordina, fase 2)', () => {
    afterAll(async () => {
        // Il flag torna spento: è il default e gli altri file ci contano.
        await api().put('/settings/features').set(bearer(token)).send({ takeaway_online_enabled: false });
    });

    it('la pagina /ordina è servita; slug ignoto 404, mai fallback', async () => {
        const page = await api().get('/ordina');
        expect(page.status).toBe(200);
        expect(page.headers['content-type']).toContain('text/html');
        expect(page.text).toContain('Ordina d\'asporto');
        const bad = await api().get('/ordina/ristorante-inesistente');
        expect(bad.status).toBe(404);
    });

    it('col flag spento: info dice chiuso, catalogo e ordini 503', async () => {
        const info = await api().get('/public/takeaway/info');
        expect(info.status).toBe(200);
        expect(info.body.takeawayEnabled).toBe(false);
        expect(info.body.branding.name).toBeTruthy();
        const cat = await api().get('/public/takeaway/catalogo');
        expect(cat.status).toBe(503);
        const post = await api().post('/public/takeaway/orders').send({
            customer_name: 'Web Chiuso', customer_phone: '3331112223',
            pickup_date: DATA_ASPORTO, pickup_time: '13:00',
            items: [{ dish_id: dishId, qty: 1 }],
        });
        expect(post.status).toBe(503);
    });

    it('col flag acceso: catalogo con id e prezzi in cents, slot con available', async () => {
        const on = await api().put('/settings/features').set(bearer(token)).send({ takeaway_online_enabled: true });
        expect(on.status).toBe(200);

        // Il piatto entra nel catalogo solo se sta nel menu Alla carta.
        const menus = await api().get('/menus').set(bearer(token));
        const allaCarta = menus.body.find((m: any) => m.system_key === 'ALLA_CARTA');
        expect(allaCarta).toBeTruthy();
        const dish = await api().post('/dishes').set(bearer(token)).send({
            name: 'Pizza Web Test', price: 9, category: 'Pizze Test Asporto', menu_ids: [allaCarta.id],
        });
        expect(dish.status).toBe(201);

        const cat = await api().get('/public/takeaway/catalogo');
        expect(cat.status).toBe(200);
        const mine = cat.body.piatti.find((p: any) => p.name === 'Pizza Web Test');
        expect(mine).toBeTruthy();
        expect(mine.price_cents).toBe(900);
        expect(typeof mine.id).toBe('number');

        const slots = await api().get('/public/takeaway/slots').query({ date: DATA_ASPORTO });
        expect(slots.status).toBe(200);
        expect(slots.body.stopped).toBe(false);
        const cena = slots.body.dinner.find((s: any) => s.time === '20:30');
        expect(cena).toEqual({ time: '20:30', available: true });
        // 19:30 è al completo dai test sopra: il pubblico lo vede non disponibile.
        const pieno = slots.body.dinner.find((s: any) => s.time === '19:30');
        expect(pieno.available).toBe(false);
    });

    it('ordine web valido → confermato, canale WEB, push-safe; honeypot scartato', async () => {
        const ok = await api().post('/public/takeaway/orders').send({
            customer_name: 'Cliente Web',
            customer_phone: '+39 333 444 5566',
            pickup_date: DATA_ASPORTO,
            pickup_time: '20:30',
            items: [{ dish_id: dishId, qty: 2, note: 'ben cotta' }],
            notes: 'citofono rotto',
        });
        expect(ok.status).toBe(201);
        expect(ok.body).toMatchObject({ ok: true, confirmed: true, pickup_time: '20:30', total_cents: 1700 });

        const list = await api().get('/takeaway/orders').set(bearer(token)).query({ date: DATA_ASPORTO });
        const mine = list.body.orders.find((o: any) => o.customer_name === 'Cliente Web');
        expect(mine.channel).toBe('WEB');
        expect(mine.status).toBe('CONFIRMED');
        expect(mine.items[0].note).toBe('ben cotta');

        const honeypot = await api().post('/public/takeaway/orders').send({
            customer_name: 'Bot', customer_phone: '3330000000', website: 'http://spam',
            pickup_date: DATA_ASPORTO, pickup_time: '20:30',
            items: [{ dish_id: dishId, qty: 1 }],
        });
        expect(honeypot.status).toBe(201);
        const after = await api().get('/takeaway/orders').set(bearer(token)).query({ date: DATA_ASPORTO });
        expect(after.body.orders.find((o: any) => o.customer_name === 'Bot')).toBeUndefined();
    });

    it('il web non forza: telefono obbligatorio, slot pieno 409 senza scampo', async () => {
        const senzaTelefono = await api().post('/public/takeaway/orders').send({
            customer_name: 'Senza Telefono',
            pickup_date: DATA_ASPORTO, pickup_time: '20:30',
            items: [{ dish_id: dishId, qty: 1 }],
        });
        expect(senzaTelefono.status).toBe(400);
        expect(senzaTelefono.body.error).toBe('invalid_phone');

        const pieno = await api().post('/public/takeaway/orders').send({
            customer_name: 'Su Slot Pieno', customer_phone: '3335556677',
            pickup_date: DATA_ASPORTO, pickup_time: '19:30',
            items: [{ dish_id: dishId, qty: 1 }],
            force: true,
        });
        expect(pieno.status).toBe(409);
        expect(pieno.body.error).toBe('slot_full');
    });
});

describe('asporto — entitlement', () => {
    it('senza l\'add-on le route rispondono 403', async () => {
        const off = await api().put('/settings/entitlements').set(bearer(token)).send({ takeaway: false });
        expect(off.status).toBe(200);
        const res = await api().get('/takeaway/orders').set(bearer(token));
        expect(res.status).toBe(403);
        expect(res.body.error).toBe('feature_not_enabled');
        const on = await api().put('/settings/entitlements').set(bearer(token)).send({ takeaway: true });
        expect(on.status).toBe(200);
    });
});

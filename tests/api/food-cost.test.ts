import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Client } from 'pg';
import { api, ownerToken, bearer } from './helpers';

// Food cost, Fase 1: ingredienti col prezzo (sono i prodotti del magazzino),
// schede tecniche di piatti e semilavorati, costi calcolati dal server. Più i
// recinti: permesso, entitlement, ingredienti di un altro ristorante, e il
// prodotto in una scheda che non si cancella dal magazzino.

const ALTRO_TENANT = 4391;
const WAITER_EMAIL = 'cameriere.foodcost@example.com';
const WAITER_PASSWORD = 'password-foodcost-waiter';

describe('food cost — schede e costi', () => {
    let token = '';
    let db: Client;
    const prodotti: number[] = [];
    let piattoId = 0;
    let farina = 0, uova = 0, burro = 0, sugo = 0, pomodoro = 0;
    let prodottoAltrui = 0;

    const crea = async (body: Record<string, unknown>) => {
        const res = await api().post('/food-cost/ingredienti').set(bearer(token)).send(body);
        expect(res.status, JSON.stringify(res.body)).toBe(201);
        prodotti.push(res.body.id);
        return res.body;
    };

    beforeAll(async () => {
        token = await ownerToken();
        db = new Client({ connectionString: process.env.DATABASE_URL || 'postgresql://localhost/ristotest_api' });
        await db.connect();
        // Un altro ristorante con un suo prodotto: non deve entrare nelle
        // schede del ristorante 1.
        await db.query(`INSERT INTO tenants (id, slug, name) VALUES ($1, 'trattoria-foodcost', 'Trattoria Food Cost')
                        ON CONFLICT (id) DO NOTHING`, [ALTRO_TENANT]);
        await db.query(`SELECT setval(pg_get_serial_sequence('tenants','id'), (SELECT MAX(id) FROM tenants))`);
        const altrui = await db.query(
            `INSERT INTO inventory_products (tenant_id, area, name, unit, costo_cents, unita_costo)
             VALUES ($1, 'CUCINA', 'Tartufo altrui', 'kg', 90000, 'kg') RETURNING id`,
            [ALTRO_TENANT],
        );
        prodottoAltrui = altrui.rows[0].id;

        const piatto = await api().post('/dishes').set(bearer(token)).send({
            name: 'Tagliatelle food cost', description: '', price: 13.2, category: 'Primi', allergens: [],
        });
        expect(piatto.status).toBe(201);
        piattoId = piatto.body.id;
    });

    afterAll(async () => {
        await db.query(`DELETE FROM food_cost_righe WHERE tenant_id = 1 AND (dish_id = $1 OR preparazione_id = ANY($2::int[]))`, [piattoId, prodotti]);
        await db.query(`DELETE FROM dishes WHERE id = $1`, [piattoId]);
        await db.query(`DELETE FROM inventory_products WHERE id = ANY($1::int[])`, [prodotti]);
        await db.query(`DELETE FROM inventory_products WHERE tenant_id = $1`, [ALTRO_TENANT]);
        await db.query(`DELETE FROM food_cost_settings WHERE tenant_id = 1`);
        await db.query(`DELETE FROM role_permissions WHERE tenant_id = $1`, [ALTRO_TENANT]);
        await db.query(`DELETE FROM tenants WHERE id = $1`, [ALTRO_TENANT]);
        await db.query(`DELETE FROM users WHERE email = $1`, [WAITER_EMAIL]);
        await api().put('/settings/entitlements').set(bearer(token)).send({ food_cost: true });
        await db.end();
    });

    it('il ristorante 1 ha il modulo e i dati si leggono', async () => {
        const res = await api().get('/food-cost/dati').set(bearer(token));
        expect(res.status).toBe(200);
        expect(res.body.canManage).toBe(true);
        expect(res.body.impostazioni).toEqual({ targetPct: 30, ivaBanchettiPct: 10, quotaBambiniPct: 50 });
    });

    it('crea gli ingredienti nel magazzino, col prezzo e il suo storico', async () => {
        farina = (await crea({ nome: 'Farina 00 fc', unitaCosto: 'kg', costoCents: 80 })).id;
        uova = (await crea({ nome: 'Uova fc', unitaCosto: 'pz', costoCents: 25 })).id;
        burro = (await crea({ nome: 'Burro fc', unitaCosto: 'kg' })).id;
        pomodoro = (await crea({ nome: 'Pomodoro fc', unitaCosto: 'kg', costoCents: 200, resaPct: 80 })).id;

        // Il prodotto c'è in magazzino, ma la lettura del magazzino non porta il costo.
        const inv = await api().get('/inventory/products?area=CUCINA').set(bearer(token));
        const riga = inv.body.find((p: any) => p.id === farina);
        expect(riga).toBeTruthy();
        expect(riga.costo_cents).toBeUndefined();

        const doppione = await api().post('/food-cost/ingredienti').set(bearer(token)).send({ nome: 'Farina 00 fc', unitaCosto: 'kg' });
        expect(doppione.status).toBe(409);

        const prezzo = await api().patch(`/food-cost/ingredienti/${burro}`).set(bearer(token)).send({ costoCents: 900 });
        expect(prezzo.status).toBe(200);
        expect(prezzo.body.costoCents).toBe(900);
        const storico = await api().get(`/food-cost/ingredienti/${burro}/prezzi`).set(bearer(token));
        expect(storico.body.prezzi).toHaveLength(1);
        expect(storico.body.prezzi[0]).toMatchObject({ costoCents: 900, unitaCosto: 'kg', fonte: 'MANUALE' });

        // Rimandare lo stesso prezzo non sporca lo storico.
        await api().patch(`/food-cost/ingredienti/${burro}`).set(bearer(token)).send({ costoCents: 900 });
        expect((await api().get(`/food-cost/ingredienti/${burro}/prezzi`).set(bearer(token))).body.prezzi).toHaveLength(1);
    });

    it('un semilavorato: costo al kg dalla sua ricetta, e niente cicli', async () => {
        sugo = (await crea({ nome: 'Sugo fc', unitaCosto: 'kg', isPreparazione: true })).id;
        // 1000 g di pomodoro netto all'80% = 1,25 kg lordo × 200 c = 250 c,
        // 50 g di burro = 45 c → 295 c per 800 g di sugo
        const res = await api().put(`/food-cost/schede/preparazione/${sugo}`).set(bearer(token)).send({
            righe: [{ productId: pomodoro, quantita: 1000 }, { productId: burro, quantita: 50 }],
            resaQuantita: 800,
        });
        expect(res.status, JSON.stringify(res.body)).toBe(200);
        expect(res.body.ingrediente).toMatchObject({ isPreparazione: true, resaQuantita: 800, unitaCosto: 'kg' });

        const sestesso = await api().put(`/food-cost/schede/preparazione/${sugo}`).set(bearer(token)).send({
            righe: [{ productId: sugo, quantita: 10 }], resaQuantita: 100,
        });
        expect(sestesso.status).toBe(409);
        expect(sestesso.body.code).toBe('ciclo');

        // Un secondo semilavorato che contiene il sugo, poi il sugo che
        // contiene lui: il giro si chiude e il server lo rifiuta.
        const base = (await crea({ nome: 'Base fc', unitaCosto: 'kg', isPreparazione: true })).id;
        const ok = await api().put(`/food-cost/schede/preparazione/${base}`).set(bearer(token)).send({
            righe: [{ productId: sugo, quantita: 200 }], resaQuantita: 200,
        });
        expect(ok.status).toBe(200);
        const giro = await api().put(`/food-cost/schede/preparazione/${sugo}`).set(bearer(token)).send({
            righe: [{ productId: pomodoro, quantita: 1000 }, { productId: base, quantita: 10 }], resaQuantita: 800,
        });
        expect(giro.status).toBe(409);
        expect(giro.body.code).toBe('ciclo');
    });

    it('la scheda del piatto dà costo, food cost e margine', async () => {
        // Per 4 porzioni: 400 g di farina (32 c), 4 uova (100 c), 400 g di
        // sugo (295/800 × 400 = 147,5 c) → 279,5 c / 4 = 69,875 c a porzione
        const res = await api().put(`/food-cost/schede/piatto/${piattoId}`).set(bearer(token)).send({
            righe: [
                { productId: farina, quantita: 400 },
                { productId: uova, quantita: 4 },
                { productId: sugo, quantita: 400, note: 'a fine cottura' },
            ],
            porzioni: 4,
        });
        expect(res.status, JSON.stringify(res.body)).toBe(200);
        expect(res.body.righe).toHaveLength(3);
        expect(res.body.costo.stato).toBe('completo');
        expect(res.body.costo.cents).toBeCloseTo(69.875, 6);

        const piatti = await api().get('/food-cost/piatti').set(bearer(token));
        expect(piatti.status).toBe(200);
        const p = piatti.body.piatti.find((x: any) => x.id === piattoId);
        // 13,20 € con IVA 10% = 1200 c netti
        expect(p.costoCents).toBeCloseTo(69.875, 6);
        expect(p.foodCostPct).toBeCloseTo(69.875 / 1200 * 100, 6);
        expect(p.margineCents).toBeCloseTo(1200 - 69.875, 6);
    });

    it('un rincaro arriva fino al piatto passando dal semilavorato', async () => {
        await api().patch(`/food-cost/ingredienti/${burro}`).set(bearer(token)).send({ costoCents: 1800 });
        const piatti = await api().get('/food-cost/piatti').set(bearer(token));
        const p = piatti.body.piatti.find((x: any) => x.id === piattoId);
        // Il sugo passa a 250 + 90 = 340 c per 800 g → 400 g = 170 c
        expect(p.costoCents).toBeCloseTo((32 + 100 + 170) / 4, 6);
    });

    it('un ingrediente in una scheda non si cancella dal magazzino', async () => {
        const res = await api().delete(`/inventory/products/${farina}`).set(bearer(token));
        expect(res.status).toBe(409);
        expect(res.body.code).toBe('in_scheda');
        expect(res.body.schede).toContain('Tagliatelle Food Cost');
    });

    it('rifiuta ingredienti e piatti di un altro ristorante', async () => {
        const res = await api().put(`/food-cost/schede/piatto/${piattoId}`).set(bearer(token)).send({
            righe: [{ productId: prodottoAltrui, quantita: 10 }], porzioni: 1,
        });
        expect(res.status).toBe(400);
        expect(res.body.code).toBe('ingrediente');

        const piattoAltrui = await db.query(`INSERT INTO dishes (tenant_id, name, price) VALUES ($1, 'Piatto altrui', 10) RETURNING id`, [ALTRO_TENANT]);
        const altro = await api().put(`/food-cost/schede/piatto/${piattoAltrui.rows[0].id}`).set(bearer(token)).send({ righe: [], porzioni: 1 });
        expect(altro.status).toBe(404);
        await db.query(`DELETE FROM dishes WHERE id = $1`, [piattoAltrui.rows[0].id]);

        const prezzo = await api().patch(`/food-cost/ingredienti/${prodottoAltrui}`).set(bearer(token)).send({ costoCents: 1 });
        expect(prezzo.status).toBe(404);
    });

    it('valida righe e impostazioni', async () => {
        const zero = await api().put(`/food-cost/schede/piatto/${piattoId}`).set(bearer(token)).send({
            righe: [{ productId: farina, quantita: 0 }], porzioni: 1,
        });
        expect(zero.status).toBe(400);

        const imp = await api().put('/food-cost/impostazioni').set(bearer(token)).send({ targetPct: 28 });
        expect(imp.status).toBe(200);
        expect(imp.body).toEqual({ targetPct: 28, ivaBanchettiPct: 10, quotaBambiniPct: 50 });
        expect((await api().put('/food-cost/impostazioni').set(bearer(token)).send({ targetPct: 200 })).status).toBe(400);
    });

    it('un cameriere non vede i costi', async () => {
        const created = await api().post('/auth/users').set(bearer(token)).send({
            email: WAITER_EMAIL, password: WAITER_PASSWORD, full_name: 'Cameriere Food Cost', role: 'WAITER',
        });
        expect(created.status).toBe(201);
        const login = await api().post('/auth/login').send({ email: WAITER_EMAIL, password: WAITER_PASSWORD });
        const waiter = login.body.accessToken;
        expect((await api().get('/food-cost/dati').set(bearer(waiter))).status).toBe(403);
        expect((await api().get('/food-cost/piatti').set(bearer(waiter))).status).toBe(403);
        expect((await api().patch(`/food-cost/ingredienti/${burro}`).set(bearer(waiter)).send({ costoCents: 1 })).status).toBe(403);
    });

    it('senza il modulo le rotte rispondono 403 feature_not_enabled', async () => {
        const off = await api().put('/settings/entitlements').set(bearer(token)).send({ food_cost: false });
        expect(off.status).toBe(200);
        const res = await api().get('/food-cost/dati').set(bearer(token));
        expect(res.status).toBe(403);
        expect(res.body.error).toBe('feature_not_enabled');
        await api().put('/settings/entitlements').set(bearer(token)).send({ food_cost: true });
        expect((await api().get('/food-cost/dati').set(bearer(token))).status).toBe(200);
    });

    it('una scheda svuotata torna «senza scheda»', async () => {
        const res = await api().put(`/food-cost/schede/piatto/${piattoId}`).set(bearer(token)).send({ righe: [], porzioni: 1 });
        expect(res.status).toBe(200);
        const left = await db.query(`SELECT COUNT(*)::int AS c FROM food_cost_piatti WHERE dish_id = $1`, [piattoId]);
        expect(left.rows[0].c).toBe(0);
        // Ora la farina si può cancellare dal magazzino.
        expect((await api().delete(`/inventory/products/${farina}`).set(bearer(token))).status).toBe(204);
    });
});

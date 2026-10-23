import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Client } from 'pg';
import { api, ownerToken, bearer } from './helpers';

// Storico del magazzino: chi ha caricato o scaricato cosa, quando e quanto.
// GET /inventory/movements (voci sommate, a pagine) e /latest (l'ultima voce
// di ogni prodotto, la riga sotto il nome).

const dbUrl = () => process.env.DATABASE_URL || 'postgresql://localhost/ristotest_api';
const WAITER_EMAIL = 'cameriere.movimenti@test.local';
const WAITER_PASSWORD = 'Movimenti-Test-2026!';
const COOK_EMAIL = 'cuoco.movimenti@test.local';

describe('magazzino · storico dei movimenti', () => {
    let owner = '';
    let ownerName = '';
    let ownerEmail = '';
    let waiter = '';
    let waiterId = 0;
    let cook = '';
    let cookId = 0;
    let ownerId = 0;
    let locationId = 0;
    let productId = 0;
    let bulkProductId = 0;
    let db: Client;

    const move = (delta: number, reason: string) =>
        api().post('/inventory/movements').set(bearer(owner))
            .send({ product_id: productId, location_id: locationId, delta, reason });

    beforeAll(async () => {
        owner = await ownerToken();
        const me = await api().get('/auth/me').set(bearer(owner));
        ownerName = me.body.full_name ?? me.body.user?.full_name;
        ownerEmail = me.body.email ?? me.body.user?.email;
        expect(ownerName).toBeTruthy();

        const created = await api().post('/auth/users').set(bearer(owner))
            .send({ email: WAITER_EMAIL, password: WAITER_PASSWORD, full_name: 'Cameriere Movimenti', role: 'WAITER' });
        expect(created.status).toBe(201);
        waiterId = created.body.id;
        const session = await api().post('/auth/login').send({ email: WAITER_EMAIL, password: WAITER_PASSWORD });
        expect(session.status).toBe(200);
        waiter = session.body.accessToken;

        // La cucina carica e scarica (inventory:full): è il secondo nome nel
        // filtro per persona.
        const cookUser = await api().post('/auth/users').set(bearer(owner))
            .send({ email: COOK_EMAIL, password: WAITER_PASSWORD, full_name: 'Cuoco Movimenti', role: 'KITCHEN' });
        expect(cookUser.status).toBe(201);
        cookId = cookUser.body.id;
        const cookSession = await api().post('/auth/login').send({ email: COOK_EMAIL, password: WAITER_PASSWORD });
        expect(cookSession.status).toBe(200);
        cook = cookSession.body.accessToken;
        ownerId = me.body.id ?? me.body.user?.id;

        const loc = await api().post('/inventory/locations').set(bearer(owner))
            .send({ area: 'BAR', name: 'Frigo movimenti test', sort_order: 9 });
        expect(loc.status).toBe(201);
        locationId = loc.body.id;
        const prod = await api().post('/inventory/products').set(bearer(owner))
            .send({ area: 'BAR', name: 'Acqua movimenti test', unit: 'bt' });
        expect(prod.status).toBe(201);
        productId = prod.body.id;
        const bulk = await api().post('/inventory/products').set(bearer(owner))
            .send({ area: 'BAR', name: 'Limoni movimenti test', unit: 'kg' });
        expect(bulk.status).toBe(201);
        bulkProductId = bulk.body.id;

        db = new Client({ connectionString: dbUrl() });
        await db.connect();
    });

    afterAll(async () => {
        try {
            await db.query(`DELETE FROM inventory_products WHERE id = ANY($1::int[])`, [[productId, bulkProductId]]);
            await db.query(`DELETE FROM inventory_locations WHERE id = $1`, [locationId]);
            await db.query(`DELETE FROM notifications WHERE tag LIKE 'low-stock-%'`);
            await db.query(`DELETE FROM users WHERE id = ANY($1::int[])`, [[waiterId, cookId].filter(Boolean)]);
        } finally {
            await db.end();
        }
    });

    it('il movimento firma col nome, non con l\'email', async () => {
        const res = await move(1, 'CARICO');
        expect(res.status).toBe(201);
        expect(res.body.movement.user_name).toBe(ownerName);
        expect(res.body.movement.from_invoice).toBe(false);
        const row = await db.query(`SELECT user_name FROM inventory_movements WHERE id = $1`, [res.body.movement.id]);
        expect(row.rows[0].user_name).toBe(ownerName);
        expect(row.rows[0].user_name).not.toBe(ownerEmail);
    });

    it('tre tocchi su + e un conteggio: due voci, la più recente prima', async () => {
        expect((await move(1, 'CARICO')).status).toBe(201);
        expect((await move(1, 'CARICO')).status).toBe(201);
        // Totale 3 → contato 8: +5 scritto a mano.
        expect((await move(5, 'RETTIFICA')).status).toBe(201);

        const res = await api().get('/inventory/movements').set(bearer(owner)).query({ product_id: productId });
        expect(res.status).toBe(200);
        expect(res.body.next_before).toBeNull();
        expect(res.body.entries.map((e: any) => [e.reason, e.delta, e.count])).toEqual([
            ['RETTIFICA', 5, 1],
            ['CARICO', 3, 3],
        ]);
        for (const e of res.body.entries) {
            expect(e.user_name).toBe(ownerName);
            expect(e.location_id).toBe(locationId);
            expect(typeof e.at).toBe('string');
        }
    });

    it('carichi e scarichi: il filtro guarda il segno', async () => {
        expect((await move(-2, 'SCARICO')).status).toBe(201);
        const out = await api().get('/inventory/movements').set(bearer(owner)).query({ product_id: productId, kind: 'out' });
        expect(out.status).toBe(200);
        expect(out.body.entries.map((e: any) => e.delta)).toEqual([-2]);
        const inn = await api().get('/inventory/movements').set(bearer(owner)).query({ product_id: productId, kind: 'in' });
        expect(inn.body.entries.map((e: any) => e.delta)).toEqual([5, 3]);
    });

    it('per area: ci sono le voci del prodotto, e solo dell\'area', async () => {
        const bar = await api().get('/inventory/movements').set(bearer(owner)).query({ area: 'BAR' });
        expect(bar.status).toBe(200);
        expect(bar.body.entries.filter((e: any) => e.product_id === productId)).toHaveLength(3);
        const cucina = await api().get('/inventory/movements').set(bearer(owner)).query({ area: 'CUCINA' });
        expect(cucina.body.entries.some((e: any) => e.product_id === productId)).toBe(false);
    });

    it('l\'ultima voce di ogni prodotto', async () => {
        const res = await api().get('/inventory/movements/latest').set(bearer(owner)).query({ area: 'BAR' });
        expect(res.status).toBe(200);
        const mine = res.body.find((e: any) => e.product_id === productId);
        expect(mine).toMatchObject({ reason: 'SCARICO', delta: -2, user_name: ownerName });
        // Un prodotto mai mosso non ha voce.
        expect(res.body.some((e: any) => e.product_id === bulkProductId)).toBe(false);
    });

    it('chi vede il magazzino vede anche lo storico', async () => {
        const res = await api().get('/inventory/movements').set(bearer(waiter)).query({ product_id: productId });
        expect(res.status).toBe(200);
        expect(res.body.entries.length).toBeGreaterThan(0);
        expect((await api().get('/inventory/movements/latest').set(bearer(waiter)).query({ area: 'BAR' })).status).toBe(200);
    });

    it('il nome si legge dall\'utente, anche sui movimenti firmati con l\'email', async () => {
        // I movimenti di prima del 23/10/2026 hanno l'email in user_name.
        const ownerId = (await db.query(`SELECT id FROM users WHERE email = $1`, [ownerEmail])).rows[0].id;
        await db.query(
            `INSERT INTO inventory_movements (tenant_id, product_id, location_id, delta, reason, user_id, user_name)
             VALUES (1, $1, $2, 4, 'CARICO', $3, $4)`,
            [bulkProductId, locationId, ownerId, ownerEmail]
        );
        const res = await api().get('/inventory/movements').set(bearer(owner)).query({ product_id: bulkProductId });
        expect(res.body.entries[0].user_name).toBe(ownerName);
    });

    it('a pagine: niente doppioni né buchi, anche con la stessa ora', async () => {
        // 405 righe con lo stesso created_at (come un carico da fattura, che
        // le scrive tutte in una transazione) e firme alterne, così nessuna
        // si somma alla vicina: 405 voci, 400 nella prima pagina.
        await db.query(`DELETE FROM inventory_movements WHERE product_id = $1`, [bulkProductId]);
        await db.query(
            `INSERT INTO inventory_movements (tenant_id, product_id, location_id, delta, reason, user_id, user_name, created_at)
             SELECT 1, $1, $2, 1, 'CARICO', NULL, CASE WHEN g % 2 = 0 THEN 'pari' ELSE 'dispari' END,
                    '2026-10-20 10:00:00.123456+02'::timestamptz
               FROM generate_series(1, 405) g`,
            [bulkProductId, locationId]
        );
        const first = await api().get('/inventory/movements').set(bearer(owner)).query({ product_id: bulkProductId });
        expect(first.status).toBe(200);
        expect(first.body.entries).toHaveLength(400);
        expect(typeof first.body.next_before).toBe('string');

        const second = await api().get('/inventory/movements').set(bearer(owner))
            .query({ product_id: bulkProductId, before: first.body.next_before });
        expect(second.status).toBe(200);
        expect(second.body.entries).toHaveLength(5);
        expect(second.body.next_before).toBeNull();

        const ids = [...first.body.entries, ...second.body.entries].map((e: any) => e.id);
        expect(new Set(ids).size).toBe(405);
    });

    it('per persona: chi c\'è, e solo le sue voci', async () => {
        const cookMove = await api().post('/inventory/movements').set(bearer(cook))
            .send({ product_id: productId, location_id: locationId, delta: -1, reason: 'SCARICO' });
        expect(cookMove.status).toBe(201);
        // Un collega che non ha più l'utente: resta la firma.
        await db.query(
            `INSERT INTO inventory_movements (tenant_id, product_id, location_id, delta, reason, user_id, user_name, created_at)
             VALUES (1, $1, $2, 2, 'CARICO', NULL, 'Ex collega', NOW() - interval '1 day')`,
            [productId, locationId]
        );

        const people = await api().get('/inventory/movements/people').set(bearer(waiter)).query({ product_id: productId });
        expect(people.status).toBe(200);
        // Dal più recente.
        expect(people.body.map((p: any) => [p.user_id, p.user_name])).toEqual([
            [cookId, 'Cuoco Movimenti'],
            [ownerId, ownerName],
            [null, 'Ex collega'],
        ]);
        const bar = await api().get('/inventory/movements/people').set(bearer(owner)).query({ area: 'BAR' });
        expect(bar.body.map((p: any) => p.user_name)).toEqual(expect.arrayContaining(['Cuoco Movimenti', ownerName, 'Ex collega']));
        const cucina = await api().get('/inventory/movements/people').set(bearer(owner)).query({ area: 'CUCINA' });
        expect(cucina.body.some((p: any) => p.user_id === cookId)).toBe(false);

        const soloCuoco = await api().get('/inventory/movements').set(bearer(owner))
            .query({ product_id: productId, user_id: cookId });
        expect(soloCuoco.body.entries.map((e: any) => [e.user_name, e.delta])).toEqual([['Cuoco Movimenti', -1]]);

        const soloTitolare = await api().get('/inventory/movements').set(bearer(owner))
            .query({ area: 'BAR', user_id: ownerId, kind: 'out' });
        expect(soloTitolare.body.entries.length).toBeGreaterThan(0);
        expect(soloTitolare.body.entries.every((e: any) => e.user_name === ownerName && e.delta < 0)).toBe(true);

        const exCollega = await api().get('/inventory/movements').set(bearer(owner))
            .query({ product_id: productId, user_name: 'Ex collega' });
        expect(exCollega.body.entries.map((e: any) => [e.user_name, e.delta])).toEqual([['Ex collega', 2]]);
        // La firma vale solo per chi non ha più l'utente: col nome di un
        // utente attivo non si pesca niente.
        const perNome = await api().get('/inventory/movements').set(bearer(owner))
            .query({ product_id: productId, user_name: 'Cuoco Movimenti' });
        expect(perNome.body.entries).toEqual([]);
    });

    it('parametri sbagliati: 400', async () => {
        const get = (query: Record<string, string>) =>
            api().get('/inventory/movements').set(bearer(owner)).query(query);
        expect((await get({})).status).toBe(400);
        expect((await get({ area: 'GARAGE' })).status).toBe(400);
        expect((await get({ product_id: 'abc' })).status).toBe(400);
        expect((await get({ area: 'BAR', kind: 'tutto' })).status).toBe(400);
        expect((await get({ area: 'BAR', before: 'ieri|3' })).status).toBe(400);
        expect((await get({ area: 'BAR', user_id: 'marco' })).status).toBe(400);
        expect((await get({ area: 'BAR', user_name: ' ' })).status).toBe(400);
        expect((await api().get('/inventory/movements/people').set(bearer(owner))).status).toBe(400);
        expect((await api().get('/inventory/movements/latest').set(bearer(owner))).status).toBe(400);
    });
});

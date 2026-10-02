import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Client } from 'pg';
import { api, ownerToken, bearer } from './helpers';

// «Scorta bassa»: la push parte quando un movimento porta il prodotto sotto
// soglia e si chiude per tutti quando lo si ricarica sopra soglia o lo si
// elimina. Il titolare è fra i destinatari (LOW_STOCK_ALERT_ROLES).

const dbUrl = () => process.env.DATABASE_URL || 'postgresql://localhost/ristotest_api';

describe('magazzino · scorta bassa', () => {
    let owner = '';
    let ownerId = 0;
    let locationId = 0;
    let productId = 0;
    let db: Client;

    const tag = () => `low-stock-${productId}`;
    const ownerRow = async () =>
        (await db.query(
            `SELECT read_at, body FROM notifications
              WHERE tenant_id = 1 AND recipient_user_id = $1 AND tag = $2 AND dismissed_at IS NULL`,
            [ownerId, tag()]
        )).rows[0] ?? null;
    const move = (delta: number, reason: string) =>
        api().post('/inventory/movements').set(bearer(owner))
            .send({ product_id: productId, location_id: locationId, delta, reason });

    beforeAll(async () => {
        owner = await ownerToken();
        const me = await api().post('/auth/login').send({
            email: process.env.TEST_OWNER_EMAIL,
            password: process.env.TEST_OWNER_PASSWORD,
        });
        ownerId = me.body.user.id;
        const loc = await api().post('/inventory/locations').set(bearer(owner))
            .send({ area: 'CUCINA', name: 'Dispensa scorte test', sort_order: 9 });
        expect(loc.status).toBe(201);
        locationId = loc.body.id;
        const prod = await api().post('/inventory/products').set(bearer(owner))
            .send({ area: 'CUCINA', name: 'Riso scorte test', unit: 'kg' });
        expect(prod.status).toBe(201);
        productId = prod.body.id;

        db = new Client({ connectionString: dbUrl() });
        await db.connect();
    });

    afterAll(async () => {
        try {
            await db.query(`DELETE FROM notifications WHERE tag LIKE 'low-stock-%'`);
            await db.query(`DELETE FROM inventory_locations WHERE id = $1`, [locationId]);
        } finally {
            await db.end();
        }
    });

    it('sotto soglia: arriva la «scorta bassa»', async () => {
        expect((await move(10, 'CARICO')).status).toBe(201);
        expect(await ownerRow()).toBeNull();

        expect((await move(-7, 'SCARICO')).status).toBe(201);
        const row = await ownerRow();
        expect(row).not.toBeNull();
        expect(row.read_at).toBeNull();
        expect(row.body).toBe('Riso scorte test: 3 kg rimanenti');
    });

    it('ricaricato sopra soglia: si chiude per tutti', async () => {
        expect((await move(5, 'CARICO')).status).toBe(201);
        expect((await ownerRow()).read_at).not.toBeNull();
    });

    it('di nuovo sotto soglia: si riapre', async () => {
        expect((await move(-6, 'SCARICO')).status).toBe(201);
        expect((await ownerRow()).read_at).toBeNull();
    });

    it('prodotto eliminato: si chiude', async () => {
        const del = await api().delete(`/inventory/products/${productId}`).set(bearer(owner));
        expect(del.status).toBe(204);
        expect((await ownerRow()).read_at).not.toBeNull();
    });
});

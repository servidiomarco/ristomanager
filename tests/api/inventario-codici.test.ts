import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Client } from 'pg';
import { api, ownerToken, bearer } from './helpers';
// Il sorgente, non dist: la normalizzazione non ha dipendenze.
import { normalizeBarcode } from '../../utils/barcode';

// Codici a barre del magazzino: il campo nella scheda del prodotto e la
// scansione dal telefono (GET /inventory/barcodes/:code), che porta dritto
// al carico o allo scarico.

const dbUrl = () => process.env.DATABASE_URL || 'postgresql://localhost/ristotest_api';
const PASSWORD = 'Codici-Test-2026!';

describe('magazzino · codici a barre: la forma del codice', () => {
    it('toglie gli spazi e porta UPC-A e GTIN-14 a EAN-13', () => {
        expect(normalizeBarcode(' 800 3490 048677 ')).toBe('8003490048677');
        expect(normalizeBarcode('012345678905')).toBe('0012345678905');
        expect(normalizeBarcode('08003490048677')).toBe('8003490048677');
        // Il GTIN-14 del cartone (indicatore 1) è un altro codice.
        expect(normalizeBarcode('18003490048674')).toBe('18003490048674');
        expect(normalizeBarcode('96385074')).toBe('96385074');
    });

    it('i codici con lettere restano come sono', () => {
        expect(normalizeBarcode('Lotto-A12b')).toBe('Lotto-A12b');
    });

    it('vuoto, troppo lungo o con caratteri di controllo: niente', () => {
        expect(normalizeBarcode('')).toBeNull();
        expect(normalizeBarcode('   ')).toBeNull();
        expect(normalizeBarcode(null)).toBeNull();
        expect(normalizeBarcode('1'.repeat(65))).toBeNull();
        expect(normalizeBarcode('80034\u000190048677')).toBeNull();
    });
});

describe('magazzino · codici a barre', () => {
    let owner = '';
    let cook = '';
    let waiter = '';
    const userIds: number[] = [];
    let locationId = 0;
    let riso = 0;
    let olio = 0;
    let db: Client;

    const login = async (email: string, fullName: string, role: string) => {
        const created = await api().post('/auth/users').set(bearer(owner))
            .send({ email, password: PASSWORD, full_name: fullName, role });
        expect(created.status).toBe(201);
        userIds.push(created.body.id);
        const session = await api().post('/auth/login').send({ email, password: PASSWORD });
        expect(session.status).toBe(200);
        return session.body.accessToken as string;
    };

    beforeAll(async () => {
        owner = await ownerToken();
        cook = await login('cuoco.codici@test.local', 'Cuoco Codici', 'KITCHEN');
        waiter = await login('cameriere.codici@test.local', 'Cameriere Codici', 'WAITER');
        const loc = await api().post('/inventory/locations').set(bearer(owner))
            .send({ area: 'CUCINA', name: 'Dispensa codici test', sort_order: 9 });
        expect(loc.status).toBe(201);
        locationId = loc.body.id;
        db = new Client({ connectionString: dbUrl() });
        await db.connect();
    });

    afterAll(async () => {
        try {
            await db.query(`DELETE FROM inventory_products WHERE tenant_id = 1 AND name LIKE '% codici test'`);
            await db.query(`DELETE FROM inventory_locations WHERE id = $1`, [locationId]);
            if (userIds.length) await db.query(`DELETE FROM users WHERE id = ANY($1::int[])`, [userIds]);
        } finally {
            await db.end();
        }
    });

    it('il prodotto nasce con i suoi codici, già normalizzati', async () => {
        const res = await api().post('/inventory/products').set(bearer(owner)).send({
            area: 'CUCINA', name: 'Riso codici test', unit: 'kg',
            barcodes: ['8003490048677', ' 012345678905 ', '8003490048677'],
        });
        expect(res.status).toBe(201);
        riso = res.body.id;
        expect(res.body.barcodes).toEqual(['8003490048677', '0012345678905']);

        const list = await api().get('/inventory/products').set(bearer(owner)).query({ area: 'CUCINA' });
        expect(list.body.find((p: any) => p.id === riso).barcodes).toEqual(['8003490048677', '0012345678905']);
    });

    it('la scansione trova il prodotto, con celle e giacenze', async () => {
        await api().post('/inventory/movements').set(bearer(owner))
            .send({ product_id: riso, location_id: locationId, delta: 4, reason: 'CARICO' });
        // Il telefono legge l'UPC-A a 12 cifre: è lo stesso codice.
        const res = await api().get('/inventory/barcodes/012345678905').set(bearer(waiter));
        expect(res.status).toBe(200);
        expect(res.body.barcode).toBe('0012345678905');
        expect(res.body.product).toMatchObject({ id: riso, name: 'Riso codici test', area: 'CUCINA' });
        expect(res.body.locations.some((l: any) => l.id === locationId)).toBe(true);
        expect(res.body.stock).toEqual([{ product_id: riso, location_id: locationId, quantity: 4 }]);
    });

    it('un codice di nessuno: 404 col codice normalizzato', async () => {
        const res = await api().get('/inventory/barcodes/04006381333931').set(bearer(owner));
        expect(res.status).toBe(404);
        expect(res.body.barcode).toBe('4006381333931');
        expect((await api().get('/inventory/barcodes/%01').set(bearer(owner))).status).toBe(400);
    });

    it('un codice già di un altro prodotto: 409, e il prodotto nuovo non nasce', async () => {
        const res = await api().post('/inventory/products').set(bearer(owner)).send({
            area: 'CUCINA', name: 'Olio codici test', unit: 'l', barcodes: ['8003490048677'],
        });
        expect(res.status).toBe(409);
        expect(res.body).toMatchObject({ code: 'barcode_taken', barcode: '8003490048677', product: { id: riso, name: 'Riso codici test' } });
        const exists = await db.query(`SELECT 1 FROM inventory_products WHERE tenant_id = 1 AND name = 'Olio codici test'`);
        expect(exists.rowCount).toBe(0);
    });

    it('la modifica con la lista sostituisce i codici; senza lista non li tocca', async () => {
        const put = await api().put(`/inventory/products/${riso}`).set(bearer(owner))
            .send({ name: 'Riso codici test', unit: 'kg', barcodes: ['8003490048677'] });
        expect(put.status).toBe(200);
        expect(put.body.barcodes).toEqual(['8003490048677']);
        expect((await api().get('/inventory/barcodes/0012345678905').set(bearer(owner))).status).toBe(404);

        const old = await api().put(`/inventory/products/${riso}`).set(bearer(owner))
            .send({ name: 'Riso codici test', unit: 'kg' });
        expect(old.status).toBe(200);
        expect(old.body.barcodes).toEqual(['8003490048677']);
    });

    it('associare un codice letto a un prodotto esistente', async () => {
        const created = await api().post('/inventory/products').set(bearer(owner))
            .send({ area: 'CUCINA', name: 'Olio codici test', unit: 'l' });
        expect(created.status).toBe(201);
        olio = created.body.id;
        expect(created.body.barcodes).toEqual([]);

        const add = await api().post(`/inventory/products/${olio}/barcodes`).set(bearer(cook)).send({ code: '012345678905' });
        expect(add.status).toBe(200);
        expect(add.body.barcodes).toEqual(['0012345678905']);
        // Di nuovo: niente cambia.
        const again = await api().post(`/inventory/products/${olio}/barcodes`).set(bearer(cook)).send({ code: '0012345678905' });
        expect(again.status).toBe(200);
        expect(again.body.barcodes).toEqual(['0012345678905']);
        // Il codice del riso: no.
        const taken = await api().post(`/inventory/products/${olio}/barcodes`).set(bearer(cook)).send({ code: '8003490048677' });
        expect(taken.status).toBe(409);
        expect(taken.body.product.id).toBe(riso);

        const scan = await api().get('/inventory/barcodes/0012345678905').set(bearer(cook));
        expect(scan.body.product.id).toBe(olio);
    });

    it('chi vede soltanto può scansionare ma non associare', async () => {
        expect((await api().get('/inventory/barcodes/8003490048677').set(bearer(waiter))).status).toBe(200);
        const add = await api().post(`/inventory/products/${olio}/barcodes`).set(bearer(waiter)).send({ code: '96385074' });
        expect(add.status).toBe(403);
    });

    it('liste sbagliate: 400', async () => {
        const bad = (barcodes: unknown) => api().put(`/inventory/products/${riso}`).set(bearer(owner))
            .send({ name: 'Riso codici test', barcodes });
        expect((await bad('8003490048677')).status).toBe(400);
        expect((await bad([''])).status).toBe(400);
        expect((await bad(Array.from({ length: 21 }, (_, i) => `CODE${i}`))).status).toBe(400);
        expect((await api().post(`/inventory/products/${olio}/barcodes`).set(bearer(owner)).send({ code: ' ' })).status).toBe(400);
        expect((await api().post(`/inventory/products/999999/barcodes`).set(bearer(owner)).send({ code: '96385074' })).status).toBe(404);
    });

    it('eliminato il prodotto, il suo codice è di nuovo libero', async () => {
        expect((await api().delete(`/inventory/products/${olio}`).set(bearer(owner))).status).toBe(204);
        expect((await api().get('/inventory/barcodes/0012345678905').set(bearer(owner))).status).toBe(404);
    });
});

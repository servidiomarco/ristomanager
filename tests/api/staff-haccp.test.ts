import { describe, it, expect, beforeAll } from 'vitest';
import { api, bearer, ownerToken } from './helpers';

// Staff, HACCP e inventario dopo lo scoping per tenant (Fase B3.2): i CRUD
// devono continuare a funzionare per il tenant autenticato e gli upsert HACCP
// devono aggiornare la riga del giorno invece di duplicarla, ora che il
// vincolo unico include tenant_id.
describe('staff, haccp, inventario', () => {
    let token: string;

    beforeAll(async () => {
        token = await ownerToken();
    });

    describe('staff', () => {
        // Gli id dello staff sono UUID (gen_random_uuid), non seriali.
        let staffId: string;

        it('crea un dipendente e lo ritrova nella lista', async () => {
            const created = await api().post('/staff').set(bearer(token)).send({
                name: 'Anna',
                surname: 'Collaudo',
                category: 'SALA',
                staffType: 'FISSO',
                phone: '3331112223',
            });
            expect(created.status).toBe(201);
            expect(created.body.id).toBeTypeOf('string');
            expect(created.body.id).toMatch(/^[0-9a-f-]{36}$/);
            expect(created.body.name).toBe('Anna');
            expect(created.body.staffType).toBe('FISSO');
            staffId = created.body.id;

            const list = await api().get('/staff').set(bearer(token));
            expect(list.status).toBe(200);
            const found = list.body.find((s: any) => s.id === staffId);
            expect(found).toBeDefined();
            expect(found.surname).toBe('Collaudo');
        });

        it('crea i turni in bulk e li rilegge per data', async () => {
            const bulk = await api().post('/staff/shifts/bulk').set(bearer(token)).send({
                shifts: [
                    { staffId, date: '2026-09-01', shift: 'LUNCH', present: true },
                    { staffId, date: '2026-09-01', shift: 'DINNER', present: false, notes: 'esce prima' },
                ],
            });
            expect(bulk.status).toBe(201);
            expect(bulk.body).toHaveLength(2);
            expect(bulk.body[0].staffId).toBe(staffId);

            const list = await api().get('/staff/shifts').set(bearer(token)).query({ date: '2026-09-01' });
            expect(list.status).toBe(200);
            const mine = list.body.filter((s: any) => s.staffId === staffId);
            expect(mine).toHaveLength(2);
            const dinner = mine.find((s: any) => s.shift === 'DINNER');
            expect(dinner.present).toBe(false);
            expect(dinner.notes).toBe('esce prima');
        });

        it('il bulk rifiuta uno staff_id inesistente (o di un altro tenant)', async () => {
            // UUID ben formato ma mai emesso: esercita il controllo di
            // appartenenza al tenant, non la validazione di formato.
            const bulk = await api().post('/staff/shifts/bulk').set(bearer(token)).send({
                shifts: [{ staffId: '00000000-0000-4000-8000-000000000000', date: '2026-09-01', shift: 'LUNCH', present: true }],
            });
            expect(bulk.status).toBe(404);
        });
    });

    describe('haccp', () => {
        it('la seconda lettura temperatura sulla stessa cella aggiorna, non duplica', async () => {
            const first = await api().post('/haccp/temperatures').set(bearer(token)).send({
                date: '2026-09-02',
                location: 'Frigo carne',
                temperature: 3.5,
                targetMax: 4,
            });
            expect(first.status).toBe(201);
            const firstId = first.body.id;
            expect(first.body.temperature).toBe(3.5);

            const second = await api().post('/haccp/temperatures').set(bearer(token)).send({
                date: '2026-09-02',
                location: 'Frigo carne',
                temperature: 2.8,
                targetMax: 4,
                note: 'ricontrollo serale',
            });
            expect(second.status).toBe(201);
            // Upsert su (tenant_id, date, location): stessa riga, valori nuovi.
            expect(second.body.id).toBe(firstId);
            expect(second.body.temperature).toBe(2.8);
            expect(second.body.note).toBe('ricontrollo serale');

            const list = await api().get('/haccp/temperatures').set(bearer(token)).query({ date: '2026-09-02' });
            expect(list.status).toBe(200);
            const perCella = list.body.filter((r: any) => r.location === 'Frigo carne');
            expect(perCella).toHaveLength(1);
            expect(perCella[0].temperature).toBe(2.8);
        });

        it('celle diverse nello stesso giorno restano righe distinte', async () => {
            const other = await api().post('/haccp/temperatures').set(bearer(token)).send({
                date: '2026-09-02',
                location: 'Frigo pesce',
                temperature: 1.2,
            });
            expect(other.status).toBe(201);

            const list = await api().get('/haccp/temperatures').set(bearer(token)).query({ date: '2026-09-02' });
            expect(list.body).toHaveLength(2);
        });
    });

    describe('inventario', () => {
        let locationId: number;
        let productId: number;

        it('crea una location e un prodotto nella stessa area', async () => {
            const loc = await api().post('/inventory/locations').set(bearer(token)).send({
                area: 'CUCINA',
                name: 'Cella frigo test',
                sort_order: 1,
            });
            expect(loc.status).toBe(201);
            expect(loc.body.id).toBeTypeOf('number');
            locationId = loc.body.id;

            const prod = await api().post('/inventory/products').set(bearer(token)).send({
                area: 'CUCINA',
                name: 'Farina collaudo',
                unit: 'kg',
            });
            expect(prod.status).toBe(201);
            expect(prod.body.name).toBe('Farina collaudo');
            productId = prod.body.id;
        });

        it('le liste ritornano quanto creato', async () => {
            const locations = await api().get('/inventory/locations').set(bearer(token)).query({ area: 'CUCINA' });
            expect(locations.status).toBe(200);
            expect(locations.body.some((l: any) => l.id === locationId && l.name === 'Cella frigo test')).toBe(true);

            const products = await api().get('/inventory/products').set(bearer(token)).query({ area: 'CUCINA' });
            expect(products.status).toBe(200);
            expect(products.body.some((p: any) => p.id === productId && p.unit === 'kg')).toBe(true);
        });

        it('un movimento di carico aggiorna la giacenza', async () => {
            const mov = await api().post('/inventory/movements').set(bearer(token)).send({
                product_id: productId,
                location_id: locationId,
                delta: 10,
                reason: 'CARICO',
            });
            expect(mov.status).toBe(201);
            expect(mov.body.stock.quantity).toBe(10);

            const stock = await api().get('/inventory/stock').set(bearer(token)).query({ area: 'CUCINA' });
            expect(stock.status).toBe(200);
            const row = stock.body.find((s: any) => s.product_id === productId && s.location_id === locationId);
            expect(row.quantity).toBe(10);
        });
    });
});

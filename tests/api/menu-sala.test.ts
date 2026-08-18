import { describe, it, expect, beforeAll } from 'vitest';
import { api, bearer, ownerToken } from './helpers';

// Menu, sala e cucina dopo lo scoping per tenant (Fase B3.3): i CRUD devono
// continuare a funzionare per il tenant autenticato, gli upsert devono
// centrare i nuovi vincoli compositi — category_stations (tenant_id, category),
// printers (tenant_id, name), stations (tenant_id, lower(name)) — e i
// riferimenti dal body (tavoli di un'unione, piatti di un banchetto) devono
// rifiutare id fuori tenant con un 404 pulito.
//
// NOTA: questo file NON tocca i feature flag né /orders — orders-bills.test.ts
// assume che il modulo comande parta disattivato.
describe('menu, sala & cucina', () => {
    let token: string;

    beforeAll(async () => {
        token = await ownerToken();
    });

    describe('menu', () => {
        let dishId: number;

        it('crea un piatto e lo ritrova in lista col suo prezzo', async () => {
            const created = await api().post('/dishes').set(bearer(token)).send({
                name: 'Gnocchi Collaudo',
                description: 'test B3.3',
                price: 14.5,
                category: 'PRIMI',
                allergens: ['glutine'],
            });
            expect(created.status).toBe(201);
            expect(created.body.id).toBeTypeOf('number');
            dishId = created.body.id;

            const list = await api().get('/dishes').set(bearer(token));
            expect(list.status).toBe(200);
            const found = list.body.find((d: any) => d.id === dishId);
            expect(found).toBeDefined();
            expect(Number(found.price)).toBe(14.5);
            expect(found.category).toBe('PRIMI');
        });

        it('il catalogo espone il listino di default del tenant', async () => {
            // Non esiste (ancora) un endpoint per prezzare il piatto su un
            // listino: il prezzo di riga ricade su dishes.price. Qui si
            // verifica che il listino seed 'Sala' resti visibile e default
            // dopo il vincolo per-tenant (tenant_id, LOWER(name)).
            const cat = await api().get('/menu/catalogue').set(bearer(token));
            expect(cat.status).toBe(200);
            const def = cat.body.price_lists.find((l: any) => l.is_default);
            expect(def).toBeDefined();
            expect(def.name).toBe('Sala');
        });

        it('aggiorna il prezzo e rifiuta un id inesistente con 404', async () => {
            const upd = await api().put(`/dishes/${dishId}`).set(bearer(token)).send({
                name: 'Gnocchi Collaudo',
                description: 'test B3.3',
                price: 16,
                category: 'PRIMI',
                allergens: ['glutine'],
            });
            expect(upd.status).toBe(200);
            expect(Number(upd.body.price)).toBe(16);

            const missing = await api().put('/dishes/99999999').set(bearer(token)).send({
                name: 'Fantasma',
                description: null,
                price: 1,
                category: 'PRIMI',
                allergens: null,
            });
            expect(missing.status).toBe(404);
        });
    });

    describe('sala: unioni e chiusure per turno', () => {
        let roomId: number;
        let tavolo1: number;
        let tavolo2: number;
        const DATA = '2027-04-10';

        beforeAll(async () => {
            const room = await api().post('/rooms').set(bearer(token)).send({
                name: 'Sala Test B33',
                width: 800,
                height: 600,
            });
            expect(room.status).toBe(201);
            roomId = room.body.id;

            for (const [name, setId] of [
                ['B33-1', (id: number) => { tavolo1 = id; }],
                ['B33-2', (id: number) => { tavolo2 = id; }],
            ] as const) {
                const table = await api().post('/tables').set(bearer(token)).send({
                    name,
                    shape: 'SQUARE',
                    seats: 4,
                    x: name === 'B33-1' ? 100 : 300,
                    y: 100,
                    room_id: roomId,
                    status: 'FREE',
                });
                expect(table.status).toBe(201);
                setId(table.body.id);
            }
        });

        it('crea un\'unione per data+turno e la rilegge', async () => {
            const created = await api().post('/table-merges').set(bearer(token)).send({
                date: DATA,
                shift: 'DINNER',
                primary_id: tavolo1,
                merged_ids: [tavolo2],
            });
            expect(created.status).toBe(201);
            expect(created.body.primary_id).toBe(tavolo1);
            expect(created.body.merged_ids).toEqual([tavolo2]);

            const list = await api().get('/table-merges').set(bearer(token))
                .query({ date: DATA, shift: 'DINNER' });
            expect(list.status).toBe(200);
            const found = list.body.find((m: any) => m.primary_id === tavolo1);
            expect(found).toBeDefined();
            expect(found.merged_ids).toEqual([tavolo2]);

            const deleted = await api().delete('/table-merges').set(bearer(token)).send({
                date: DATA,
                shift: 'DINNER',
                primary_id: tavolo1,
            });
            expect(deleted.status).toBe(200);
        });

        it('rifiuta con 404 un\'unione con un tavolo inesistente (o di un altro tenant)', async () => {
            // Il vincolo è rimasto (date, shift, primary_id): senza il check di
            // appartenenza un primary_id altrui farebbe DO UPDATE su una riga
            // di un altro ristorante.
            const res = await api().post('/table-merges').set(bearer(token)).send({
                date: DATA,
                shift: 'DINNER',
                primary_id: 99999999,
                merged_ids: [tavolo2],
            });
            expect(res.status).toBe(404);
        });

        it('chiude e riapre la sala per un turno', async () => {
            const closed = await api().post('/room-closed').set(bearer(token)).send({
                date: DATA,
                shift: 'LUNCH',
                room_id: roomId,
            });
            expect(closed.status).toBe(201);
            expect(closed.body.room_id).toBe(roomId);

            const list = await api().get('/room-closed').set(bearer(token))
                .query({ date: DATA, shift: 'LUNCH' });
            expect(list.status).toBe(200);
            expect(list.body.some((r: any) => r.room_id === roomId)).toBe(true);

            const reopened = await api().delete('/room-closed').set(bearer(token)).send({
                date: DATA,
                shift: 'LUNCH',
                room_id: roomId,
            });
            expect(reopened.status).toBe(200);

            const dopo = await api().get('/room-closed').set(bearer(token))
                .query({ date: DATA, shift: 'LUNCH' });
            expect(dopo.body.some((r: any) => r.room_id === roomId)).toBe(false);
        });

        it('rifiuta con 404 la chiusura di una sala inesistente (o di un altro tenant)', async () => {
            const res = await api().post('/room-closed').set(bearer(token)).send({
                date: DATA,
                shift: 'LUNCH',
                room_id: 99999999,
            });
            expect(res.status).toBe(404);
        });
    });

    describe('cucina: stampanti, partite e mappa categorie', () => {
        let stationId: number;
        let stationBisId: number;

        it('registra una termica e una partita che la usa', async () => {
            const printer = await api().post('/sala/printers').set(bearer(token)).send({
                name: 'termica-b33',
                host: '192.168.77.60',
                port: 9100,
                kind: 'THERMAL',
            });
            expect(printer.status).toBe(201);
            expect(printer.body.name).toBe('termica-b33');

            const station = await api().post('/sala/stations').set(bearer(token)).send({
                name: 'Grill B33',
                color: '#aa2200',
                printer: 'termica-b33',
            });
            expect(station.status).toBe(201);
            stationId = station.body.id;
            expect(station.body.printer).toBe('termica-b33');

            const bis = await api().post('/sala/stations').set(bearer(token)).send({
                name: 'Friggitrice B33',
                color: '#0022aa',
            });
            expect(bis.status).toBe(201);
            stationBisId = bis.body.id;

            const config = await api().get('/sala/config').set(bearer(token));
            expect(config.status).toBe(200);
            expect(config.body.printers.some((p: any) => p.name === 'termica-b33')).toBe(true);
            expect(config.body.stations.some((s: any) => s.id === stationId && s.printer === 'termica-b33')).toBe(true);
        });

        it('mappa una categoria e la rimappa senza duplicare (PK tenant_id+category)', async () => {
            const prima = await api().put('/sala/category-stations').set(bearer(token)).send({
                category: 'PRIMI',
                station_id: stationId,
            });
            expect(prima.status).toBe(200);

            // Il secondo PUT centra il DO UPDATE del nuovo conflict target
            // (tenant_id, category): col vecchio target la query fallirebbe.
            const seconda = await api().put('/sala/category-stations').set(bearer(token)).send({
                category: 'PRIMI',
                station_id: stationBisId,
            });
            expect(seconda.status).toBe(200);

            const config = await api().get('/sala/config').set(bearer(token));
            expect(config.body.category_stations['PRIMI']).toBe(stationBisId);
        });

        it('rifiuta con 404 una partita inesistente (o di un altro tenant) nella mappa', async () => {
            const res = await api().put('/sala/category-stations').set(bearer(token)).send({
                category: 'PRIMI',
                station_id: 99999999,
            });
            expect(res.status).toBe(404);
        });

        it('salva un profilo sala e lo riattiva (upsert sui vincoli per tenant)', async () => {
            const profile = await api().post('/sala/profiles').set(bearer(token)).send({
                name: 'Assetto B33',
            });
            expect(profile.status).toBe(201);

            // L'attivazione ri-upserta stampanti, partite e mappa categorie:
            // esercita in un colpo solo ON CONFLICT (tenant_id, name),
            // (tenant_id, lower(name)) e (tenant_id, category).
            const activated = await api().post(`/sala/profiles/${profile.body.id}/activate`).set(bearer(token));
            expect(activated.status).toBe(200);
            expect(activated.body.active_profile).toBe('Assetto B33');

            const list = await api().get('/sala/profiles').set(bearer(token));
            expect(list.status).toBe(200);
            expect(list.body.active_profile).toBe('Assetto B33');
        });
    });

    describe('banchetti', () => {
        let dishId: number;
        let tableId: number;
        let banquetId: number;

        beforeAll(async () => {
            const dish = await api().post('/dishes').set(bearer(token)).send({
                name: 'Arrosto Banchetto B33',
                description: null,
                price: 22,
                category: 'SECONDI',
                allergens: null,
            });
            expect(dish.status).toBe(201);
            dishId = dish.body.id;

            const room = await api().post('/rooms').set(bearer(token)).send({
                name: 'Sala Banchetti B33',
                width: 600,
                height: 400,
            });
            const table = await api().post('/tables').set(bearer(token)).send({
                name: 'B33-BQ',
                shape: 'RECTANGLE',
                seats: 12,
                x: 50,
                y: 50,
                room_id: room.body.id,
                status: 'FREE',
            });
            expect(table.status).toBe(201);
            tableId = table.body.id;
        });

        it('crea un banchetto con piatti e tavoli del tenant e registra un acconto', async () => {
            const created = await api().post('/banquet-menus').set(bearer(token)).send({
                name: 'Cresima B33',
                description: 'collaudo',
                price_per_person: 55,
                dish_ids: [dishId],
                event_date: '2027-05-02',
                shift: 'LUNCH',
                guests: 12,
                table_ids: [tableId],
            });
            expect(created.status).toBe(201);
            banquetId = created.body.id;
            expect(created.body.dish_ids).toEqual([dishId]);
            expect(created.body.table_ids).toEqual([tableId]);

            const payment = await api().post(`/banquet-menus/${banquetId}/payments`).set(bearer(token)).send({
                amount: 200,
                payment_date: '2027-04-01',
                payment_type: 'DEPOSIT',
                payment_method: 'TRANSFER',
            });
            expect(payment.status).toBe(201);

            const list = await api().get('/banquet-menus').set(bearer(token));
            expect(list.status).toBe(200);
            const found = list.body.find((b: any) => b.id === banquetId);
            expect(found).toBeDefined();
            expect(found.total_paid).toBe(200);
        });

        it('rifiuta con 404 piatti o tavoli fuori tenant', async () => {
            const badDish = await api().post('/banquet-menus').set(bearer(token)).send({
                name: 'Banchetto Fantasma',
                price_per_person: 40,
                dish_ids: [99999999],
                event_date: '2027-05-03',
                guests: 10,
            });
            expect(badDish.status).toBe(404);

            const badTable = await api().post('/banquet-menus').set(bearer(token)).send({
                name: 'Banchetto Fantasma 2',
                price_per_person: 40,
                dish_ids: [dishId],
                event_date: '2027-05-03',
                guests: 10,
                table_ids: [99999999],
            });
            expect(badTable.status).toBe(404);
        });
    });
});

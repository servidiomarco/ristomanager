import { describe, it, expect, beforeAll } from 'vitest';
import { api, bearer, ownerToken } from './helpers';

// Pronto automatico per partita: un centro che lavora solo di carta
// (stampante sì, monitor KDS no — gli Antipasti al Vecchio Frantoio) non ha
// nessuno che possa premere «pronto», e le sue righe bloccavano l'uscita per
// sempre. Col flag stations.auto_ready le righe nascono READY al lancio:
// l'uscita aspetta solo le partite col monitor. Il file gira dopo orders-*
// (ordine alfabetico, contratto della suite): i flag delle comande sono già
// accesi, ma qui vengono rimessi esplicitamente come nel file del ciclo.
describe('pronto automatico di partita (stations.auto_ready)', () => {
    let token: string;
    let salaId: number;
    let autoStationId: number;
    let monitorStationId: number;
    let piattoAuto: number;      // categoria instradata sulla partita auto_ready
    let piattoMonitor: number;   // categoria instradata sulla partita a monitor
    let nTavoli = 0;

    const nuovaComanda = async (): Promise<number> => {
        const table = await api().post('/tables').set(bearer(token)).send({
            name: `TA${++nTavoli}`, shape: 'SQUARE', seats: 4,
            x: 100 + nTavoli * 60, y: 500, room_id: salaId, status: 'FREE',
        });
        expect(table.status).toBe(201);
        const order = await api().post('/orders').set(bearer(token)).send({ table_id: table.body.id });
        expect(order.status).toBe(201);
        return order.body.order.id as number;
    };

    const righe = (body: any) =>
        body.items.filter((i: any) => i.line_kind === 'DISH' || i.dish_id != null);

    beforeAll(async () => {
        token = await ownerToken();

        const flags = await api().put('/settings/features').set(bearer(token)).send({
            table_orders_enabled: true,
            pay_at_table_enabled: true,
        });
        expect(flags.status).toBe(200);

        const room = await api().post('/rooms').set(bearer(token)).send({
            name: 'Sala Pronto Auto', width: 800, height: 600,
        });
        expect(room.status).toBe(201);
        salaId = room.body.id;

        const auto = await api().post('/sala/stations').set(bearer(token)).send({ name: 'Antipasti Auto Test' });
        expect(auto.status).toBe(201);
        autoStationId = auto.body.id;
        const monitor = await api().post('/sala/stations').set(bearer(token)).send({ name: 'Cucina Monitor Test' });
        expect(monitor.status).toBe(201);
        monitorStationId = monitor.body.id;

        for (const [category, stationId] of [
            ['ANTIPASTI AUTO TEST', autoStationId],
            ['SECONDI MONITOR TEST', monitorStationId],
        ] as const) {
            const map = await api().put('/sala/category-stations').set(bearer(token)).send({ category, station_id: stationId });
            expect(map.status).toBe(200);
        }
        for (const [name, category, setId] of [
            ['Tagliere Auto', 'ANTIPASTI AUTO TEST', (id: number) => { piattoAuto = id; }],
            ['Brasato Monitor', 'SECONDI MONITOR TEST', (id: number) => { piattoMonitor = id; }],
        ] as const) {
            const dish = await api().post('/dishes').set(bearer(token)).send({
                name, description: null, price: 14, category, allergens: null,
            });
            expect(dish.status).toBe(201);
            setId(dish.body.id);
        }
    });

    it('il flag si accende dalla PUT della partita e compare in /sala/config', async () => {
        const off = await api().get('/sala/config').set(bearer(token));
        expect(off.status).toBe(200);
        expect(off.body.stations.find((s: any) => s.id === autoStationId).auto_ready).toBe(false);

        const upd = await api().put(`/sala/stations/${autoStationId}`).set(bearer(token)).send({ auto_ready: true });
        expect(upd.status).toBe(200);
        expect(upd.body.auto_ready).toBe(true);

        const on = await api().get('/sala/config').set(bearer(token));
        expect(on.body.stations.find((s: any) => s.id === autoStationId).auto_ready).toBe(true);
        expect(on.body.stations.find((s: any) => s.id === monitorStationId).auto_ready).toBe(false);
    });

    it('al lancio le righe della partita auto nascono READY e l\'uscita aspetta solo il monitor', async () => {
        expect((await api().put('/sala/fire-mode').set(bearer(token)).send({ mode: 'AUTO_ALL' })).status).toBe(200);

        const orderId = await nuovaComanda();
        const add = await api().post(`/orders/${orderId}/items`).set(bearer(token)).send({
            items: [
                { dish_id: piattoAuto, qty: 1, course_no: 1 },
                { dish_id: piattoMonitor, qty: 1, course_no: 1 },
            ],
        });
        expect(add.status).toBe(201);
        const sent = await api().post(`/orders/${orderId}/send`).set(bearer(token)).send({});
        expect(sent.status).toBe(200);
        expect(sent.body.fired_courses).toContain(1);

        const view = await api().get(`/orders/${orderId}`).set(bearer(token));
        const rigaAuto = righe(view.body).find((i: any) => i.station_id === autoStationId);
        const rigaMonitor = righe(view.body).find((i: any) => i.station_id === monitorStationId);
        expect(rigaAuto.status).toBe('READY');
        expect(rigaAuto.ready_at).toBeTruthy();
        expect(rigaMonitor.status).toBe('SENT');

        // L'uscita non è pronta finché il monitor non finisce: quando la
        // riga a schermo passa READY, l'uscita è completa — la partita auto
        // non è mai fra quelle in attesa.
        const pronta = await api().post(`/kds/items/${rigaMonitor.id}/status`).set(bearer(token)).send({ status: 'READY' });
        expect(pronta.status).toBe(200);
        expect(pronta.body.course_ready).toBe(true);
        expect(pronta.body.waiting_station_ids).toEqual([]);
    });

    it('un\'uscita fatta solo di righe auto è pronta al lancio e si serve subito', async () => {
        const orderId = await nuovaComanda();
        await api().post(`/orders/${orderId}/items`).set(bearer(token)).send({
            items: [{ dish_id: piattoAuto, qty: 2, course_no: 1 }],
        });
        const sent = await api().post(`/orders/${orderId}/send`).set(bearer(token)).send({});
        expect(sent.status).toBe(200);
        expect(righe(sent.body).every((i: any) => i.status === 'READY')).toBe(true);

        const servita = await api().post(`/orders/${orderId}/courses/1/serve`).set(bearer(token)).send({});
        expect(servita.status).toBe(200);
        const dopo = await api().get(`/orders/${orderId}`).set(bearer(token));
        expect(righe(dopo.body).every((i: any) => i.status === 'SERVED')).toBe(true);
    });

    it('l\'annullo della chiamata riavvolge anche il READY automatico', async () => {
        const orderId = await nuovaComanda();
        await api().post(`/orders/${orderId}/items`).set(bearer(token)).send({
            items: [
                { dish_id: piattoAuto, qty: 1, course_no: 1 },
                { dish_id: piattoMonitor, qty: 1, course_no: 1 },
            ],
        });
        await api().post(`/orders/${orderId}/send`).set(bearer(token)).send({});

        // Il READY della partita auto non è lavoro di un cuoco: non blocca
        // l'unfire, e torna in coda insieme alla riga SENT del monitor.
        const un = await api().post(`/orders/${orderId}/courses/1/unfire`).set(bearer(token)).send({});
        expect(un.status).toBe(200);
        const dopo = await api().get(`/orders/${orderId}`).set(bearer(token));
        for (const i of righe(dopo.body)) {
            expect(i.status).toBe('QUEUED');
            expect(i.ready_at).toBeNull();
            expect(i.fired_at).toBeNull();
        }

        // Se invece il MONITOR ha iniziato, l'annullo rifiuta come sempre.
        await api().post(`/orders/${orderId}/courses/1/fire`).set(bearer(token)).send({});
        const view = await api().get(`/orders/${orderId}`).set(bearer(token));
        const rigaMonitor = righe(view.body).find((i: any) => i.station_id === monitorStationId);
        await api().post(`/kds/items/${rigaMonitor.id}/status`).set(bearer(token)).send({ status: 'PREPARING' });
        const no = await api().post(`/orders/${orderId}/courses/1/unfire`).set(bearer(token)).send({});
        expect(no.status).toBe(409);
    });
});

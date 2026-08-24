import { describe, it, expect, beforeAll } from 'vitest';
import { api, bearer, ownerToken } from './helpers';

// Il ciclo di servizio visto dalla cucina: DRAFT → QUEUED (invio) → SENT
// (lancio, secondo course_fire_mode) → PREPARING → READY. È il percorso che,
// se si rompe alle 20:30 di sabato, è un disastro — e fin qui non aveva
// copertura. Il file gira DOPO orders-bills (ordine alfabetico dei file, che
// per questa suite è contratto): i feature flag delle comande sono già
// accesi, ma il fire mode qui viene impostato esplicitamente a ogni blocco.
describe('ciclo cucina (stati linee, fuoco, passe)', () => {
    let token: string;
    let salaId: number;
    let piatto1: number;
    let piatto2: number;
    let nTavoli = 0;

    // Un tavolo fresco per ogni comanda: riaprire un tavolo con una comanda
    // OPEN restituisce QUELLA (200), e i test si sporcherebbero a vicenda.
    const nuovaComanda = async (): Promise<number> => {
        const table = await api().post('/tables').set(bearer(token)).send({
            name: `TK${++nTavoli}`, shape: 'SQUARE', seats: 4,
            x: 100 + nTavoli * 60, y: 300, room_id: salaId, status: 'FREE',
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

        // Entrambi i flag, esplicitamente: la PUT non deve poter spegnere
        // pay_at_table di traverso per i file che girano dopo.
        const flags = await api().put('/settings/features').set(bearer(token)).send({
            table_orders_enabled: true,
            pay_at_table_enabled: true,
        });
        expect(flags.status).toBe(200);

        const room = await api().post('/rooms').set(bearer(token)).send({
            name: 'Sala Test Cucina', width: 800, height: 600,
        });
        expect(room.status).toBe(201);
        salaId = room.body.id;
        for (const [name, setId] of [
            ['Tagliata Collaudo', (id: number) => { piatto1 = id; }],
            ['Orata Collaudo', (id: number) => { piatto2 = id; }],
        ] as const) {
            const dish = await api().post('/dishes').set(bearer(token)).send({
                name, description: null, price: 18, category: 'SECONDI', allergens: null,
            });
            expect(dish.status).toBe(201);
            setId(dish.body.id);
        }
    });

    it('con lancio manuale l\'invio propone al passe, il passe lancia, e un secondo lancio fa 409', async () => {
        const mode = await api().put('/sala/fire-mode').set(bearer(token)).send({ mode: 'MANUAL' });
        expect(mode.status).toBe(200);

        const orderId = await nuovaComanda();
        const add = await api().post(`/orders/${orderId}/items`).set(bearer(token)).send({
            items: [
                { dish_id: piatto1, qty: 1, course_no: 1 },
                { dish_id: piatto2, qty: 1, course_no: 1 },
            ],
        });
        expect(add.status).toBe(201);
        expect(righe(add.body).every((i: any) => i.status === 'DRAFT')).toBe(true);

        // La sala propone: le righe passano in QUEUED, niente parte da solo.
        const sent = await api().post(`/orders/${orderId}/send`).set(bearer(token)).send({});
        expect(sent.status).toBe(200);
        expect(sent.body.fire_mode).toBe('MANUAL');
        expect(sent.body.fired_courses).toEqual([]);
        expect(sent.body.queued_courses).toContain(1);
        expect(righe(sent.body).every((i: any) => i.status === 'QUEUED')).toBe(true);

        // Il passe lancia: QUEUED → SENT, con il timestamp del lancio.
        const fired = await api().post(`/orders/${orderId}/courses/1/fire`).set(bearer(token)).send({});
        expect(fired.status).toBe(200);

        const view = await api().get(`/orders/${orderId}`).set(bearer(token));
        expect(view.status).toBe(200);
        for (const i of righe(view.body)) {
            expect(i.status).toBe('SENT');
            expect(i.fired_at).toBeTruthy();
        }

        // Rilanciare un'uscita già partita non è ammesso.
        const doppio = await api().post(`/orders/${orderId}/courses/1/fire`).set(bearer(token)).send({});
        expect(doppio.status).toBe(409);
    });

    it('la riga percorre SENT → PREPARING → READY e l\'uscita è pronta solo quando lo sono tutte', async () => {
        const orderId = await nuovaComanda();
        const add = await api().post(`/orders/${orderId}/items`).set(bearer(token)).send({
            items: [
                { dish_id: piatto1, qty: 1, course_no: 1 },
                { dish_id: piatto2, qty: 1, course_no: 1 },
            ],
        });
        expect(add.status).toBe(201);
        await api().post(`/orders/${orderId}/send`).set(bearer(token)).send({});
        await api().post(`/orders/${orderId}/courses/1/fire`).set(bearer(token)).send({});

        const view = await api().get(`/orders/${orderId}`).set(bearer(token));
        const [rigaA, rigaB] = righe(view.body);

        // Prima riga: il percorso completo, con l'uscita ancora incompleta.
        const prep = await api().post(`/kds/items/${rigaA.id}/status`).set(bearer(token)).send({ status: 'PREPARING' });
        expect(prep.status).toBe(200);
        expect(prep.body.item.status).toBe('PREPARING');
        expect(prep.body.item.started_at).toBeTruthy();
        expect(prep.body.course_ready).toBe(false);

        const pronta = await api().post(`/kds/items/${rigaA.id}/status`).set(bearer(token)).send({ status: 'READY' });
        expect(pronta.status).toBe(200);
        expect(pronta.body.item.ready_at).toBeTruthy();
        expect(pronta.body.course_ready).toBe(false);

        // Seconda riga: il salto SENT → READY è ammesso (piatti veloci) e
        // completa l'uscita.
        const salto = await api().post(`/kds/items/${rigaB.id}/status`).set(bearer(token)).send({ status: 'READY' });
        expect(salto.status).toBe(200);
        expect(salto.body.course_ready).toBe(true);
        expect(salto.body.waiting_station_ids).toEqual([]);
    });

    it('le transizioni fuori percorso sono rifiutate', async () => {
        const orderId = await nuovaComanda();
        const add = await api().post(`/orders/${orderId}/items`).set(bearer(token)).send({
            items: [{ dish_id: piatto1, qty: 1, course_no: 1 }],
        });
        const riga = righe(add.body)[0];

        // In DRAFT la cucina non la vede: niente transizioni.
        const daBozza = await api().post(`/kds/items/${riga.id}/status`).set(bearer(token)).send({ status: 'PREPARING' });
        expect(daBozza.status).toBe(409);

        // Uno stato fuori dal vocabolario fa 400.
        const invalido = await api().post(`/kds/items/${riga.id}/status`).set(bearer(token)).send({ status: 'SERVED' });
        expect(invalido.status).toBe(400);

        // Tornare indietro da READY non si può.
        await api().post(`/orders/${orderId}/send`).set(bearer(token)).send({});
        await api().post(`/orders/${orderId}/courses/1/fire`).set(bearer(token)).send({});
        await api().post(`/kds/items/${riga.id}/status`).set(bearer(token)).send({ status: 'READY' });
        const indietro = await api().post(`/kds/items/${riga.id}/status`).set(bearer(token)).send({ status: 'PREPARING' });
        expect(indietro.status).toBe(409);
        expect(indietro.body.status).toBe('READY');
    });

    it('recall: un\'uscita proposta ma non lanciata torna in bozza e si può rimandare', async () => {
        const orderId = await nuovaComanda();
        await api().post(`/orders/${orderId}/items`).set(bearer(token)).send({
            items: [{ dish_id: piatto2, qty: 2, course_no: 2 }],
        });
        const sent = await api().post(`/orders/${orderId}/send`).set(bearer(token)).send({ course_no: 2 });
        expect(sent.status).toBe(200);
        expect(sent.body.queued_courses).toContain(2);

        const recall = await api().post(`/orders/${orderId}/courses/2/recall`).set(bearer(token)).send({});
        expect(recall.status).toBe(200);
        const dopo = await api().get(`/orders/${orderId}`).set(bearer(token));
        expect(righe(dopo.body).every((i: any) => i.status === 'DRAFT')).toBe(true);

        // Richiamata, si può correggere e rimandare.
        const di_nuovo = await api().post(`/orders/${orderId}/send`).set(bearer(token)).send({ course_no: 2 });
        expect(di_nuovo.status).toBe(200);
        expect(di_nuovo.body.queued_courses).toContain(2);
    });

    it('in AUTO_ALL l\'invio lancia da solo tutte le uscite proposte', async () => {
        const mode = await api().put('/sala/fire-mode').set(bearer(token)).send({ mode: 'AUTO_ALL' });
        expect(mode.status).toBe(200);

        const orderId = await nuovaComanda();
        await api().post(`/orders/${orderId}/items`).set(bearer(token)).send({
            items: [
                { dish_id: piatto1, qty: 1, course_no: 1 },
                { dish_id: piatto2, qty: 1, course_no: 2 },
            ],
        });
        const sent = await api().post(`/orders/${orderId}/send`).set(bearer(token)).send({});
        expect(sent.status).toBe(200);
        expect(sent.body.fire_mode).toBe('AUTO_ALL');
        expect(sent.body.fired_courses).toEqual(expect.arrayContaining([1, 2]));
        expect(sent.body.queued_courses).toEqual([]);
        expect(righe(sent.body).every((i: any) => i.status === 'SENT')).toBe(true);
    });

    it('in AUTO_FIRST parte da sola solo la prima uscita, la seconda aspetta il passe', async () => {
        const mode = await api().put('/sala/fire-mode').set(bearer(token)).send({ mode: 'AUTO_FIRST' });
        expect(mode.status).toBe(200);

        const orderId = await nuovaComanda();
        await api().post(`/orders/${orderId}/items`).set(bearer(token)).send({
            items: [
                { dish_id: piatto1, qty: 1, course_no: 1 },
                { dish_id: piatto2, qty: 1, course_no: 2 },
            ],
        });
        const sent = await api().post(`/orders/${orderId}/send`).set(bearer(token)).send({});
        expect(sent.status).toBe(200);
        expect(sent.body.fired_courses).toEqual([1]);
        expect(sent.body.queued_courses).toEqual([2]);

        // Il default della suite resta AUTO_ALL per i file successivi.
        const ripristino = await api().put('/sala/fire-mode').set(bearer(token)).send({ mode: 'AUTO_ALL' });
        expect(ripristino.status).toBe(200);
    });
});

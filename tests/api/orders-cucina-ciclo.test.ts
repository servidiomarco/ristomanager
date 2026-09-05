import { describe, it, expect, beforeAll } from 'vitest';
import { Client } from 'pg';
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

        // Tornare indietro da READY è l'annulla della spunta: torna in
        // PREPARING e il ready_at si azzera, perché quel pronto non è mai
        // esistito. Poi si può rispuntare.
        await api().post(`/orders/${orderId}/send`).set(bearer(token)).send({});
        await api().post(`/orders/${orderId}/courses/1/fire`).set(bearer(token)).send({});
        await api().post(`/kds/items/${riga.id}/status`).set(bearer(token)).send({ status: 'READY' });
        const annulla = await api().post(`/kds/items/${riga.id}/status`).set(bearer(token)).send({ status: 'PREPARING' });
        expect(annulla.status).toBe(200);
        expect(annulla.body.item.status).toBe('PREPARING');
        expect(annulla.body.item.ready_at).toBeNull();
        expect(annulla.body.course_ready).toBe(false);
        const rispunta = await api().post(`/kds/items/${riga.id}/status`).set(bearer(token)).send({ status: 'READY' });
        expect(rispunta.status).toBe(200);
        expect(rispunta.body.item.ready_at).toBeTruthy();
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

    it('servita: chiude solo un\'uscita tutta pronta, e una sola volta', async () => {
        const orderId = await nuovaComanda();
        await api().post(`/orders/${orderId}/items`).set(bearer(token)).send({
            items: [
                { dish_id: piatto1, qty: 1, course_no: 1 },
                { dish_id: piatto2, qty: 1, course_no: 1 },
            ],
        });
        // AUTO_ALL (ripristinato dal blocco precedente): l'invio lancia da solo.
        await api().post(`/orders/${orderId}/send`).set(bearer(token)).send({});
        const view = await api().get(`/orders/${orderId}`).set(bearer(token));
        const [rigaA, rigaB] = righe(view.body);

        // A metà non si serve: una riga pronta e una no fa 409.
        await api().post(`/kds/items/${rigaA.id}/status`).set(bearer(token)).send({ status: 'READY' });
        const meta = await api().post(`/orders/${orderId}/courses/1/serve`).set(bearer(token)).send({});
        expect(meta.status).toBe(409);

        // Tutta pronta: il servito chiude ogni riga con il suo timestamp.
        await api().post(`/kds/items/${rigaB.id}/status`).set(bearer(token)).send({ status: 'READY' });
        const servita = await api().post(`/orders/${orderId}/courses/1/serve`).set(bearer(token)).send({});
        expect(servita.status).toBe(200);
        for (const i of servita.body.items) {
            expect(i.status).toBe('SERVED');
            expect(i.served_at).toBeTruthy();
        }

        // Lo stato derivato dell'uscita diventa SERVED anche nella vista comanda.
        const dopo = await api().get(`/orders/${orderId}`).set(bearer(token));
        const uscita = dopo.body.courses.find((c: any) => c.course_no === 1);
        expect(uscita.status).toBe('SERVED');

        // Servire due volte non è ammesso, e una riga servita non si
        // annulla più: il piatto è al tavolo.
        const doppio = await api().post(`/orders/${orderId}/courses/1/serve`).set(bearer(token)).send({});
        expect(doppio.status).toBe(409);
        const riapri = await api().post(`/kds/items/${rigaA.id}/status`).set(bearer(token)).send({ status: 'PREPARING' });
        expect(riapri.status).toBe(409);
    });

    it('in AUTO_NEXT la prima uscita parte all\'invio e la successiva al servito della precedente', async () => {
        const mode = await api().put('/sala/fire-mode').set(bearer(token)).send({ mode: 'AUTO_NEXT' });
        expect(mode.status).toBe(200);

        const orderId = await nuovaComanda();
        await api().post(`/orders/${orderId}/items`).set(bearer(token)).send({
            items: [
                { dish_id: piatto1, qty: 1, course_no: 1 },
                { dish_id: piatto2, qty: 1, course_no: 2 },
            ],
        });
        // All'invio parte solo la prima (il tavolo non ha niente in cucina).
        const sent = await api().post(`/orders/${orderId}/send`).set(bearer(token)).send({});
        expect(sent.status).toBe(200);
        expect(sent.body.fire_mode).toBe('AUTO_NEXT');
        expect(sent.body.fired_courses).toEqual([1]);
        expect(sent.body.queued_courses).toEqual([2]);

        // Servita la prima, la seconda parte da sola nella stessa mossa.
        const view = await api().get(`/orders/${orderId}`).set(bearer(token));
        const rigaPrima = righe(view.body).find((i: any) => i.course_no === 1);
        await api().post(`/kds/items/${rigaPrima.id}/status`).set(bearer(token)).send({ status: 'READY' });
        const servita = await api().post(`/orders/${orderId}/courses/1/serve`).set(bearer(token)).send({});
        expect(servita.status).toBe(200);
        expect(servita.body.next_fired_course).toBe(2);

        const dopo = await api().get(`/orders/${orderId}`).set(bearer(token));
        const rigaSeconda = righe(dopo.body).find((i: any) => i.course_no === 2);
        expect(rigaSeconda.status).toBe('SENT');
        expect(rigaSeconda.fired_at).toBeTruthy();

        // Il default della suite resta AUTO_ALL per i file successivi.
        const ripristino = await api().put('/sala/fire-mode').set(bearer(token)).send({ mode: 'AUTO_ALL' });
        expect(ripristino.status).toBe(200);
    });

    it('riporta: un\'uscita servita per errore torna pronta al passe, e si può riservire', async () => {
        const orderId = await nuovaComanda();
        await api().post(`/orders/${orderId}/items`).set(bearer(token)).send({
            items: [{ dish_id: piatto1, qty: 1, course_no: 1 }],
        });
        // AUTO_ALL: l'invio lancia da solo.
        await api().post(`/orders/${orderId}/send`).set(bearer(token)).send({});
        const view = await api().get(`/orders/${orderId}`).set(bearer(token));
        const riga = righe(view.body)[0];
        await api().post(`/kds/items/${riga.id}/status`).set(bearer(token)).send({ status: 'READY' });
        await api().post(`/orders/${orderId}/courses/1/serve`).set(bearer(token)).send({});

        // Il passe la vede fra le servite recenti.
        const board = await api().get('/kds/expediter').set(bearer(token));
        expect(board.status).toBe(200);
        expect(board.body.servite.some((s: any) => s.order_id === orderId && s.course_no === 1)).toBe(true);

        // Riportata: le righe tornano READY, il served_at non è mai esistito.
        const riporta = await api().post(`/orders/${orderId}/courses/1/unserve`).set(bearer(token)).send({});
        expect(riporta.status).toBe(200);
        for (const i of riporta.body.items) {
            expect(i.status).toBe('READY');
            expect(i.served_at).toBeNull();
        }

        // Riportare due volte non ha senso; riservire sì.
        const doppio = await api().post(`/orders/${orderId}/courses/1/unserve`).set(bearer(token)).send({});
        expect(doppio.status).toBe(409);
        const di_nuovo = await api().post(`/orders/${orderId}/courses/1/serve`).set(bearer(token)).send({});
        expect(di_nuovo.status).toBe(200);
    });

    it('vendita al peso: prezzo al kg, peso obbligatorio, correzione dalla cucina', async () => {
        const bistecca = await api().post('/dishes').set(bearer(token)).send({
            name: 'Bistecca Ciclo', description: null, price: 38, category: 'SECONDI', allergens: null,
            sold_by_weight: true, weight_min_grams: 200, weight_max_grams: 1500, weight_default_grams: 700,
        });
        expect(bistecca.status).toBe(201);
        expect(bistecca.body.sold_by_weight).toBe(true);
        // Range e punto di partenza: guida della battuta, salvati in scheda.
        expect(bistecca.body.weight_min_grams).toBe(200);
        expect(bistecca.body.weight_max_grams).toBe(1500);
        expect(bistecca.body.weight_default_grams).toBe(700);

        const orderId = await nuovaComanda();
        // Senza peso il server rifiuta; al peso è una riga per pezzo (qty 1).
        expect((await api().post(`/orders/${orderId}/items`).set(bearer(token)).send({
            items: [{ dish_id: bistecca.body.id, qty: 1, course_no: 1 }],
        })).status).toBe(400);
        expect((await api().post(`/orders/${orderId}/items`).set(bearer(token)).send({
            items: [{ dish_id: bistecca.body.id, qty: 2, course_no: 1, weight_grams: 550 }],
        })).status).toBe(400);

        // 550 g a 38 €/kg = 20,90 €, cotto nella riga: conto e KDS non
        // sanno nulla della regola.
        const add = await api().post(`/orders/${orderId}/items`).set(bearer(token)).send({
            items: [
                { dish_id: bistecca.body.id, qty: 1, course_no: 1, weight_grams: 550 },
                { dish_id: piatto1, qty: 1, course_no: 1 },
            ],
        });
        expect(add.status).toBe(201);
        const riga = righe(add.body).find((i: any) => i.name_snapshot === 'Bistecca Ciclo');
        expect(riga.weight_grams).toBe(550);
        expect(riga.unit_price_cents).toBe(2090);

        // La cucina pesa il taglio vero: 480 g, prezzo ricalcolato.
        const w = await api().post(`/orders/items/${riga.id}/weight`).set(bearer(token)).send({ weight_grams: 480 });
        expect(w.status).toBe(200);
        const dopo = righe(w.body).find((i: any) => i.id === riga.id);
        expect(dopo.weight_grams).toBe(480);
        expect(dopo.unit_price_cents).toBe(1824);

        // Su una riga normale la correzione non ha senso.
        const normale = righe(add.body).find((i: any) => i.name_snapshot !== 'Bistecca Ciclo');
        expect((await api().post(`/orders/items/${normale.id}/weight`).set(bearer(token)).send({ weight_grams: 480 })).status).toBe(400);
    });

    it('la chiamata di un\'uscita si annulla finché la cucina non inizia', async () => {
        await api().put('/sala/fire-mode').set(bearer(token)).send({ mode: 'AUTO_ALL' });
        const orderId = await nuovaComanda();
        await api().post(`/orders/${orderId}/items`).set(bearer(token)).send({
            items: [{ dish_id: piatto1, qty: 1, course_no: 1 }],
        });
        await api().post(`/orders/${orderId}/send`).set(bearer(token)).send({});

        // Lanciata (SENT): l'annullo la riporta in coda, come mai chiamata.
        const un = await api().post(`/orders/${orderId}/courses/1/unfire`).set(bearer(token)).send({});
        expect(un.status).toBe(200);
        for (const i of righe(un.body)) {
            expect(i.status).toBe('QUEUED');
            expect(i.fired_at).toBeNull();
        }

        // E si può richiamare: il fuoco riparte pulito.
        const re = await api().post(`/orders/${orderId}/courses/1/fire`).set(bearer(token)).send({});
        expect(re.status).toBe(200);

        // La cucina inizia: da qui in poi si storna, l'annullo rifiuta.
        const item = re.body.items[0];
        expect((await api().post(`/kds/items/${item.id}/status`).set(bearer(token)).send({ status: 'PREPARING' })).status).toBe(200);
        const no = await api().post(`/orders/${orderId}/courses/1/unfire`).set(bearer(token)).send({});
        expect(no.status).toBe(409);
    });

    it('la categoria aggancia la partita anche se il maiuscolo non coincide', async () => {
        // La cassa scrive le categorie come vuole ("Primi" e "PRIMI"
        // convivono nel catalogo): il piatto è in "Dolci Ciclo", la mappa
        // dice "DOLCI CICLO". L'aggancio non deve perdersi la riga —
        // successo in collaudo: inviata e invisibile a ogni monitor.
        const pasticceria = await api().post('/sala/stations').set(bearer(token)).send({ name: 'Pasticceria Ciclo' });
        expect(pasticceria.status).toBe(201);
        expect((await api().put('/sala/category-stations').set(bearer(token)).send({ category: 'DOLCI CICLO', station_id: pasticceria.body.id })).status).toBe(200);
        const tortino = await api().post('/dishes').set(bearer(token)).send({
            name: 'Tortino Ciclo', description: null, price: 6, category: 'Dolci Ciclo', allergens: null,
        });
        expect(tortino.status).toBe(201);

        await api().put('/sala/fire-mode').set(bearer(token)).send({ mode: 'AUTO_ALL' });
        const orderId = await nuovaComanda();
        await api().post(`/orders/${orderId}/items`).set(bearer(token)).send({
            items: [{ dish_id: tortino.body.id, qty: 1, course_no: 1 }],
        });
        await api().post(`/orders/${orderId}/send`).set(bearer(token)).send({});
        const queue = await api().get(`/kds/queue?station_id=${pasticceria.body.id}`).set(bearer(token));
        expect(queue.status).toBe(200);
        expect(queue.body.items.some((i: any) => i.order_id === orderId && i.name_snapshot === 'Tortino Ciclo')).toBe(true);

        // Risalvare la stessa categoria con un altro maiuscolo non crea un
        // doppione: resta una riga sola, l'ultima scritta.
        expect((await api().put('/sala/category-stations').set(bearer(token)).send({ category: 'Dolci Ciclo', station_id: pasticceria.body.id })).status).toBe(200);
        const cfg = await api().get('/sala/config').set(bearer(token));
        expect(cfg.status).toBe(200);
        const chiavi = Object.keys(cfg.body.category_stations).filter(k => k.toLowerCase() === 'dolci ciclo');
        expect(chiavi).toEqual(['Dolci Ciclo']);
    });

    it('il monitor di partita vede le altre partite dell\'uscita, e il servito finisce in Consegnate', async () => {
        // Due partite vere: SECONDI → Griglia, CONTORNI → Fritti. La comanda
        // ha un piatto per parte sulla stessa uscita.
        const griglia = await api().post('/sala/stations').set(bearer(token)).send({ name: 'Griglia Ciclo' });
        expect(griglia.status).toBe(201);
        const fritti = await api().post('/sala/stations').set(bearer(token)).send({ name: 'Fritti Ciclo' });
        expect(fritti.status).toBe(201);
        expect((await api().put('/sala/category-stations').set(bearer(token)).send({ category: 'SECONDI', station_id: griglia.body.id })).status).toBe(200);
        expect((await api().put('/sala/category-stations').set(bearer(token)).send({ category: 'CONTORNI', station_id: fritti.body.id })).status).toBe(200);
        const patate = await api().post('/dishes').set(bearer(token)).send({
            name: 'Patate Ciclo', description: null, price: 5, category: 'CONTORNI', allergens: null,
        });
        expect(patate.status).toBe(201);

        await api().put('/sala/fire-mode').set(bearer(token)).send({ mode: 'AUTO_ALL' });
        const orderId = await nuovaComanda();
        await api().post(`/orders/${orderId}/items`).set(bearer(token)).send({
            items: [
                { dish_id: piatto1, qty: 1, course_no: 1 },
                { dish_id: patate.body.id, qty: 2, course_no: 1 },
            ],
        });
        await api().post(`/orders/${orderId}/send`).set(bearer(token)).send({});

        // La coda della Griglia porta SOLO la sua riga, ma sa dei fritti.
        const queue = await api().get(`/kds/queue?station_id=${griglia.body.id}`).set(bearer(token));
        expect(queue.status).toBe(200);
        const mine = queue.body.items.filter((i: any) => i.order_id === orderId);
        expect(mine.length).toBe(1);
        expect(mine[0].name_snapshot).toBe('Tagliata Collaudo');
        const other = (queue.body.others ?? []).filter((o: any) => o.order_id === orderId);
        expect(other.length).toBe(1);
        expect(other[0].station_id).toBe(fritti.body.id);
        expect(other[0].name_snapshot).toBe('Patate Ciclo');
        expect(other[0].qty).toBe(2);
        expect(other[0].status).toBe('SENT');
        // La comanda INTERA per la card a binario: tutte le uscite, con la
        // partita su ogni riga — anche quelle che qui non si lavorano.
        const fullRows = (queue.body.full ?? []).filter((f: any) => f.order_id === orderId);
        expect(fullRows.some((f: any) => f.name_snapshot === 'Patate Ciclo' && f.station_id === fritti.body.id)).toBe(true);
        expect(fullRows.some((f: any) => f.name_snapshot === 'Tagliata Collaudo' && f.station_id === griglia.body.id)).toBe(true);

        // Tutta pronta e servita: l'uscita compare nelle Consegnate della
        // Griglia, con le SUE righe e il suo orario.
        const view = await api().get(`/orders/${orderId}`).set(bearer(token));
        for (const i of righe(view.body)) {
            await api().post(`/kds/items/${i.id}/status`).set(bearer(token)).send({ status: 'READY' });
        }
        const servita = await api().post(`/orders/${orderId}/courses/1/serve`).set(bearer(token)).send({});
        expect(servita.status).toBe(200);

        const served = await api().get(`/kds/served?station_id=${griglia.body.id}`).set(bearer(token));
        expect(served.status).toBe(200);
        const row = served.body.courses.find((c: any) => c.order_id === orderId);
        expect(row).toBeTruthy();
        expect(row.served_at).toBeTruthy();
        // La comanda servita si legge INTERA: le righe delle altre partite
        // arrivano anche loro, con la partita addosso — il monitor le
        // attenua invece di nasconderle.
        expect(row.items).toEqual(expect.arrayContaining([
            { name: 'Tagliata Collaudo', qty: 1, station_id: griglia.body.id },
            { name: 'Patate Ciclo', qty: 2, station_id: fritti.body.id },
        ]));
        expect(row.items).toHaveLength(2);
    });

    it("le righe aggiunte a un'uscita già lanciata partono subito, in qualunque fire mode", async () => {
        // AUTO_FIRST: la 2ª uscita NON parte da sola all'invio — è il caso
        // del T40 al collaudo, dove i primi aggiunti dopo il lancio
        // restavano QUEUED per sempre (senza passe nessuno li lanciava più).
        await api().put('/sala/fire-mode').set(bearer(token)).send({ mode: 'AUTO_FIRST' });
        const orderId = await nuovaComanda();
        await api().post(`/orders/${orderId}/items`).set(bearer(token)).send({
            items: [
                { dish_id: piatto1, qty: 1, course_no: 1 },
                { dish_id: piatto2, qty: 1, course_no: 2 },
            ],
        });
        const first = await api().post(`/orders/${orderId}/send`).set(bearer(token)).send({});
        expect(first.body.fired_courses).toEqual([1]);
        expect(first.body.queued_courses).toEqual([2]);

        // Il cameriere chiama la 2ª; poi il tavolo aggiunge un piatto.
        const fired = await api().post(`/orders/${orderId}/courses/2/fire`).set(bearer(token)).send({});
        expect(fired.status).toBe(200);
        await api().post(`/orders/${orderId}/items`).set(bearer(token)).send({
            items: [{ dish_id: piatto1, qty: 2, course_no: 2 }],
        });
        const second = await api().post(`/orders/${orderId}/send`).set(bearer(token)).send({});
        expect(second.status).toBe(200);
        // La chiamata dell'uscita è già avvenuta: la riga nuova parte subito
        // anche se il mode non lancerebbe la 2ª, e la cucina riceve la
        // revisione «aggiunto» sulla card già a video.
        expect(second.body.fired_courses).toContain(2);
        const rows = second.body.items.filter((i: any) => i.course_no === 2 && i.dish_id != null);
        expect(rows.every((i: any) => i.status === 'SENT')).toBe(true);
        // Ripristino il mode per i file successivi (contratto della suite).
        await api().put('/sala/fire-mode').set(bearer(token)).send({ mode: 'AUTO_ALL' });
    });

    it('una comanda intonsa si disfa; con righe battute il DELETE rifiuta', async () => {
        // Aperta toccando il tavolo e abbandonata: si disfa, il tavolo torna
        // com'era (niente «occupato», niente comanda appesa a fine servizio).
        const emptyId = await nuovaComanda();
        const gone = await api().delete(`/orders/${emptyId}`).set(bearer(token));
        expect(gone.status).toBe(200);
        const refetch = await api().get(`/orders/${emptyId}`).set(bearer(token));
        expect(refetch.status).toBe(404);

        // Con anche una sola riga battuta la guardia rifiuta: il disfare è
        // solo per le comande mai toccate.
        const usedId = await nuovaComanda();
        await api().post(`/orders/${usedId}/items`).set(bearer(token)).send({
            items: [{ dish_id: piatto1, qty: 1, course_no: 1 }],
        });
        const blocked = await api().delete(`/orders/${usedId}`).set(bearer(token));
        expect(blocked.status).toBe(409);
        const still = await api().get(`/orders/${usedId}`).set(bearer(token));
        expect(still.status).toBe(200);
    });

    it('varianti firmate: «++» addebita n volte, «-» sconta, snapshot col prefisso', async () => {
        // Le varianti nascono solo dall'import Passepartout: per il test si
        // seminano a DB, come farebbe l'import.
        const db = new Client({ connectionString: process.env.DATABASE_URL || 'postgresql://localhost/ristotest_api' });
        await db.connect();
        const g = await db.query(
            `INSERT INTO modifier_groups (tenant_id, name, min_select, max_select) VALUES (1, 'Aggiunte Ciclo', 0, 9) RETURNING id`);
        const m = await db.query(
            `INSERT INTO modifiers (tenant_id, group_id, name, price_delta_cents) VALUES (1, $1, 'Prosciutto Ciclo', 200) RETURNING id`,
            [g.rows[0].id]);
        await db.query(
            `INSERT INTO dish_modifier_groups (tenant_id, dish_id, group_id) VALUES (1, $1, $2)`,
            [piatto1, g.rows[0].id]);
        await db.end();
        const modId = m.rows[0].id;

        const orderId = await nuovaComanda();
        const add = await api().post(`/orders/${orderId}/items`).set(bearer(token)).send({
            items: [
                { dish_id: piatto1, qty: 1, course_no: 1, modifiers: [{ id: modId, n: 2 }] },
                { dish_id: piatto1, qty: 1, course_no: 1, modifiers: [{ id: modId, n: -1 }] },
            ],
        });
        expect(add.status).toBe(201);
        const rows = righe(add.body);
        // «++»: nome col prefisso, delta 2× in ADDEBITO, totale riga coerente.
        const plus = rows.find((r: any) => r.modifiers?.[0]?.n === 2);
        expect(plus.modifiers[0].name).toBe('++ Prosciutto Ciclo');
        expect(plus.modifiers[0].price_delta_cents).toBe(400);
        expect(plus.line_total_cents).toBe(1800 + 400);
        // «-»: rimozione in SCONTO (regola di Marco, come in Passepartout).
        const minus = rows.find((r: any) => r.modifiers?.[0]?.n === -1);
        expect(minus.modifiers[0].name).toBe('- Prosciutto Ciclo');
        expect(minus.modifiers[0].price_delta_cents).toBe(-200);
        expect(minus.line_total_cents).toBe(1800 - 200);

        // La variante resta legata al SUO piatto: su un altro → 400.
        const bad = await api().post(`/orders/${orderId}/items`).set(bearer(token)).send({
            items: [{ dish_id: piatto2, qty: 1, course_no: 1, modifiers: [{ id: modId, n: 1 }] }],
        });
        expect(bad.status).toBe(400);
    });
});

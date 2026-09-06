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

    it('cambiare il prezzo in scheda aggiorna il listino: la battuta usa il prezzo nuovo', async () => {
        // Il bug di produzione (6/09, filetto): il listino di default nasceva
        // dal backfill al boot e nessuno lo aggiornava più — la scheda diceva
        // 90 €/kg, la battuta addebitava il prezzo vecchio. Qui si ricrea la
        // storia: piatto al peso, riga di listino ferma al prezzo vecchio,
        // poi la modifica in scheda deve trascinare il listino con sé.
        const filetto = await api().post('/dishes').set(bearer(token)).send({
            name: 'Filetto Listino', description: null, price: 38, category: 'SECONDI', allergens: null,
            sold_by_weight: true, weight_min_grams: 150, weight_max_grams: 800, weight_default_grams: 150,
        });
        expect(filetto.status).toBe(201);

        // La creazione scrive il listino di default (prima non lo faceva:
        // ci pensava solo il backfill al riavvio successivo).
        const db = new Client({ connectionString: process.env.DATABASE_URL || 'postgresql://localhost/ristotest_api' });
        await db.connect();
        const creato = await db.query(
            `SELECT dp.price_cents FROM dish_prices dp
             JOIN menu_price_lists pl ON pl.id = dp.price_list_id
             WHERE dp.dish_id = $1 AND pl.is_default`, [filetto.body.id]);
        expect(creato.rows[0]?.price_cents).toBe(3800);
        await db.end();

        // La scheda passa a 90 €/kg: il listino deve seguire.
        const upd = await api().put(`/dishes/${filetto.body.id}`).set(bearer(token)).send({
            name: 'Filetto Listino', description: null, price: 90, category: 'SECONDI', allergens: null,
        });
        expect(upd.status).toBe(200);

        // 150 g × 90 €/kg = 13,50 € — il prezzo che palmare e cassa mostrano.
        const orderId = await nuovaComanda();
        const add = await api().post(`/orders/${orderId}/items`).set(bearer(token)).send({
            items: [{ dish_id: filetto.body.id, qty: 1, course_no: 1, weight_grams: 150 }],
        });
        expect(add.status).toBe(201);
        const riga = righe(add.body).find((i: any) => i.name_snapshot === 'Filetto Listino');
        expect(riga.unit_price_cents).toBe(1350);

        // E la pesata della cucina ricalcola sul prezzo nuovo, non sul vecchio.
        const w = await api().post(`/orders/items/${riga.id}/weight`).set(bearer(token)).send({ weight_grams: 200 });
        expect(w.status).toBe(200);
        expect(righe(w.body).find((i: any) => i.id === riga.id).unit_price_cents).toBe(1800);
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
            { name: 'Tagliata Collaudo', qty: 1, station_id: griglia.body.id, weight_grams: null },
            { name: 'Patate Ciclo', qty: 2, station_id: fritti.body.id, weight_grams: null },
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

    it('varianti firmate: scala d\'intensità a 4 gradini, parole nello snapshot', async () => {
        // Le varianti nascono solo dall'import Passepartout: per il test si
        // seminano a DB, come farebbe l'import. «Nduja» senza suffisso: il
        // genere di Molta/Poca segue l'ultima lettera del nome, e un «Nduja
        // Ciclo» diventerebbe maschile.
        const db = new Client({ connectionString: process.env.DATABASE_URL || 'postgresql://localhost/ristotest_api' });
        await db.connect();
        const g = await db.query(
            `INSERT INTO modifier_groups (tenant_id, name, min_select, max_select) VALUES (1, 'Aggiunte Ciclo', 0, 9) RETURNING id`);
        const m = await db.query(
            `INSERT INTO modifiers (tenant_id, group_id, name, price_delta_cents) VALUES (1, $1, 'Prosciutto Ciclo', 200) RETURNING id`,
            [g.rows[0].id]);
        const f = await db.query(
            `INSERT INTO modifiers (tenant_id, group_id, name, price_delta_cents) VALUES (1, $1, 'Nduja', 150) RETURNING id`,
            [g.rows[0].id]);
        // Gruppo a scelta singola: il nome resta nudo («+ Media» non
        // significa niente).
        const sg = await db.query(
            `INSERT INTO modifier_groups (tenant_id, name, min_select, max_select) VALUES (1, 'Cottura Ciclo', 0, 1) RETURNING id`);
        const sm = await db.query(
            `INSERT INTO modifiers (tenant_id, group_id, name, price_delta_cents) VALUES (1, $1, 'Media', 0) RETURNING id`,
            [sg.rows[0].id]);
        await db.query(
            `INSERT INTO dish_modifier_groups (tenant_id, dish_id, group_id) VALUES (1, $1, $2), (1, $1, $3)`,
            [piatto1, g.rows[0].id, sg.rows[0].id]);
        await db.end();
        const modId = m.rows[0].id;
        const ndujaId = f.rows[0].id;
        const mediaId = sm.rows[0].id;

        const orderId = await nuovaComanda();
        const add = await api().post(`/orders/${orderId}/items`).set(bearer(token)).send({
            items: [
                { dish_id: piatto1, qty: 1, course_no: 1, modifiers: [{ id: modId, n: 1 }] },
                { dish_id: piatto1, qty: 1, course_no: 1, modifiers: [{ id: modId, n: 2 }] },
                { dish_id: piatto1, qty: 1, course_no: 1, modifiers: [{ id: modId, n: -1 }] },
                { dish_id: piatto1, qty: 1, course_no: 1, modifiers: [{ id: modId, n: -2 }] },
                { dish_id: piatto1, qty: 1, course_no: 1, modifiers: [{ id: ndujaId, n: 2 }] },
                { dish_id: piatto1, qty: 1, course_no: 1, modifiers: [{ id: mediaId, n: 1 }] },
            ],
        });
        expect(add.status).toBe(201);
        const rows = righe(add.body);
        const byName = (name: string) => rows.find((r: any) => r.modifiers?.[0]?.name === name);
        // «+»: aggiunta a pagamento.
        const plus = byName('+ Prosciutto Ciclo');
        expect(plus.modifiers[0].price_delta_cents).toBe(200);
        expect(plus.line_total_cents).toBe(1800 + 200);
        // «Molta»: stesso addebito del + (abbondanza, non doppia porzione) —
        // e il genere segue il nome: Prosciutto → Molto.
        const molto = byName('Molto Prosciutto Ciclo');
        expect(molto.modifiers[0].n).toBe(2);
        expect(molto.modifiers[0].price_delta_cents).toBe(200);
        expect(molto.line_total_cents).toBe(1800 + 200);
        // «Senza»: rimozione in SCONTO (regola di Marco).
        const senza = byName('Senza Prosciutto Ciclo');
        expect(senza.modifiers[0].price_delta_cents).toBe(-200);
        expect(senza.line_total_cents).toBe(1800 - 200);
        // «Poca/Poco»: gratis — il piatto è intero, solo con meno.
        const poco = byName('Poco Prosciutto Ciclo');
        expect(poco.modifiers[0].price_delta_cents).toBe(0);
        expect(poco.line_total_cents).toBe(1800);
        // Genere femminile dall'ultima lettera: Nduja → Molta.
        const molta = byName('Molta Nduja');
        expect(molta.modifiers[0].price_delta_cents).toBe(150);
        expect(molta.line_total_cents).toBe(1800 + 150);
        // Gruppo a scelta singola: nome nudo, come le cotture di sempre.
        const media = byName('Media');
        expect(media.modifiers[0].n).toBe(1);

        // n fuori scala (bozze/snapshot di prima del cambio, «ripeti giro»):
        // clamp al gradino, non scarto — la variante non sparisce.
        const clampId = await nuovaComanda();
        const clamped = await api().post(`/orders/${clampId}/items`).set(bearer(token)).send({
            items: [
                { dish_id: piatto1, qty: 1, course_no: 1, modifiers: [{ id: modId, n: 5 }] },
                { dish_id: piatto1, qty: 1, course_no: 1, modifiers: [{ id: ndujaId, n: -5 }] },
            ],
        });
        expect(clamped.status).toBe(201);
        const crows = righe(clamped.body);
        const cMolto = crows.find((r: any) => r.modifiers?.[0]?.name === 'Molto Prosciutto Ciclo');
        expect(cMolto.modifiers[0].n).toBe(2);
        expect(cMolto.modifiers[0].price_delta_cents).toBe(200);
        const cPoca = crows.find((r: any) => r.modifiers?.[0]?.name === 'Poca Nduja');
        expect(cPoca.modifiers[0].n).toBe(-2);
        expect(cPoca.modifiers[0].price_delta_cents).toBe(0);

        // La variante resta legata al SUO piatto: su un altro → 400.
        const bad = await api().post(`/orders/${orderId}/items`).set(bearer(token)).send({
            items: [{ dish_id: piatto2, qty: 1, course_no: 1, modifiers: [{ id: modId, n: 1 }] }],
        });
        expect(bad.status).toBe(400);
    });

    it('uscita Bar: la spunta di categoria arriva al palmare, e il Bar parte subito nei lanci automatici', async () => {
        const BAR = 99; // BAR_COURSE_NO: l'uscita riservata alle bibite
        const drink = await api().post('/dishes').set(bearer(token)).send({
            name: 'Gin Tonic Collaudo', description: null, price: 8, category: 'Bar Collaudo', allergens: null,
        });
        expect(drink.status).toBe(201);

        // La spunta «bar» sulla categoria: esposta in /menu/categories e nel
        // catalogue (è da lì che il palmare decide l'instradamento).
        const on = await api().put('/menu/category-bar').set(bearer(token)).send({ category: 'Bar Collaudo', bar: true });
        expect(on.status).toBe(200);
        const cats = await api().get('/menu/categories').set(bearer(token));
        expect(cats.body.categories.find((c: any) => c.name === 'Bar Collaudo').bar).toBe(true);
        const catalogue = await api().get('/menu/catalogue').set(bearer(token));
        expect(catalogue.body.category_prefs['Bar Collaudo'].bar).toBe(true);
        const ghost = await api().put('/menu/category-bar').set(bearer(token)).send({ category: 'Categoria Fantasma', bar: true });
        expect(ghost.status).toBe(404);

        // AUTO_FIRST: parte la prima uscita E il Bar — le bibite non
        // aspettano il passe.
        await api().put('/sala/fire-mode').set(bearer(token)).send({ mode: 'AUTO_FIRST' });
        const primaId = await nuovaComanda();
        await api().post(`/orders/${primaId}/items`).set(bearer(token)).send({
            items: [
                { dish_id: piatto1, qty: 1, course_no: 1 },
                { dish_id: piatto2, qty: 1, course_no: 2 },
                { dish_id: drink.body.id, qty: 1, course_no: BAR },
            ],
        });
        const sent = await api().post(`/orders/${primaId}/send`).set(bearer(token)).send({});
        expect(sent.status).toBe(200);
        expect(sent.body.fired_courses).toEqual([1, BAR]);
        expect(sent.body.queued_courses).toEqual([2]);

        // AUTO_NEXT con roba già in cucina: un giro di bibite parte lo
        // stesso, un'uscita di cucina nuova resta al passe. Comanda fresca,
        // così il Bar non risulta «già lanciato» e la regola si vede nuda.
        await api().put('/sala/fire-mode').set(bearer(token)).send({ mode: 'AUTO_NEXT' });
        const secondaId = await nuovaComanda();
        await api().post(`/orders/${secondaId}/items`).set(bearer(token)).send({
            items: [{ dish_id: piatto1, qty: 1, course_no: 1 }],
        });
        const avvio = await api().post(`/orders/${secondaId}/send`).set(bearer(token)).send({});
        expect(avvio.body.fired_courses).toEqual([1]);
        const giro = await api().post(`/orders/${secondaId}/items`).set(bearer(token)).send({
            items: [
                { dish_id: piatto2, qty: 1, course_no: 2 },
                { dish_id: drink.body.id, qty: 1, course_no: BAR },
            ],
        });
        expect(giro.status).toBe(201);
        const sent2 = await api().post(`/orders/${secondaId}/send`).set(bearer(token)).send({});
        expect(sent2.status).toBe(200);
        expect(sent2.body.fired_courses).toEqual([BAR]);
        expect(sent2.body.queued_courses).toEqual([2]);

        // Il default della suite resta AUTO_ALL, e la spunta si toglie.
        await api().put('/sala/fire-mode').set(bearer(token)).send({ mode: 'AUTO_ALL' });
        const off = await api().put('/menu/category-bar').set(bearer(token)).send({ category: 'Bar Collaudo', bar: false });
        expect(off.status).toBe(200);
        const dopo = await api().get('/menu/categories').set(bearer(token));
        expect(dopo.body.categories.find((c: any) => c.name === 'Bar Collaudo').bar).toBe(false);
    });

    it('uscita Dolci: la spunta di categoria arriva al palmare, e i Dolci partono subito nei lanci automatici', async () => {
        const DOLCI = 98; // DESSERT_COURSE_NO: l'uscita in coda, senza chiamata
        const dolce = await api().post('/dishes').set(bearer(token)).send({
            name: 'Tiramisù Collaudo', description: null, price: 6, category: 'Dolci Collaudo', allergens: null,
        });
        expect(dolce.status).toBe(201);

        // La spunta «dolci» sulla categoria: esposta in /menu/categories e
        // nel catalogue, come la spunta «bar».
        const on = await api().put('/menu/category-dessert').set(bearer(token)).send({ category: 'Dolci Collaudo', dessert: true });
        expect(on.status).toBe(200);
        const cats = await api().get('/menu/categories').set(bearer(token));
        expect(cats.body.categories.find((c: any) => c.name === 'Dolci Collaudo').dessert).toBe(true);
        const catalogue = await api().get('/menu/catalogue').set(bearer(token));
        expect(catalogue.body.category_prefs['Dolci Collaudo'].dessert).toBe(true);
        const ghost = await api().put('/menu/category-dessert').set(bearer(token)).send({ category: 'Categoria Fantasma', dessert: true });
        expect(ghost.status).toBe(404);

        // AUTO_FIRST: parte la prima uscita E i Dolci — come il Bar, niente
        // chiamata dal passe.
        await api().put('/sala/fire-mode').set(bearer(token)).send({ mode: 'AUTO_FIRST' });
        const primaId = await nuovaComanda();
        await api().post(`/orders/${primaId}/items`).set(bearer(token)).send({
            items: [
                { dish_id: piatto1, qty: 1, course_no: 1 },
                { dish_id: piatto2, qty: 1, course_no: 2 },
                { dish_id: dolce.body.id, qty: 1, course_no: DOLCI },
            ],
        });
        const sent = await api().post(`/orders/${primaId}/send`).set(bearer(token)).send({});
        expect(sent.status).toBe(200);
        expect(sent.body.fired_courses).toEqual([1, DOLCI]);
        expect(sent.body.queued_courses).toEqual([2]);

        // AUTO_NEXT con roba già in cucina: il dolce ordinato a fine giro
        // parte lo stesso, un'uscita di cucina nuova resta al passe.
        await api().put('/sala/fire-mode').set(bearer(token)).send({ mode: 'AUTO_NEXT' });
        const secondaId = await nuovaComanda();
        await api().post(`/orders/${secondaId}/items`).set(bearer(token)).send({
            items: [{ dish_id: piatto1, qty: 1, course_no: 1 }],
        });
        const avvio = await api().post(`/orders/${secondaId}/send`).set(bearer(token)).send({});
        expect(avvio.body.fired_courses).toEqual([1]);
        const giro = await api().post(`/orders/${secondaId}/items`).set(bearer(token)).send({
            items: [
                { dish_id: piatto2, qty: 1, course_no: 2 },
                { dish_id: dolce.body.id, qty: 1, course_no: DOLCI },
            ],
        });
        expect(giro.status).toBe(201);
        const sent2 = await api().post(`/orders/${secondaId}/send`).set(bearer(token)).send({});
        expect(sent2.status).toBe(200);
        expect(sent2.body.fired_courses).toEqual([DOLCI]);
        expect(sent2.body.queued_courses).toEqual([2]);

        // Il default della suite resta AUTO_ALL, e la spunta si toglie.
        await api().put('/sala/fire-mode').set(bearer(token)).send({ mode: 'AUTO_ALL' });
        const off = await api().put('/menu/category-dessert').set(bearer(token)).send({ category: 'Dolci Collaudo', dessert: false });
        expect(off.status).toBe(200);
        const dopo = await api().get('/menu/categories').set(bearer(token));
        expect(dopo.body.categories.find((c: any) => c.name === 'Dolci Collaudo').dessert).toBe(false);
    });

    it('la carta segue i monitor: aggiunta col banner, storno e annullo chiamata stampati', async () => {
        const db = new Client({ connectionString: process.env.DATABASE_URL || 'postgresql://localhost/ristotest_api' });
        await db.connect();
        // Una partita CON stampante: senza printer i job non si accodano.
        const st = await db.query(
            `INSERT INTO stations (tenant_id, name, printer, sort_order) VALUES (1, 'Partita Stampa Test', 'termica-test', 90) RETURNING id`);
        const stationId = Number(st.rows[0].id);
        const dish = await api().post('/dishes').set(bearer(token)).send({
            name: 'Spritz Stampa Test', description: null, price: 6, category: 'Bar Collaudo',
            allergens: null, station_id: stationId,
        });
        expect(dish.status).toBe(201);
        const jobsOf = async (orderId: number) => (await db.query(
            `SELECT kind, payload FROM print_jobs WHERE (payload->>'order_id')::int = $1 ORDER BY id`,
            [orderId]
        )).rows;

        await api().put('/sala/fire-mode').set(bearer(token)).send({ mode: 'MANUAL' });
        const orderId = await nuovaComanda();
        await api().post(`/orders/${orderId}/items`).set(bearer(token)).send({
            items: [{ dish_id: dish.body.id, qty: 1, course_no: 1 }],
        });
        await api().post(`/orders/${orderId}/send`).set(bearer(token)).send({});
        const fired = await api().post(`/orders/${orderId}/courses/1/fire`).set(bearer(token)).send({});
        expect(fired.status).toBe(200);
        let jobs = await jobsOf(orderId);
        expect(jobs).toHaveLength(1);
        expect(jobs[0].kind).toBe('COMANDA');
        expect(jobs[0].payload.variation).toBeUndefined();

        // Righe aggiunte all'uscita già partita: partono subito e il ticket
        // porta il banner AGGIUNTA (kind COMANDA: sono piatti da fare).
        const add2 = await api().post(`/orders/${orderId}/items`).set(bearer(token)).send({
            items: [{ dish_id: dish.body.id, qty: 2, course_no: 1, note: 'senza ghiaccio' }],
        });
        expect(add2.status).toBe(201);
        await api().post(`/orders/${orderId}/send`).set(bearer(token)).send({});
        jobs = await jobsOf(orderId);
        expect(jobs).toHaveLength(2);
        expect(jobs[1].kind).toBe('COMANDA');
        expect(jobs[1].payload.variation).toBe('AGGIUNTA');
        expect(jobs[1].payload.items[0].qty).toBe(2);

        // Storno parziale di una riga già in cucina: kind dedicato (un agente
        // vecchio non deve stamparlo come piatti da fare), quantità stornata
        // e motivo sul ticket.
        const view = await api().get(`/orders/${orderId}`).set(bearer(token));
        const riga2 = righe(view.body).find((i: any) => i.qty === 2);
        const storno = await api().post(`/orders/items/${riga2.id}/void`).set(bearer(token))
            .send({ reason: 'Cliente ha cambiato idea', qty: 1 });
        expect(storno.status).toBe(200);
        jobs = await jobsOf(orderId);
        expect(jobs).toHaveLength(3);
        expect(jobs[2].kind).toBe('COMANDA_ANNULLO');
        expect(jobs[2].payload.variation).toBe('STORNO');
        expect(jobs[2].payload.items[0].qty).toBe(1);
        expect(jobs[2].payload.reason).toBe('Cliente ha cambiato idea');

        // Annullo chiamata: comanda fresca, lancio e riavvolgi — il ticket
        // di annullo esce dalla stessa termica del lancio.
        const secondaId = await nuovaComanda();
        await api().post(`/orders/${secondaId}/items`).set(bearer(token)).send({
            items: [{ dish_id: dish.body.id, qty: 1, course_no: 1 }],
        });
        await api().post(`/orders/${secondaId}/send`).set(bearer(token)).send({});
        await api().post(`/orders/${secondaId}/courses/1/fire`).set(bearer(token)).send({});
        const unfire = await api().post(`/orders/${secondaId}/courses/1/unfire`).set(bearer(token)).send({});
        expect(unfire.status).toBe(200);
        const jobs2 = await jobsOf(secondaId);
        expect(jobs2).toHaveLength(2);
        expect(jobs2[1].kind).toBe('COMANDA_ANNULLO');
        expect(jobs2[1].payload.variation).toBe('ANNULLO CHIAMATA');

        // Una riga MAI lanciata stornata non stampa niente: la cucina non
        // l'ha mai vista.
        const terzaId = await nuovaComanda();
        const addDraft = await api().post(`/orders/${terzaId}/items`).set(bearer(token)).send({
            items: [{ dish_id: dish.body.id, qty: 1, course_no: 1 }],
        });
        const draftRow = righe(addDraft.body)[0];
        const stornoDraft = await api().post(`/orders/items/${draftRow.id}/void`).set(bearer(token))
            .send({ reason: 'Battuto per errore' });
        expect(stornoDraft.status).toBe(200);
        expect(await jobsOf(terzaId)).toHaveLength(0);

        await api().put('/sala/fire-mode').set(bearer(token)).send({ mode: 'AUTO_ALL' });
        await db.end();
    });

    it('«uscita intera»: la comanda della partita col flag porta anche i piatti delle altre partite', async () => {
        const db = new Client({ connectionString: process.env.DATABASE_URL || 'postgresql://localhost/ristotest_api' });
        await db.connect();
        const stA = await db.query(
            `INSERT INTO stations (tenant_id, name, printer, sort_order) VALUES (1, 'Antipasti Intera Test', 'termica-test', 93) RETURNING id`);
        const stG = await db.query(
            `INSERT INTO stations (tenant_id, name, printer, sort_order) VALUES (1, 'Griglia Intera Test', 'termica-test', 94) RETURNING id`);
        const antipastiId = Number(stA.rows[0].id);
        const grigliaId = Number(stG.rows[0].id);

        // Il flag si accende dalla rotta delle partite e riappare in config.
        const flagOn = await api().put(`/sala/stations/${antipastiId}`).set(bearer(token)).send({ full_course: true });
        expect(flagOn.status).toBe(200);
        expect(flagOn.body.full_course).toBe(true);
        const cfg = await api().get('/sala/config').set(bearer(token));
        expect(cfg.body.stations.find((s: any) => s.id === antipastiId).full_course).toBe(true);
        expect(cfg.body.stations.find((s: any) => s.id === grigliaId).full_course).toBe(false);

        const anti = await api().post('/dishes').set(bearer(token)).send({
            name: 'Carpaccio Intera Test', description: null, price: 12, category: 'ANTIPASTI',
            allergens: null, station_id: antipastiId,
        });
        const grill = await api().post('/dishes').set(bearer(token)).send({
            name: 'Tagliata Intera Test', description: null, price: 22, category: 'SECONDI',
            allergens: null, station_id: grigliaId,
        });

        await api().put('/sala/fire-mode').set(bearer(token)).send({ mode: 'MANUAL' });
        const orderId = await nuovaComanda();
        await api().post(`/orders/${orderId}/items`).set(bearer(token)).send({
            items: [
                { dish_id: anti.body.id, qty: 1, course_no: 1 },
                { dish_id: grill.body.id, qty: 2, course_no: 1 },
            ],
        });
        await api().post(`/orders/${orderId}/send`).set(bearer(token)).send({});
        const fired = await api().post(`/orders/${orderId}/courses/1/fire`).set(bearer(token)).send({});
        expect(fired.status).toBe(200);

        const jobs = (await db.query(
            `SELECT payload FROM print_jobs WHERE (payload->>'order_id')::int = $1 ORDER BY id`,
            [orderId]
        )).rows;
        expect(jobs).toHaveLength(2);
        const antiJob = jobs.find(j => j.payload.station_name === 'Antipasti Intera Test');
        const grillJob = jobs.find(j => j.payload.station_name === 'Griglia Intera Test');
        // Il ticket della partita col flag: i suoi piatti come sempre, e in
        // coda le altre partite dell'uscita col loro nome.
        expect(antiJob.payload.items).toHaveLength(1);
        expect(antiJob.payload.others).toEqual([
            { station_name: 'Griglia Intera Test', items: [{ qty: 2, name: 'Tagliata Intera Test' }] },
        ]);
        // La partita senza flag stampa il ticket di sempre, senza coda.
        expect(grillJob.payload.others).toBeUndefined();

        await api().put('/sala/fire-mode').set(bearer(token)).send({ mode: 'AUTO_ALL' });
        await api().put(`/sala/stations/${antipastiId}`).set(bearer(token)).send({ full_course: false });
        await db.end();
    });

    it('il monitor di partita non vede l\'uscita Bar delle altre partite', async () => {
        const BAR = 99;
        const db = new Client({ connectionString: process.env.DATABASE_URL || 'postgresql://localhost/ristotest_api' });
        await db.connect();
        const stC = await db.query(
            `INSERT INTO stations (tenant_id, name, sort_order) VALUES (1, 'Cucina KDS Test', 91) RETURNING id`);
        const stB = await db.query(
            `INSERT INTO stations (tenant_id, name, sort_order) VALUES (1, 'Bar KDS Test', 92) RETURNING id`);
        const cucinaId = Number(stC.rows[0].id);
        const barId = Number(stB.rows[0].id);
        const food = await api().post('/dishes').set(bearer(token)).send({
            name: 'Crostino KDS Test', description: null, price: 7, category: 'SECONDI',
            allergens: null, station_id: cucinaId,
        });
        const drink = await api().post('/dishes').set(bearer(token)).send({
            name: 'Chinotto KDS Test', description: null, price: 3, category: 'Bar Collaudo',
            allergens: null, station_id: barId,
        });

        const orderId = await nuovaComanda();
        await api().post(`/orders/${orderId}/items`).set(bearer(token)).send({
            items: [
                { dish_id: food.body.id, qty: 1, course_no: 1 },
                { dish_id: drink.body.id, qty: 1, course_no: BAR },
            ],
        });
        // AUTO_ALL: l'invio lancia tutto, uscita Bar compresa.
        await api().post(`/orders/${orderId}/send`).set(bearer(token)).send({});

        // Il monitor di cucina: la sua riga sì, l'uscita Bar mai — né in coda
        // né nella card a binario della comanda intera.
        const cucina = await api().get(`/kds/queue?station_id=${cucinaId}`).set(bearer(token));
        expect(cucina.status).toBe(200);
        expect(cucina.body.items.some((i: any) => i.course_no === BAR)).toBe(false);
        const fullCucina = cucina.body.full.filter((r: any) => r.order_id === orderId);
        expect(fullCucina.some((r: any) => r.course_no === BAR)).toBe(false);
        expect(fullCucina.some((r: any) => r.course_no === 1)).toBe(true);

        // Il monitor del bar vede la sua uscita, e il resto della comanda
        // come contesto.
        const bar = await api().get(`/kds/queue?station_id=${barId}`).set(bearer(token));
        expect(bar.status).toBe(200);
        expect(bar.body.items.some((i: any) => i.course_no === BAR)).toBe(true);
        const fullBar = bar.body.full.filter((r: any) => r.order_id === orderId);
        expect(fullBar.some((r: any) => r.course_no === BAR)).toBe(true);
        await db.end();
    });
});

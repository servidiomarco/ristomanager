import { describe, it, expect, beforeAll } from 'vitest';
import { api, bearer, ownerToken } from './helpers';

// Revisioni comanda: quando una comanda già lanciata cambia (storno di una
// riga inviata, aggiunta sulla stessa uscita, riporta), la cucina deve poter
// vedere COSA è cambiato — GET /kds/revisions — e spegnere l'avviso con
// l'ack. Una modifica che la cucina non ha mai visto (riga DRAFT) non deve
// generare rumore.
describe('revisioni comanda', () => {
    let token: string;
    let salaId: number;
    let piatto1: number;
    let piatto2: number;
    let nTavoli = 0;

    const nuovaComanda = async (): Promise<number> => {
        const table = await api().post('/tables').set(bearer(token)).send({
            name: `TR${++nTavoli}`, shape: 'SQUARE', seats: 4,
            x: 500 + nTavoli * 60, y: 500, room_id: salaId, status: 'FREE',
        });
        expect(table.status).toBe(201);
        const order = await api().post('/orders').set(bearer(token)).send({ table_id: table.body.id });
        expect(order.status).toBe(201);
        return order.body.order.id as number;
    };

    const righe = (body: any) =>
        body.items.filter((i: any) => i.line_kind === 'DISH' || i.dish_id != null);

    const revisioniDi = async (orderId: number) => {
        const r = await api().get('/kds/revisions').set(bearer(token));
        expect(r.status).toBe(200);
        return r.body.revisions.filter((x: any) => x.order_id === orderId);
    };

    beforeAll(async () => {
        token = await ownerToken();
        const flags = await api().put('/settings/features').set(bearer(token)).send({
            table_orders_enabled: true,
            pay_at_table_enabled: true,
        });
        expect(flags.status).toBe(200);
        const mode = await api().put('/sala/fire-mode').set(bearer(token)).send({ mode: 'AUTO_ALL' });
        expect(mode.status).toBe(200);

        const room = await api().post('/rooms').set(bearer(token)).send({
            name: 'Sala Test Revisioni', width: 800, height: 600,
        });
        expect(room.status).toBe(201);
        salaId = room.body.id;
        for (const [name, setId] of [
            ['Branzino Revisioni', (id: number) => { piatto1 = id; }],
            ['Fritto Revisioni', (id: number) => { piatto2 = id; }],
        ] as const) {
            const dish = await api().post('/dishes').set(bearer(token)).send({
                name, description: null, price: 20, category: 'SECONDI', allergens: null,
            });
            expect(dish.status).toBe(201);
            setId(dish.body.id);
        }
    });

    it('lo storno di una riga già lanciata genera una revisione con la motivazione; su una DRAFT no', async () => {
        const orderId = await nuovaComanda();
        const add = await api().post(`/orders/${orderId}/items`).set(bearer(token)).send({
            items: [{ dish_id: piatto1, qty: 2, course_no: 1 }],
        });
        expect(add.status).toBe(201);
        await api().post(`/orders/${orderId}/send`).set(bearer(token)).send({});

        const sentItem = righe((await api().get(`/orders/${orderId}`).set(bearer(token))).body)
            .find((i: any) => i.status === 'SENT');
        const voided = await api().post(`/orders/items/${sentItem.id}/void`).set(bearer(token))
            .send({ reason: 'cliente ha cambiato idea' });
        expect(voided.status).toBe(200);

        const revs = await revisioniDi(orderId);
        expect(revs).toHaveLength(1);
        expect(revs[0].kind).toBe('void');
        expect(revs[0].course_no).toBe(1);
        expect(revs[0].summary).toContain('Branzino Revisioni');
        expect(revs[0].details[0].note).toBe('cliente ha cambiato idea');

        // Una riga mai inviata stornata non è mai esistita per la cucina.
        const orderId2 = await nuovaComanda();
        const add2 = await api().post(`/orders/${orderId2}/items`).set(bearer(token)).send({
            items: [{ dish_id: piatto2, qty: 1, course_no: 1 }],
        });
        const draft = righe(add2.body)[0];
        const voidDraft = await api().post(`/orders/items/${draft.id}/void`).set(bearer(token))
            .send({ reason: 'errore di battitura' });
        expect(voidDraft.status).toBe(200);
        expect(await revisioniDi(orderId2)).toHaveLength(0);
    });

    it('lo storno parziale divide la riga: quella viva scala, lo scarto resta a bilancio', async () => {
        const orderId = await nuovaComanda();
        const add = await api().post(`/orders/${orderId}/items`).set(bearer(token)).send({
            items: [{ dish_id: piatto1, qty: 3, course_no: 1 }],
        });
        expect(add.status).toBe(201);
        await api().post(`/orders/${orderId}/send`).set(bearer(token)).send({});

        const sentItem = righe((await api().get(`/orders/${orderId}`).set(bearer(token))).body)
            .find((i: any) => i.status === 'SENT');
        const voided = await api().post(`/orders/items/${sentItem.id}/void`).set(bearer(token))
            .send({ reason: 'piatto non riuscito', qty: 1 });
        expect(voided.status).toBe(200);

        // La riga originale resta viva (stesso id, stesso stato) con 2 pezzi;
        // lo storno è una riga VOIDED nuova da 1 pezzo.
        const rows = righe(voided.body);
        const alive = rows.find((i: any) => i.id === sentItem.id);
        expect(alive.status).toBe('SENT');
        expect(alive.qty).toBe(2);
        const scarto = rows.find((i: any) => i.status === 'VOIDED');
        expect(scarto.qty).toBe(1);
        expect(scarto.void_reason).toBe('piatto non riuscito');

        // La cucina viene avvisata del pezzo stornato, non della riga intera.
        const revs = await revisioniDi(orderId);
        expect(revs).toHaveLength(1);
        expect(revs[0].summary).toContain('1× Branzino Revisioni');

        // Una quantità pari (o oltre) alla riga è lo storno intero di sempre.
        const all = await api().post(`/orders/items/${sentItem.id}/void`).set(bearer(token))
            .send({ reason: 'cliente ha cambiato idea', qty: 99 });
        expect(all.status).toBe(200);
        const aliveAfter = righe(all.body).find((i: any) => i.id === sentItem.id);
        expect(aliveAfter.status).toBe('VOIDED');
        expect(aliveAfter.qty).toBe(2);
    });

    it("l'aggiunta su un'uscita già lanciata genera una revisione 'added'; la prima non ne genera", async () => {
        const orderId = await nuovaComanda();
        await api().post(`/orders/${orderId}/items`).set(bearer(token)).send({
            items: [{ dish_id: piatto1, qty: 1, course_no: 1 }],
        });
        const first = await api().post(`/orders/${orderId}/send`).set(bearer(token)).send({});
        expect(first.body.fired_courses).toContain(1);
        expect(await revisioniDi(orderId)).toHaveLength(0);

        // Stessa uscita, piatto in più: la card in cucina è già a video.
        await api().post(`/orders/${orderId}/items`).set(bearer(token)).send({
            items: [{ dish_id: piatto2, qty: 2, course_no: 1 }],
        });
        const second = await api().post(`/orders/${orderId}/send`).set(bearer(token)).send({});
        expect(second.status).toBe(200);

        const revs = await revisioniDi(orderId);
        expect(revs).toHaveLength(1);
        expect(revs[0].kind).toBe('added');
        expect(revs[0].summary).toContain('2× Fritto Revisioni');
    });

    it("il riporta genera una revisione 'unserved'; l'ack la spegne e non torna", async () => {
        const orderId = await nuovaComanda();
        await api().post(`/orders/${orderId}/items`).set(bearer(token)).send({
            items: [{ dish_id: piatto1, qty: 1, course_no: 1 }],
        });
        await api().post(`/orders/${orderId}/send`).set(bearer(token)).send({});
        const item = righe((await api().get(`/orders/${orderId}`).set(bearer(token))).body)[0];
        await api().post(`/kds/items/${item.id}/status`).set(bearer(token)).send({ status: 'READY' });
        const served = await api().post(`/orders/${orderId}/courses/1/serve`).set(bearer(token)).send({});
        expect(served.status).toBe(200);

        const back = await api().post(`/orders/${orderId}/courses/1/unserve`).set(bearer(token)).send({});
        expect(back.status).toBe(200);

        const revs = await revisioniDi(orderId);
        expect(revs).toHaveLength(1);
        expect(revs[0].kind).toBe('unserved');

        const ack = await api().post(`/kds/revisions/${revs[0].id}/ack`).set(bearer(token)).send({});
        expect(ack.status).toBe(200);
        expect(await revisioniDi(orderId)).toHaveLength(0);

        // Ack ripetuto (schermo in ritardo): non è un errore.
        const again = await api().post(`/kds/revisions/${revs[0].id}/ack`).set(bearer(token)).send({});
        expect(again.status).toBe(200);
    });
});

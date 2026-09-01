import { describe, it, expect, beforeAll } from 'vitest';
import { api, bearer, ownerToken } from './helpers';

// Cassa — la sessione del cassetto (docs/cassa-plan.md §3.1).
//
// Gira DOPO orders-bills (ordine alfabetico = contratto), che ha già acceso
// table_orders_enabled e pay_at_table_enabled.
//
// Il tenant è condiviso fra i file di test e i movimenti degli altri sono già
// a registro: si confrontano i DELTA, mai i totali assoluti. È anche il modo
// giusto di provare l'atteso — quello che conta è che si muova della cifra
// giusta quando entra o esce un contante.
describe('cassa — sessione del cassetto', () => {
    let token: string;
    let billId = 0;
    let sessionId = 0;

    const openBill = async (tableName: string, totalCents: number): Promise<number> => {
        const room = await api().post('/rooms').set(bearer(token)).send({
            name: `Sala Sessione ${tableName}`, width: 800, height: 600,
        });
        expect(room.status).toBe(201);
        const table = await api().post('/tables').set(bearer(token)).send({
            name: tableName, shape: 'SQUARE', seats: 4, x: 100, y: 300,
            room_id: room.body.id, status: 'FREE',
        });
        expect(table.status).toBe(201);
        const bill = await api().post(`/tables/${table.body.id}/bill`).set(bearer(token)).send({
            total_cents: totalCents, covers: 2,
        });
        expect(bill.status).toBe(201);
        return bill.body.bill.id as number;
    };

    const view = async () => {
        const res = await api().get('/cash/session').set(bearer(token));
        expect(res.status).toBe(200);
        return res.body;
    };

    beforeAll(async () => {
        token = await ownerToken();
        billId = await openBill('SESS1', 20000);
    });

    it('i totali del servizio si leggono anche a cassa mai aperta', async () => {
        const body = await view();
        expect(body.session).toBeNull();
        expect(body.service.service_date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
        expect(['LUNCH', 'DINNER']).toContain(body.service.shift);
        // Senza fondo dichiarato l'atteso è il solo contante del turno.
        expect(body.expected_cents).toBe(body.cash_cents);
    });

    it('un incasso in contanti alza l’atteso della stessa cifra', async () => {
        const before = await view();
        const res = await api().post(`/bills/${billId}/payments`).set(bearer(token)).send({
            method: 'CONTANTI', amount_cents: 5000,
        });
        expect(res.status).toBe(201);

        const after = await view();
        expect(after.cash_cents - before.cash_cents).toBe(5000);
        expect(after.expected_cents - before.expected_cents).toBe(5000);
        expect(after.collected_cents - before.collected_cents).toBe(5000);
    });

    it('il POS entra nell’incassato ma non nel cassetto', async () => {
        const before = await view();
        const res = await api().post(`/bills/${billId}/payments`).set(bearer(token)).send({
            method: 'POS_FISICO', amount_cents: 3000,
        });
        expect(res.status).toBe(201);

        const after = await view();
        expect(after.collected_cents - before.collected_cents).toBe(3000);
        // Il contante non si muove: nel cassetto non è entrato niente.
        expect(after.cash_cents).toBe(before.cash_cents);
        expect(after.expected_cents).toBe(before.expected_cents);
    });

    it('l’omaggio salda il conto ma resta fuori dall’incassato', async () => {
        const before = await view();
        const res = await api().post(`/bills/${billId}/payments`).set(bearer(token)).send({
            method: 'OMAGGIO', amount_cents: 1000,
        });
        expect(res.status).toBe(201);

        const after = await view();
        expect(after.out_of_totals.omaggio_cents - before.out_of_totals.omaggio_cents).toBe(1000);
        expect(after.collected_cents).toBe(before.collected_cents);
        expect(after.methods.some((m: any) => m.method === 'OMAGGIO')).toBe(false);
    });

    it('il fondo di apertura si dichiara una volta sola', async () => {
        const res = await api().post('/cash/session').set(bearer(token)).send({
            opening_float_cents: 15000,
        });
        expect(res.status).toBe(201);
        expect(res.body.session).toBeTruthy();
        expect(res.body.session.opening_float_cents).toBe(15000);
        expect(res.body.session.closed_at).toBeNull();
        expect(res.body.expected_cents).toBe(15000 + res.body.cash_cents);
        sessionId = res.body.session.id;

        // Due cassieri che aprono insieme non creano due cassetti.
        const again = await api().post('/cash/session').set(bearer(token)).send({
            opening_float_cents: 9900,
        });
        expect(again.status).toBe(409);
    });

    it('il fondo si corregge finché la cassa è aperta', async () => {
        const res = await api().patch(`/cash/session/${sessionId}`).set(bearer(token)).send({
            opening_float_cents: 15500,
        });
        expect(res.status).toBe(200);
        expect(res.body.session.opening_float_cents).toBe(15500);
        expect(res.body.expected_cents).toBe(15500 + res.body.cash_cents);
    });

    it('lo storno di un incasso in contanti abbassa l’atteso', async () => {
        const before = await view();
        const pay = await api().post(`/bills/${billId}/payments`).set(bearer(token)).send({
            method: 'CONTANTI', amount_cents: 2000,
        });
        expect(pay.status).toBe(201);
        // Si cerca per importo, non per posizione: l'ordinamento è per
        // recorded_at e due incassi nello stesso secondo pareggiano.
        const row = pay.body.payments.find(
            (p: any) => p.method === 'CONTANTI' && p.amount_cents === 2000 && p.voided_at == null
        );
        expect(row).toBeTruthy();

        const mid = await view();
        expect(mid.expected_cents - before.expected_cents).toBe(2000);

        const voided = await api()
            .post(`/bills/${billId}/payments/${row.id}/void`)
            .set(bearer(token))
            .send({ reason: 'importo battuto sul tavolo sbagliato' });
        expect(voided.status).toBe(200);

        const after = await view();
        // Il cassetto torna dov'era, e lo storno resta a registro fuori dai totali.
        expect(after.expected_cents).toBe(before.expected_cents);
        expect(after.out_of_totals.voided_cents - before.out_of_totals.voided_cents).toBe(2000);
    });

    it('senza nota la differenza non si chiude', async () => {
        const body = await view();
        const res = await api().post(`/cash/session/${sessionId}/close`).set(bearer(token)).send({
            counted_cents: body.expected_cents - 500,
        });
        expect(res.status).toBe(400);
        expect(res.body.difference_cents).toBe(-500);
        expect(res.body.expected_cents).toBe(body.expected_cents);
    });

    it('con la nota la cassa si chiude e la differenza resta a registro', async () => {
        const body = await view();
        const counted = body.expected_cents - 500;
        const res = await api().post(`/cash/session/${sessionId}/close`).set(bearer(token)).send({
            counted_cents: counted,
            note: 'ammanco di 5 euro, resto sbagliato al tavolo 9',
        });
        expect(res.status).toBe(200);
        expect(res.body.session.counted_cents).toBe(counted);
        expect(res.body.session.difference_cents).toBe(-500);
        expect(res.body.session.note).toContain('ammanco');
        expect(res.body.session.closed_at).toBeTruthy();
        expect(res.body.session.closed_by_name).toBeTruthy();
    });

    it('a cassa chiusa non si tocca più niente', async () => {
        const patched = await api().patch(`/cash/session/${sessionId}`).set(bearer(token)).send({
            opening_float_cents: 100,
        });
        expect(patched.status).toBe(409);

        const closed = await api().post(`/cash/session/${sessionId}/close`).set(bearer(token)).send({
            counted_cents: 100, note: 'seconda chiusura',
        });
        expect(closed.status).toBe(409);
    });

    it('le transazioni del servizio elencano i movimenti e li totalizzano', async () => {
        const res = await api().get('/cash/transactions').set(bearer(token));
        expect(res.status).toBe(200);
        expect(Array.isArray(res.body.movements)).toBe(true);

        const mine = res.body.movements.filter((m: any) => m.bill_id === billId);
        expect(mine.length).toBeGreaterThan(0);

        // Lo storno c'è, marcato, e non sparisce dall'elenco.
        const stornato = mine.find((m: any) => m.voided === true);
        expect(stornato).toBeTruthy();
        expect(stornato.void_reason).toContain('tavolo sbagliato');

        // L'omaggio è nell'elenco ma fuori dagli incassi.
        const omaggio = mine.find((m: any) => m.method === 'OMAGGIO');
        expect(omaggio).toBeTruthy();
        expect(res.body.totals.omaggio_cents).toBeGreaterThanOrEqual(1000);

        // I totali della vista movimenti e quelli della sessione raccontano lo
        // stesso servizio: se divergono, uno dei due schermi mente.
        const sess = await view();
        expect(res.body.totals.collected_cents).toBe(sess.collected_cents);
        expect(res.body.totals.voided_cents).toBe(sess.out_of_totals.voided_cents);
    });

    it('la differenza memorizzata non si muove più con gli incassi successivi', async () => {
        // È il motivo per cui difference_cents è a colonna e l'atteso no: la
        // nota dell'operatore deve continuare a spiegare il numero che ha visto.
        const pay = await api().post(`/bills/${billId}/payments`).set(bearer(token)).send({
            method: 'CONTANTI', amount_cents: 700,
        });
        expect(pay.status).toBe(201);

        const after = await view();
        expect(after.session.difference_cents).toBe(-500);
    });
});

import { describe, it, expect, beforeAll } from 'vitest';
import { api, bearer, ownerToken } from './helpers';

// Libro cassa del conto (table_bill_payments): incassi multi-metodo,
// storno, chiusura con movimenti e chiusura di cassa giornaliera.
// Gira DOPO orders-bills (ordine alfabetico = contratto), che ha già
// acceso table_orders_enabled e pay_at_table_enabled.
describe('libro cassa incassi', () => {
    let token: string;
    let billId: number;
    let posPaymentId: number;
    // Il report è cumulativo sul tenant: si confrontano i delta, non i
    // totali assoluti, così i conti chiusi dagli altri file non contano.
    let baseline: Record<string, number> = {};
    let baselineClosed = 0;

    const methodMap = (body: any): Record<string, number> =>
        Object.fromEntries(body.methods.map((m: any) => [m.method, m.amount_cents]));

    const openBill = async (tableName: string, totalCents: number): Promise<number> => {
        const room = await api().post('/rooms').set(bearer(token)).send({
            name: `Sala Cassa ${tableName}`, width: 800, height: 600,
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

    beforeAll(async () => {
        token = await ownerToken();
        const report = await api().get('/reports/cash-closure').set(bearer(token));
        expect(report.status).toBe(200);
        baseline = methodMap(report.body);
        baselineClosed = report.body.bills_closed;
        billId = await openBill('CASSA1', 10000);
    });

    it('registra un incasso POS e il residuo scende', async () => {
        const res = await api().post(`/bills/${billId}/payments`).set(bearer(token)).send({
            method: 'POS_FISICO', amount_cents: 4000,
        });
        expect(res.status).toBe(201);
        expect(res.body.staff_paid_cents).toBe(4000);
        expect(res.body.residual_cents).toBe(6000);
        expect(res.body.bill.status).toBe('OPEN');
        const row = res.body.payments.find((p: any) => p.method === 'POS_FISICO');
        expect(row).toBeTruthy();
        posPaymentId = row.id;
    });

    it('rifiuta metodo sconosciuto e importo oltre il residuo', async () => {
        const metodo = await api().post(`/bills/${billId}/payments`).set(bearer(token)).send({
            method: 'ASSEGNO', amount_cents: 100,
        });
        expect(metodo.status).toBe(400);

        const oltre = await api().post(`/bills/${billId}/payments`).set(bearer(token)).send({
            method: 'CONTANTI', amount_cents: 6001,
        });
        expect(oltre.status).toBe(409);
        expect(oltre.body.max_allowed_cents).toBe(6000);
    });

    it('l\'incasso che copre il residuo porta il conto a SETTLED', async () => {
        const res = await api().post(`/bills/${billId}/payments`).set(bearer(token)).send({
            method: 'CONTANTI', amount_cents: 6000,
        });
        expect(res.status).toBe(201);
        expect(res.body.residual_cents).toBe(0);
        expect(res.body.bill.status).toBe('SETTLED');
    });

    it('lo storno riapre il conto e il movimento resta a libro con voided_at', async () => {
        const res = await api().post(`/bills/${billId}/payments/${posPaymentId}/void`).set(bearer(token)).send({
            reason: 'battuto due volte',
        });
        expect(res.status).toBe(200);
        expect(res.body.bill.status).toBe('OPEN');
        expect(res.body.staff_paid_cents).toBe(6000);
        expect(res.body.residual_cents).toBe(4000);
        const stornato = res.body.payments.find((p: any) => p.id === posPaymentId);
        expect(stornato.voided_at).toBeTruthy();
        expect(stornato.void_reason).toBe('battuto due volte');
    });

    it('la chiusura registra i movimenti mancanti e chiude CLOSED', async () => {
        const res = await api().post(`/bills/${billId}/close`).set(bearer(token)).send({
            payments: [{ method: 'BUONO_PASTO', amount_cents: 4000 }],
            tip_cents: 500,
        });
        expect(res.status).toBe(200);
        expect(res.body.status).toBe('CLOSED');
        expect(res.body.tip_cents).toBe(500);
        // cash_settled_cents è la proiezione delle sole righe CONTANTI attive.
        expect(res.body.cash_settled_cents).toBe(6000);
    });

    it('la chiusura legacy con cash_settled_cents produce una riga CONTANTI', async () => {
        const legacyId = await openBill('CASSA2', 5000);
        const res = await api().post(`/bills/${legacyId}/close`).set(bearer(token)).send({
            cash_settled_cents: 5000,
        });
        expect(res.status).toBe(200);
        expect(res.body.status).toBe('CLOSED');
        expect(res.body.cash_settled_cents).toBe(5000);
    });

    it('la chiusura di cassa somma per metodo, storni esclusi', async () => {
        const report = await api().get('/reports/cash-closure').set(bearer(token));
        expect(report.status).toBe(200);
        const methods = methodMap(report.body);
        const delta = (m: string) => (methods[m] ?? 0) - (baseline[m] ?? 0);
        // CONTANTI: 6000 (conto 1) + 5000 (legacy). BUONO_PASTO: 4000.
        // POS_FISICO: 0 — il movimento da 4000 è stato stornato.
        expect(delta('CONTANTI')).toBe(11000);
        expect(delta('BUONO_PASTO')).toBe(4000);
        expect(delta('POS_FISICO')).toBe(0);
        expect(report.body.bills_closed - baselineClosed).toBe(2);
        expect(report.body.tip_cents).toBeGreaterThanOrEqual(500);
    });
});

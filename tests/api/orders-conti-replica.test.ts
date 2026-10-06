import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createHmac } from 'node:crypto';
import { Client } from 'pg';
import { api, bearer, ownerToken } from './helpers';

// Fase B2 del piano «sala, comande e conto sul nodo»: conti, cassa e
// documenti fiscali entrano nel log di replica; gli incassi sono
// idempotenti; un conto pagato tutto col QR si chiude e fa lo scontrino da
// solo dove lo scontrino è automatico. Gira dopo orders-bills (ordine
// alfabetico), che accende comande e pagamento al tavolo.

const WEBHOOK_SECRET = 'segreto-webhook-di-prova';

// Una sessione di cassa su un servizio futuro, tutta di questo file: quella
// del servizio in corso può essere già aperta (o chiusa) da un test
// precedente, e una per servizio è la regola.
const touchCashSession = async (token: string, _db: Client, floatCents: number): Promise<number> => {
    const open = await api().post('/cash/session').set(bearer(token)).send({ opening_float_cents: floatCents, date: '2031-03-14', shift: 'DINNER' });
    if (open.status === 200 || open.status === 201) return Number(open.body?.session?.id ?? open.body?.id);
    const cur = await _db.query(`SELECT id FROM cash_sessions WHERE tenant_id = 1 AND service_date = '2031-03-14' AND shift = 'DINNER'`);
    const id = Number(cur.rows[0]?.id);
    const patch = await api().patch(`/cash/session/${id}`).set(bearer(token)).send({ opening_float_cents: floatCents });
    expect(patch.status).toBe(200);
    return id;
};

describe('conti nel log di replica, incassi idempotenti, chiusura automatica del QR', () => {
    let token: string;
    let db: Client;

    const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
    const finoA = async (cond: () => Promise<boolean>, descr: string, timeoutMs = 10_000) => {
        const deadline = Date.now() + timeoutMs;
        for (;;) {
            if (await cond()) return;
            if (Date.now() > deadline) throw new Error(`Timeout: ${descr}`);
            await sleep(200);
        }
    };
    const logged = async (event: string, key: string, id: number): Promise<number> => {
        const r = await db.query(
            `SELECT COUNT(*)::int AS n FROM outbox_events WHERE event = $1 AND payload->>$2 = $3`,
            [event, key, String(id)]
        );
        return r.rows[0].n;
    };
    const openBill = async (name: string, totalCents: number) => {
        const room = await api().post('/rooms').set(bearer(token)).send({ name: `Sala Replica ${name}`, width: 600, height: 400 });
        const table = await api().post('/tables').set(bearer(token)).send({
            name, shape: 'SQUARE', seats: 4, x: 60, y: 60, room_id: room.body.id, status: 'FREE',
        });
        const bill = await api().post(`/tables/${table.body.id}/bill`).set(bearer(token)).send({ total_cents: totalCents, covers: 2 });
        expect(bill.status).toBe(201);
        return bill.body.bill as { id: number; share_token: string };
    };

    beforeAll(async () => {
        token = await ownerToken();
        db = new Client({ connectionString: process.env.DATABASE_URL || 'postgresql://localhost/ristotest_api' });
        await db.connect();
    });

    afterAll(async () => {
        await api().put('/settings/fiscal').set(bearer(token)).send({ provider: 'none' });
        await api().put('/settings/integrations/revolut').set(bearer(token)).send({ webhook_secret: '' });
        await db.end();
    });

    it('apertura, incasso e chiusura del conto entrano nel log come bill:changed', async () => {
        const bill = await openBill('REP1', 4000);
        expect(await logged('bill:changed', 'bill_id', bill.id)).toBeGreaterThanOrEqual(1);
        const prima = await logged('bill:changed', 'bill_id', bill.id);
        const pay = await api().post(`/bills/${bill.id}/payments`).set(bearer(token)).send({ method: 'CONTANTI', amount_cents: 1000 });
        expect(pay.status).toBe(201);
        expect(await logged('bill:changed', 'bill_id', bill.id)).toBe(prima + 1);
        const close = await api().post(`/bills/${bill.id}/close`).set(bearer(token)).send({ payments: [{ method: 'CONTANTI', amount_cents: 3000 }] });
        expect(close.status).toBe(200);
        expect(await logged('bill:changed', 'bill_id', bill.id)).toBe(prima + 2);
    });

    it('lo stesso incasso ritentato con la stessa chiave non incassa due volte', async () => {
        const bill = await openBill('REP2', 5000);
        const send = () => api().post(`/bills/${bill.id}/payments`).set(bearer(token))
            .set('Idempotency-Key', `chiave-${bill.id}`).send({ method: 'CONTANTI', amount_cents: 2000 });
        const first = await send();
        expect(first.status).toBe(201);
        const again = await send();
        expect(again.status).toBe(200);
        expect(again.body.idempotent_replay).toBe(true);
        const rows = await db.query(`SELECT COUNT(*)::int AS n FROM table_bill_payments WHERE table_bill_id = $1 AND voided_at IS NULL`, [bill.id]);
        expect(rows.rows[0].n).toBe(1);
    });

    it('sessione di cassa e documento fiscale entrano nel log', async () => {
        const sessionId = await touchCashSession(token, db, 10000);
        expect(await logged('cash:changed', 'cash_session_id', sessionId)).toBeGreaterThanOrEqual(1);

        await api().put('/settings/fiscal').set(bearer(token)).send({ provider: 'mock', vat_number: '11122211133' });
        const bill = await openBill('REP3', 2500);
        const close = await api().post(`/bills/${bill.id}/close`).set(bearer(token)).send({ payments: [{ method: 'POS_FISICO', amount_cents: 2500 }] });
        expect(close.status).toBe(200);
        await finoA(async () => {
            const doc = await db.query(`SELECT id FROM fiscal_documents WHERE table_bill_id = $1 AND status = 'CONFIRMED'`, [bill.id]);
            return Boolean(doc.rows[0]) && (await logged('fiscalDoc:changed', 'fiscal_document_id', doc.rows[0].id)) >= 1;
        }, 'documento fiscale nel log');
    });

    it('un conto pagato tutto col QR si chiude e fa lo scontrino da solo', async () => {
        await api().put('/settings/fiscal').set(bearer(token)).send({ provider: 'mock', vat_number: '11122211133' });
        const secret = await api().put('/settings/integrations/revolut').set(bearer(token)).send({ webhook_secret: WEBHOOK_SECRET });
        expect(secret.status).toBe(200);

        const bill = await openBill('REP4', 3000);
        const claim = await api().post(`/pay/${bill.share_token}/claim`).send({ kind: 'full_bill', claimant_label: 'Ospite' });
        expect([200, 201]).toContain(claim.status);
        const splitId = Number(claim.body?.split?.id ?? claim.body?.split_id ?? claim.body?.id);
        expect(Number.isInteger(splitId)).toBe(true);

        // La richiesta di pagamento che Revolut avrebbe creato (qui il
        // gateway non c'è): il webhook la ritrova per provider_order_id.
        const orderId = `ordine-qr-${bill.id}`;
        const pr = await db.query(
            `INSERT INTO payment_requests (tenant_id, amount_cents, currency, description, status, provider, provider_order_id, table_bill_split_id)
             VALUES (1, 3000, 'EUR', 'Quota di prova', 'PENDING', 'revolut', $1, $2) RETURNING id`,
            [orderId, splitId]
        );
        await db.query(`UPDATE table_bill_splits SET payment_request_id = $1 WHERE id = $2`, [pr.rows[0].id, splitId]);

        const body = JSON.stringify({ event: 'ORDER_COMPLETED', order_id: orderId });
        const ts = String(Date.now());
        const signature = createHmac('sha256', WEBHOOK_SECRET).update(`v1.${ts}.${body}`).digest('hex');
        const hook = await api().post('/webhook/revolut')
            .set('Content-Type', 'application/json')
            .set('Revolut-Request-Timestamp', ts)
            .set('Revolut-Signature', `v1=${signature}`)
            .send(body);
        expect(hook.status).toBe(200);

        await finoA(async () => {
            const b = await db.query(`SELECT status FROM table_bills WHERE id = $1`, [bill.id]);
            return b.rows[0]?.status === 'CLOSED';
        }, 'conto chiuso da solo');
        await finoA(async () => {
            const doc = await db.query(`SELECT status FROM fiscal_documents WHERE table_bill_id = $1`, [bill.id]);
            return doc.rows[0]?.status === 'CONFIRMED';
        }, 'scontrino emesso da solo');
    });

    it('senza scontrino automatico il conto pagato col QR resta da chiudere in cassa', async () => {
        await api().put('/settings/fiscal').set(bearer(token)).send({ provider: 'none' });
        const bill = await openBill('REP5', 2000);
        const claim = await api().post(`/pay/${bill.share_token}/claim`).send({ kind: 'full_bill', claimant_label: 'Ospite' });
        const splitId = Number(claim.body?.split?.id ?? claim.body?.split_id ?? claim.body?.id);
        const orderId = `ordine-qr-${bill.id}`;
        const pr = await db.query(
            `INSERT INTO payment_requests (tenant_id, amount_cents, currency, description, status, provider, provider_order_id, table_bill_split_id)
             VALUES (1, 2000, 'EUR', 'Quota di prova', 'PENDING', 'revolut', $1, $2) RETURNING id`,
            [orderId, splitId]
        );
        await db.query(`UPDATE table_bill_splits SET payment_request_id = $1 WHERE id = $2`, [pr.rows[0].id, splitId]);
        const body = JSON.stringify({ event: 'ORDER_COMPLETED', order_id: orderId });
        const ts = String(Date.now());
        const signature = createHmac('sha256', WEBHOOK_SECRET).update(`v1.${ts}.${body}`).digest('hex');
        const hook = await api().post('/webhook/revolut')
            .set('Content-Type', 'application/json')
            .set('Revolut-Request-Timestamp', ts)
            .set('Revolut-Signature', `v1=${signature}`)
            .send(body);
        expect(hook.status).toBe(200);
        await finoA(async () => {
            const b = await db.query(`SELECT status FROM table_bills WHERE id = $1`, [bill.id]);
            return b.rows[0]?.status === 'SETTLED';
        }, 'conto saldato, non chiuso');
        await sleep(500);
        const b = await db.query(`SELECT status FROM table_bills WHERE id = $1`, [bill.id]);
        expect(b.rows[0].status).toBe('SETTLED');
    });
});

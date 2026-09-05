import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Client } from 'pg';
import { api, bearer, ownerToken } from './helpers';

// Fattura elettronica (fase 4 fatturazione) col driver mock: dati cedente,
// billing in rubrica, fattura su conto intero e su quota, guardie contro il
// doppio binario fiscale, numerazione. Gira DOPO orders-bills (flag già
// accesi) e PRIMA di orders-fiscale, che si aspetta il provider spento:
// l'ultimo test lo rimette a 'none'.
describe('fatture elettroniche', () => {
    let token: string;
    let customerId: number;
    let billId: number;
    let invoiceNumber: string;

    const openBill = async (tableName: string, totalCents: number): Promise<number> => {
        const room = await api().post('/rooms').set(bearer(token)).send({
            name: `Sala Fatture ${tableName}`, width: 800, height: 600,
        });
        expect(room.status).toBe(201);
        const table = await api().post('/tables').set(bearer(token)).send({
            name: tableName, shape: 'SQUARE', seats: 4, x: 100, y: 900,
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
        const settings = await api().put('/settings/fiscal').set(bearer(token)).send({
            provider: 'mock',
            vat_number: '88806881905',
            seller: {
                business_name: 'RistoManager Sandbox Srl',
                address: { street: 'Via Roma 10', zip: '00100', city: 'Roma', province: 'RM' },
            },
        });
        expect(settings.status).toBe(200);
        expect(settings.body.seller.business_name).toBe('RistoManager Sandbox Srl');
    });

    afterAll(async () => {
        // Stato condiviso fra i file: orders-fiscale parte asserendo 'none'.
        await api().put('/settings/fiscal').set(bearer(token)).send({ provider: 'none' });
    });

    it('la rubrica salva e restituisce i dati di fatturazione', async () => {
        const created = await api().post('/customers').set(bearer(token)).send({
            name: 'Azienda Collaudo', phone: '+39 333 000 9911',
            billing: {
                name: 'Azienda Collaudo Srl', vat_number: '91827364505',
                sdi_code: 'ABC1234',
                address: { street: 'Via Milano 5', zip: '20100', city: 'Milano', province: 'MI' },
            },
        });
        expect(created.status).toBe(201);
        expect(created.body.billing.name).toBe('Azienda Collaudo Srl');
        expect(created.body.billing.vat_number).toBe('91827364505');
        customerId = created.body.id;

        // Aggiornare senza mandare billing NON lo azzera.
        const untouched = await api().put(`/customers/${customerId}`).set(bearer(token)).send({
            name: 'Azienda Collaudo', phone: '+39 333 000 9911', notes: 'nota',
        });
        expect(untouched.status).toBe(200);
        expect(untouched.body.billing.vat_number).toBe('91827364505');
    });

    it('con uno scontrino vivo la fattura rifiuta; annullato, parte con numero 1/anno', async () => {
        billId = await openBill('FATT1', 10000);
        const close = await api().post(`/bills/${billId}/close`).set(bearer(token)).send({
            payments: [{ method: 'POS_FISICO', amount_cents: 10000 }],
        });
        expect(close.status).toBe(200);
        expect(close.body.status).toBe('CLOSED');

        // L'emissione automatica dello scontrino (mock) è in volo o già
        // confermata: l'endpoint manuale la porta comunque a CONFIRMED.
        let receipt: any = null;
        for (let i = 0; i < 20; i++) {
            const res = await api().post(`/bills/${billId}/fiscal-docs`).set(bearer(token)).send({});
            if (res.status === 200 && res.body?.doc?.status === 'CONFIRMED') { receipt = res.body.doc; break; }
            await new Promise(r => setTimeout(r, 150));
        }
        expect(receipt?.status).toBe('CONFIRMED');

        const blocked = await api().post(`/bills/${billId}/invoices`).set(bearer(token)).send({
            customer_id: customerId,
        });
        expect(blocked.status).toBe(409);
        expect(blocked.body.reason).toBe('receipt_exists');

        const voided = await api().post(`/bills/${billId}/fiscal-docs/${receipt.id}/void`).set(bearer(token)).send({});
        expect(voided.status).toBe(200);

        const invoiced = await api().post(`/bills/${billId}/invoices`).set(bearer(token)).send({
            customer_id: customerId,
        });
        expect(invoiced.status).toBe(201);
        expect(invoiced.body.doc.doc_type).toBe('INVOICE');
        expect(invoiced.body.doc.status).toBe('CONFIRMED');
        expect(invoiced.body.doc.total_cents).toBe(10000);
        expect(String(invoiced.body.doc.provider_ref)).toMatch(/^MOCK-INV-/);
        invoiceNumber = invoiced.body.doc.doc_number;
        expect(invoiceNumber).toMatch(/^1\/\d{4}$/);
    });

    it('la fattura viva blocca replay, scontrino e annullo diretto', async () => {
        const replay = await api().post(`/bills/${billId}/invoices`).set(bearer(token)).send({
            customer_id: customerId,
        });
        expect(replay.status).toBe(409);

        const receiptBlocked = await api().post(`/bills/${billId}/fiscal-docs`).set(bearer(token)).send({});
        expect(receiptBlocked.status).toBe(409);
        expect(receiptBlocked.body.reason).toBe('invoice_exists');

        const bills = await api().get('/bills/open?status=closed').set(bearer(token));
        const row = bills.body.bills.find((b: any) => b.id === billId);
        const voidBlocked = await api().post(`/bills/${billId}/fiscal-docs/${row.fiscal_doc_id}/void`).set(bearer(token)).send({});
        expect(voidBlocked.status).toBe(409);
        expect(voidBlocked.body.error).toMatch(/nota di credito/);
    });

    it('la nota di credito storna la fattura e libera il conto', async () => {
        const bills = await api().get('/bills/open?status=closed').set(bearer(token));
        const row = bills.body.bills.find((b: any) => b.id === billId);
        expect(row.fiscal_doc_type).toBe('INVOICE');

        const storno = await api().post(`/bills/${billId}/fiscal-docs/${row.fiscal_doc_id}/credit-note`).set(bearer(token)).send({});
        expect(storno.status).toBe(201);
        expect(storno.body.doc.doc_type).toBe('CREDIT_NOTE');
        expect(storno.body.doc.status).toBe('CONFIRMED');
        expect(storno.body.doc.total_cents).toBe(10000);
        // Stessa numerazione annuale delle fatture: la 1/anno era la fattura.
        expect(storno.body.doc.doc_number).toMatch(/^2\/\d{4}$/);
        expect(storno.body.voided_invoice.status).toBe('VOIDED');

        // La nota è un atto contabile definitivo: né annullo né secondo storno.
        const voidCn = await api().post(`/bills/${billId}/fiscal-docs/${storno.body.doc.id}/void`).set(bearer(token)).send({});
        expect(voidCn.status).toBe(409);
        const again = await api().post(`/bills/${billId}/fiscal-docs/${row.fiscal_doc_id}/credit-note`).set(bearer(token)).send({});
        expect(again.status).toBe(409);

        // Il posto del documento vivo è di nuovo libero: lo scontrino parte.
        const reissue = await api().post(`/bills/${billId}/fiscal-docs`).set(bearer(token)).send({});
        expect(reissue.status).toBe(200);
        expect(reissue.body.doc.doc_type).toBe('RECEIPT');
        expect(reissue.body.doc.status).toBe('CONFIRMED');
    });

    it('dati del cliente incompleti → 400 con l\'elenco di cosa manca', async () => {
        const otherBill = await openBill('FATT2', 5000);
        const close = await api().post(`/bills/${otherBill}/close`).set(bearer(token)).send({
            payments: [{ method: 'CONTANTI', amount_cents: 5000 }],
        });
        expect(close.status).toBe(200);
        // Lo scontrino automatico va tolto di mezzo per arrivare alla validazione.
        let receipt: any = null;
        for (let i = 0; i < 20; i++) {
            const res = await api().post(`/bills/${otherBill}/fiscal-docs`).set(bearer(token)).send({});
            if (res.status === 200 && res.body?.doc?.status === 'CONFIRMED') { receipt = res.body.doc; break; }
            await new Promise(r => setTimeout(r, 150));
        }
        await api().post(`/bills/${otherBill}/fiscal-docs/${receipt.id}/void`).set(bearer(token)).send({});

        const res = await api().post(`/bills/${otherBill}/invoices`).set(bearer(token)).send({
            buyer: { name: 'Sconosciuto Srl' },
        });
        expect(res.status).toBe(400);
        expect(res.body.reason).toBe('missing_buyer');
    });

    it('la fattura sulla quota copre solo quell\'importo e blocca l\'intero', async () => {
        const splitBill = await openBill('FATT3', 12000);
        // Una quota PAID senza passare dal gateway: inserita direttamente a
        // DB, come farebbe il webhook — il flusso di claim pubblico è già
        // coperto altrove e qui serve solo lo stato finale.
        const db = new Client({ connectionString: process.env.DATABASE_URL || 'postgresql://localhost/ristotest_api' });
        await db.connect();
        let splitId: number;
        try {
            const ins = await db.query(
                `INSERT INTO table_bill_splits (tenant_id, table_bill_id, kind, amount_cents, claimant_label, status, paid_at)
                 VALUES (1, $1, 'fixed_amount', 4000, 'Azienda', 'PAID', CURRENT_TIMESTAMP)
                 RETURNING id`,
                [splitBill]
            );
            splitId = ins.rows[0].id;
        } finally {
            await db.end();
        }

        const invoiced = await api().post(`/bills/${splitBill}/invoices`).set(bearer(token)).send({
            customer_id: customerId, split_id: splitId,
        });
        expect(invoiced.status).toBe(201);
        expect(invoiced.body.doc.total_cents).toBe(4000);
        // 1 la fattura del test sopra, 2 la sua nota di credito.
        expect(invoiced.body.doc.doc_number).toMatch(/^3\/\d{4}$/);

        // Chiusura del resto in contanti: lo scontrino automatico NON deve
        // partire (c'è la fattura sulla quota — doppio binario vietato)...
        const close = await api().post(`/bills/${splitBill}/close`).set(bearer(token)).send({
            payments: [{ method: 'CONTANTI', amount_cents: 8000 }],
        });
        expect(close.status).toBe(200);
        expect(close.body.status).toBe('CLOSED');
        const receiptBlocked = await api().post(`/bills/${splitBill}/fiscal-docs`).set(bearer(token)).send({});
        expect(receiptBlocked.status).toBe(409);
        expect(receiptBlocked.body.reason).toBe('invoice_exists');

        // ...e nemmeno la fattura sull'intero.
        const wholeBlocked = await api().post(`/bills/${splitBill}/invoices`).set(bearer(token)).send({
            customer_id: customerId,
        });
        expect(wholeBlocked.status).toBe(409);
        expect(wholeBlocked.body.reason).toBe('split_invoices_exist');
    });

    it('la chiusura proforma cede il posto alla fattura senza annulli', async () => {
        const proformaBill = await openBill('FATT4', 6000);
        const close = await api().post(`/bills/${proformaBill}/close`).set(bearer(token)).send({
            payments: [{ method: 'POS_FISICO', amount_cents: 6000 }],
            documento: 'Proforma',
        });
        expect(close.status).toBe(200);
        expect(close.body.status).toBe('CLOSED');

        let row: any = null;
        for (let i = 0; i < 20; i++) {
            const bills = await api().get('/bills/open?status=closed').set(bearer(token));
            row = bills.body.bills.find((b: any) => b.id === proformaBill);
            if (row?.fiscal_status) break;
            await new Promise(r => setTimeout(r, 150));
        }
        expect(row?.fiscal_doc_type).toBe('PROFORMA');

        // Niente scontrino da annullare: la fattura parte diretta.
        const invoiced = await api().post(`/bills/${proformaBill}/invoices`).set(bearer(token)).send({
            customer_id: customerId,
        });
        expect(invoiced.status).toBe(201);
        expect(invoiced.body.doc.doc_type).toBe('INVOICE');
        expect(invoiced.body.doc.doc_number).toMatch(/^4\/\d{4}$/);
    });
    // Lookup P.IVA (dialog fattura): qui solo i rami che non dipendono dal
    // servizio esterno — validazione e autenticazione. La chiamata vera
    // all'API Imprese si collauda a mano (serve lo scope sul token).
    it('il lookup P.IVA valida l\'input e richiede il login', async () => {
        const anon = await api().get('/company-lookup/12485671007');
        expect(anon.status).toBe(401);
        const bad = await api().get('/company-lookup/IT12345').set(bearer(token));
        expect(bad.status).toBe(400);
        expect(bad.body.error).toBe('piva_invalid');
    });
});

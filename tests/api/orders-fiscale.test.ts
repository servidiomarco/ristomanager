import { describe, it, expect, beforeAll } from 'vitest';
import { api, bearer, ownerToken } from './helpers';

// Documento commerciale (fase 3 fatturazione) col driver mock: settings,
// emissione su conto chiuso, mapping del payload, idempotenza, annullo.
// Gira DOPO orders-bills (ordine alfabetico = contratto), che ha già acceso
// table_orders_enabled e pay_at_table_enabled.
describe('documenti fiscali', () => {
    let token: string;
    let billId: number;
    let confirmedDocId: number;

    const openBill = async (tableName: string, totalCents: number): Promise<number> => {
        const room = await api().post('/rooms').set(bearer(token)).send({
            name: `Sala Fiscale ${tableName}`, width: 800, height: 600,
        });
        expect(room.status).toBe(201);
        const table = await api().post('/tables').set(bearer(token)).send({
            name: tableName, shape: 'SQUARE', seats: 4, x: 100, y: 700,
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
    });

    it('le impostazioni fiscali validano provider e P.IVA', async () => {
        const before = await api().get('/settings/fiscal').set(bearer(token));
        expect(before.status).toBe(200);
        expect(before.body.provider).toBe('none');

        const badVat = await api().put('/settings/fiscal').set(bearer(token)).send({ vat_number: 'IT123' });
        expect(badVat.status).toBe(400);
        const badProvider = await api().put('/settings/fiscal').set(bearer(token)).send({ provider: 'stripe' });
        expect(badProvider.status).toBe(400);

        const ok = await api().put('/settings/fiscal').set(bearer(token)).send({
            provider: 'mock', vat_number: '11122211133',
        });
        expect(ok.status).toBe(200);
        expect(ok.body.provider).toBe('mock');
        expect(ok.body.vat_number).toBe('11122211133');
    });

    it('senza conto chiuso non si emette', async () => {
        billId = await openBill('FISC1', 5000);
        const res = await api().post(`/bills/${billId}/fiscal-docs`).set(bearer(token)).send({});
        expect(res.status).toBe(409);
        expect(res.body.reason).toBe('bill_not_closed');
    });

    it('alla chiusura il documento parte e il payload quadra', async () => {
        const close = await api().post(`/bills/${billId}/close`).set(bearer(token)).send({
            payments: [
                { method: 'CONTANTI', amount_cents: 3000 },
                { method: 'POS_FISICO', amount_cents: 2000 },
            ],
        });
        expect(close.status).toBe(200);
        expect(close.body.status).toBe('CLOSED');

        // L'emissione automatica è fire-and-forget: l'endpoint manuale è
        // idempotente e ritorna il documento — o 409 in_progress se l'altra
        // emissione è ancora in volo (il claim atomico che evita il doppio
        // scontrino). Si riprova finché non è confermato.
        let res: any = null;
        for (let i = 0; i < 20; i++) {
            res = await api().post(`/bills/${billId}/fiscal-docs`).set(bearer(token)).send({});
            if (res.status === 200 && res.body?.doc?.status === 'CONFIRMED') break;
            expect([200, 409]).toContain(res.status);
            await new Promise(r => setTimeout(r, 150));
        }
        expect(res.status).toBe(200);
        expect(res.body.doc.status).toBe('CONFIRMED');
        expect(res.body.doc.provider).toBe('mock');
        expect(res.body.doc.total_cents).toBe(5000);
        expect(String(res.body.doc.provider_ref)).toMatch(/^MOCK-/);
        confirmedDocId = res.body.doc.id;

        // Conto aperto a mano, niente righe: una riga unica "Consumazione"
        // al 10%, incassi mappati sui campi del documento.
        expect(res.body.request).toMatchObject({
            fiscal_id: '11122211133',
            type: 'sale',
            cash_payment_amount: '30.00',
            electronic_payment_amount: '20.00',
            ticket_restaurant_payment_amount: '0.00',
            services_uncollected_amount: '0.00',
            discount: '0.00',
        });
        expect(res.body.request.items).toEqual([
            { quantity: '1.00', description: 'Consumazione', unit_price: '50.00', vat_rate_code: '10.00' },
        ]);

        // Idempotenza: riemettere non duplica, torna lo stesso documento.
        const again = await api().post(`/bills/${billId}/fiscal-docs`).set(bearer(token)).send({});
        expect(again.status).toBe(200);
        expect(again.body.doc.id).toBe(confirmedDocId);
    });

    it('l\'annullo porta a VOIDED e libera il posto per un nuovo documento', async () => {
        const voided = await api().post(`/bills/${billId}/fiscal-docs/${confirmedDocId}/void`).set(bearer(token)).send({});
        expect(voided.status).toBe(200);
        expect(voided.body.doc.status).toBe('VOIDED');

        const reissue = await api().post(`/bills/${billId}/fiscal-docs`).set(bearer(token)).send({});
        expect(reissue.status).toBe(200);
        expect(reissue.body.doc.status).toBe('CONFIRMED');
        expect(reissue.body.doc.id).not.toBe(confirmedDocId);
    });

    it('un conto chiuso con ammanco non emette (SETTLED_PARTIAL)', async () => {
        const partialId = await openBill('FISC2', 8000);
        const close = await api().post(`/bills/${partialId}/close`).set(bearer(token)).send({
            payments: [{ method: 'CONTANTI', amount_cents: 5000 }],
        });
        expect(close.status).toBe(200);
        expect(close.body.status).toBe('SETTLED_PARTIAL');

        const res = await api().post(`/bills/${partialId}/fiscal-docs`).set(bearer(token)).send({});
        expect(res.status).toBe(409);
        expect(res.body.reason).toBe('bill_not_closed');
    });

    it('la chiusura proforma non emette e lo scontrino dopo la supera', async () => {
        const proformaBill = await openBill('FISC3', 7000);
        const close = await api().post(`/bills/${proformaBill}/close`).set(bearer(token)).send({
            payments: [{ method: 'CONTANTI', amount_cents: 7000 }],
            documento: 'Proforma',
        });
        expect(close.status).toBe(200);
        expect(close.body.status).toBe('CLOSED');

        // La registrazione della proforma è fire-and-forget: si aspetta la
        // riga PROFORMA (e NON uno scontrino) sulla lista dei chiusi.
        let row: any = null;
        for (let i = 0; i < 20; i++) {
            const bills = await api().get('/bills/open?status=closed').set(bearer(token));
            row = bills.body.bills.find((b: any) => b.id === proformaBill);
            if (row?.fiscal_status) break;
            await new Promise(r => setTimeout(r, 150));
        }
        expect(row?.fiscal_status).toBe('CONFIRMED');
        expect(row?.fiscal_doc_type).toBe('PROFORMA');

        // Lo scontrino emesso dopo supera il segnaposto da solo.
        const res = await api().post(`/bills/${proformaBill}/fiscal-docs`).set(bearer(token)).send({});
        expect(res.status).toBe(200);
        expect(res.body.doc.status).toBe('CONFIRMED');
        expect(res.body.doc.doc_type).toBe('RECEIPT');
    });

    it('il provider fiscale torna spento per i file successivi', async () => {
        // Stato condiviso fra i file di test: si rimette com'era.
        const off = await api().put('/settings/fiscal').set(bearer(token)).send({ provider: 'none' });
        expect(off.status).toBe(200);
        expect(off.body.provider).toBe('none');
    });

    it('la proforma vive anche senza provider: in chiusura e a posteriori', async () => {
        // Con provider spento la chiusura non emette nulla, ma la scelta
        // Proforma resta registrabile — e un conto chiuso "senza scontrino"
        // si può marcare proforma dopo.
        const inDialog = await openBill('FISC4', 3000);
        const close1 = await api().post(`/bills/${inDialog}/close`).set(bearer(token)).send({
            payments: [{ method: 'CONTANTI', amount_cents: 3000 }],
            documento: 'Proforma',
        });
        expect(close1.status).toBe(200);
        let row: any = null;
        for (let i = 0; i < 20; i++) {
            const bills = await api().get('/bills/open?status=closed').set(bearer(token));
            row = bills.body.bills.find((b: any) => b.id === inDialog);
            if (row?.fiscal_status) break;
            await new Promise(r => setTimeout(r, 150));
        }
        expect(row?.fiscal_doc_type).toBe('PROFORMA');

        const forgotten = await openBill('FISC5', 2000);
        const close2 = await api().post(`/bills/${forgotten}/close`).set(bearer(token)).send({
            payments: [{ method: 'CONTANTI', amount_cents: 2000 }],
        });
        expect(close2.status).toBe(200);
        const marked = await api().post(`/bills/${forgotten}/fiscal-docs`).set(bearer(token)).send({ documento: 'Proforma' });
        expect(marked.status).toBe(200);
        expect(marked.body.doc.doc_type).toBe('PROFORMA');
        expect(marked.body.doc.status).toBe('CONFIRMED');

        // Un secondo "segna proforma" non duplica.
        const again = await api().post(`/bills/${forgotten}/fiscal-docs`).set(bearer(token)).send({ documento: 'Proforma' });
        expect(again.status).toBe(409);
        expect(again.body.reason).toBe('doc_exists');
    });
});

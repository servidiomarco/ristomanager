import { describe, it, expect, beforeAll, afterAll } from 'vitest';
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

    it('la mappatura IVA parte a 10, valida i campi e fa merge sui PUT parziali', async () => {
        const before = await api().get('/settings/fiscal').set(bearer(token));
        expect(before.body.vat_map).toEqual({ dish_default: 10, cover: 10, service: 10, fallback: 10 });

        const bad = await api().put('/settings/fiscal').set(bearer(token)).send({ vat_map: { cover: 7.5 } });
        expect(bad.status).toBe(400);
        const badShape = await api().put('/settings/fiscal').set(bearer(token)).send({ vat_map: [22] });
        expect(badShape.status).toBe(400);

        const partial = await api().put('/settings/fiscal').set(bearer(token)).send({ vat_map: { cover: 22 } });
        expect(partial.status).toBe(200);
        // Merge: il PUT del solo coperto non tocca gli altri campi.
        expect(partial.body.vat_map).toEqual({ dish_default: 10, cover: 22, service: 10, fallback: 10 });

        // Il default dei nuovi piatti segue dish_default quando il client
        // non manda vat_rate.
        await api().put('/settings/fiscal').set(bearer(token)).send({ vat_map: { dish_default: 4 } });
        const dish = await api().post('/dishes').set(bearer(token)).send({
            name: 'Pane fiscale', price: 2, category: 'Antipasti', allergens: [],
        });
        expect(dish.status).toBe(201);
        expect(Number(dish.body.vat_rate)).toBe(4);

        // Ripristino: i file di test girano in sequenza sullo stesso DB.
        const reset = await api().put('/settings/fiscal').set(bearer(token)).send({
            vat_map: { dish_default: 10, cover: 10, service: 10, fallback: 10 },
        });
        expect(reset.body.vat_map).toEqual({ dish_default: 10, cover: 10, service: 10, fallback: 10 });
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

// Copia del documento commerciale per il cliente: cartacea (print job
// SCONTRINO dai dati EMESSI, non dal conto) e digitale (pagina pubblica
// /r/:token dietro share_token coniato alla prima richiesta).
describe('copia scontrino (stampa e QR)', () => {
    let token: string;
    let billId: number;
    let docId: number;

    const openBill = async (tableName: string, totalCents: number): Promise<number> => {
        const room = await api().post('/rooms').set(bearer(token)).send({
            name: `Sala Copia ${tableName}`, width: 800, height: 600,
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
        expect(bill.status, JSON.stringify(bill.body)).toBe(201);
        return bill.body.bill.id as number;
    };

    beforeAll(async () => {
        token = await ownerToken();
        // Il describe precedente rispegne il provider per i file successivi:
        // qui serve di nuovo acceso — e l'afterAll lo rispegne a sua volta.
        const on = await api().put('/settings/fiscal').set(bearer(token)).send({
            provider: 'mock', vat_number: '11122211133',
        });
        expect(on.status).toBe(200);
        billId = await openBill('COPIA1', 4200);
        const close = await api().post(`/bills/${billId}/close`).set(bearer(token)).send({
            payments: [{ method: 'CONTANTI', amount_cents: 4200 }],
        });
        expect(close.status).toBe(200);
        let res: any = null;
        for (let i = 0; i < 20; i++) {
            res = await api().post(`/bills/${billId}/fiscal-docs`).set(bearer(token)).send({});
            if (res.status === 200 && res.body?.doc?.status === 'CONFIRMED') break;
            await new Promise(r => setTimeout(r, 150));
        }
        expect(res.body.doc.status).toBe('CONFIRMED');
        docId = res.body.doc.id;
    });

    afterAll(async () => {
        // Come il describe sopra: stato condiviso, si rimette com'era.
        await api().put('/settings/fiscal').set(bearer(token)).send({ provider: 'none' });
    });

    it('la copia cartacea finisce in coda col payload del documento emesso', async () => {
        const job = await api().post('/print-jobs').set(bearer(token)).send({ bill_id: billId, kind: 'SCONTRINO' });
        expect(job.status).toBe(201);

        // Il payload si verifica dal punto di vista dell'agente: è lui che
        // lo renderizza, il contratto è quello.
        const queue = await api().get('/print-agent/jobs').set('x-print-agent-token', 'test-print-agent-token');
        expect(queue.status).toBe(200);
        const mine = queue.body.jobs.find((j: any) => j.id === job.body.id);
        expect(mine.kind).toBe('SCONTRINO');
        expect(mine.payload.total_cents).toBe(4200);
        expect(mine.payload.doc_number).toMatch(/^MOCK-/); // il mock non ha document_number: ripiega sul provider_ref
        expect(mine.payload.items).toEqual([
            { qty: 1, name: 'Consumazione', total_cents: 4200, vat_code: '10.00' },
        ]);
        expect(mine.payload.payments).toEqual([['Contanti', 4200]]);
        expect(mine.payload.vat_breakdown).toEqual([{ code: '10.00', gross_cents: 4200 }]);
        expect(String(mine.payload.share_url)).toMatch(/\/r\/[A-Za-z0-9_-]{20,}$/);

        // Ack per non lasciare il job PENDING ai file successivi.
        const ack = await api().post(`/print-agent/jobs/${mine.id}/ack`).set('x-print-agent-token', 'test-print-agent-token').send({ ok: true });
        expect(ack.status).toBe(200);
    });

    it('la copia digitale è pubblica dietro token, stabile e negata ai token sbagliati', async () => {
        const share = await api().post(`/bills/${billId}/fiscal-docs/${docId}/share`).set(bearer(token)).send({});
        expect(share.status).toBe(200);
        const url = new URL(share.body.url);
        expect(url.pathname).toMatch(/^\/r\/[A-Za-z0-9_-]{20,}$/);

        // Il token non cambia alla seconda richiesta: il QR stampato resta valido.
        const again = await api().post(`/bills/${billId}/fiscal-docs/${docId}/share`).set(bearer(token)).send({});
        expect(again.body.url).toBe(share.body.url);

        const page = await api().get(url.pathname);
        expect(page.status).toBe(200);
        expect(page.headers['content-type']).toContain('text/html');
        expect(page.text).toContain('documento commerciale');
        expect(page.text).toContain('42,00');

        const wrong = await api().get('/r/token-sbagliato-ma-abbastanza-lungo');
        expect(wrong.status).toBe(404);
    });

    it('senza scontrino confermato la copia non esiste', async () => {
        const open = await openBill('COPIA2', 1000);
        const job = await api().post('/print-jobs').set(bearer(token)).send({ bill_id: open, kind: 'SCONTRINO' });
        expect(job.status).toBe(409);
        expect(job.body.error).toBe('no_receipt');
    });
});

// Webhook esiti Openapi: lo scarto SDI arriva giorni dopo l'invio e deve
// ribaltare il documento a FAILED; gli esiti buoni (DELIVERED, cassetto
// fiscale) non toccano lo stato. Il payload è l'entità del provider, con le
// due codifiche del sistema di callback (JSON diretto o form 'data').
describe('webhook esiti openapi', () => {
    let token: string;
    let webhookBase: string;

    const closedBillWithDoc = async (tableName: string, totalCents: number): Promise<{ billId: number; ref: string }> => {
        const room = await api().post('/rooms').set(bearer(token)).send({ name: `Sala Esiti ${tableName}`, width: 800, height: 600 });
        const table = await api().post('/tables').set(bearer(token)).send({
            name: tableName, shape: 'SQUARE', seats: 4, x: 100, y: 700, room_id: room.body.id, status: 'FREE',
        });
        const bill = await api().post(`/tables/${table.body.id}/bill`).set(bearer(token)).send({ total_cents: totalCents, covers: 2 });
        expect(bill.status, JSON.stringify(bill.body)).toBe(201);
        const billId = bill.body.bill.id as number;
        await api().post(`/bills/${billId}/close`).set(bearer(token)).send({
            payments: [{ method: 'CONTANTI', amount_cents: totalCents }],
        });
        let res: any = null;
        for (let i = 0; i < 20; i++) {
            res = await api().post(`/bills/${billId}/fiscal-docs`).set(bearer(token)).send({});
            if (res.status === 200 && res.body?.doc?.status === 'CONFIRMED') break;
            await new Promise(r => setTimeout(r, 150));
        }
        expect(res.body.doc.status).toBe('CONFIRMED');
        return { billId, ref: String(res.body.doc.provider_ref) };
    };

    const fiscalRow = async (billId: number): Promise<any> => {
        const bills = await api().get('/bills/open?status=closed').set(bearer(token));
        return bills.body.bills.find((b: any) => b.id === billId);
    };

    beforeAll(async () => {
        token = await ownerToken();
        const on = await api().put('/settings/fiscal').set(bearer(token)).send({ provider: 'mock', vat_number: '11122211133' });
        expect(on.status).toBe(200);
        const info = await api().get('/settings/webhook-info').set(bearer(token));
        expect(info.status).toBe(200);
        webhookBase = new URL(info.body.examples.openapi_fiscale).pathname;
    });

    afterAll(async () => {
        await api().put('/settings/fiscal').set(bearer(token)).send({ provider: 'none' });
    });

    it('REJECTED da SDI ribalta il documento a FAILED col motivo', async () => {
        const { billId, ref } = await closedBillWithDoc('ESITO1', 3000);
        const hook = await api().post(webhookBase).send({
            id: ref, state: 'SENT',
            details: { sdi_status: 'REJECTED', sdi_message: 'Errore 00301: IdFiscaleIVA non valido' },
        });
        expect(hook.status).toBe(200);
        const row = await fiscalRow(billId);
        expect(row.fiscal_status).toBe('FAILED');
        expect(row.fiscal_error).toContain('SDI: REJECTED');
        expect(row.fiscal_error).toContain('00301');
    });

    it('DELIVERED non tocca lo stato; la codifica form "data" è capita', async () => {
        const { billId, ref } = await closedBillWithDoc('ESITO2', 2000);
        const hook = await api().post(webhookBase)
            .type('form')
            .send({ data: JSON.stringify({ id: ref, state: 'DONE', details: { sdi_status: 'DELIVERED' } }) });
        expect(hook.status).toBe(200);
        const row = await fiscalRow(billId);
        expect(row.fiscal_status).toBe('CONFIRMED');
    });

    it('token ignoto → 404; riferimento ignoto → 200 senza effetti', async () => {
        const wrongToken = await api().post('/webhook/t/token-inventato-lungo-abbastanza/openapi-fiscale').send({ id: 'X' });
        expect(wrongToken.status).toBe(404);
        const unknownRef = await api().post(webhookBase).send({ id: 'REF-CHE-NON-ESISTE', state: 'ERROR' });
        expect(unknownRef.status).toBe(200);
        expect(unknownRef.body.ignored).toBe('unknown_ref');
    });

    // Lotteria degli scontrini: il codice dettato in cassa viaggia sul conto
    // e finisce nel payload trasmesso; arriva anche col retry manuale per il
    // cliente che lo porge a documento già mancato.
    it('il codice lotteria della chiusura finisce nel documento', async () => {
        const room = await api().post('/rooms').set(bearer(token)).send({ name: 'Sala Lotteria', width: 800, height: 600 });
        const table = await api().post('/tables').set(bearer(token)).send({
            name: 'LOTTO1', shape: 'SQUARE', seats: 4, x: 100, y: 700, room_id: room.body.id, status: 'FREE',
        });
        const bill = await api().post(`/tables/${table.body.id}/bill`).set(bearer(token)).send({ total_cents: 2500, covers: 2 });
        const billId = bill.body.bill.id as number;

        const badCode = await api().post(`/bills/${billId}/close`).set(bearer(token)).send({
            payments: [{ method: 'POS_FISICO', amount_cents: 2500 }], lottery_code: 'corto',
        });
        expect(badCode.status).toBe(400);
        expect(badCode.body.error).toBe('lottery_code_invalid');

        const close = await api().post(`/bills/${billId}/close`).set(bearer(token)).send({
            payments: [{ method: 'POS_FISICO', amount_cents: 2500 }], lottery_code: 'abc123xy',
        });
        expect(close.status).toBe(200);
        let res: any = null;
        for (let i = 0; i < 20; i++) {
            res = await api().post(`/bills/${billId}/fiscal-docs`).set(bearer(token)).send({});
            if (res.status === 200 && res.body?.doc?.status === 'CONFIRMED') break;
            await new Promise(r => setTimeout(r, 150));
        }
        expect(res.body.doc.status).toBe('CONFIRMED');
        expect(res.body.request.lottery_code).toBe('ABC123XY'); // normalizzato maiuscolo
    });

    it('il codice lotteria arriva anche col retry manuale', async () => {
        const { billId, ref } = await closedBillWithDoc('LOTTO2', 1500);
        // Documento già emesso senza codice: si annulla e si riemette col
        // codice — il percorso reale del "scusi, ho il codice lotteria".
        const docs = await fiscalRow(billId);
        const voided = await api().post(`/bills/${billId}/fiscal-docs/${docs.fiscal_doc_id}/void`).set(bearer(token)).send({});
        expect(voided.status).toBe(200);
        expect(ref).toBeTruthy();

        const emit = await api().post(`/bills/${billId}/fiscal-docs`).set(bearer(token)).send({ lottery_code: 'ZZ99AA11' });
        expect(emit.status).toBe(200);
        expect(emit.body.request.lottery_code).toBe('ZZ99AA11');
    });
});

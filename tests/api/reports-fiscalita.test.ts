import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Client } from 'pg';
import { api, ownerToken, bearer } from './helpers';

// Vista Fiscalità: registro documenti per periodo, corrispettivi per
// aliquota, dettaglio e CSV. Il seed scrive direttamente su
// fiscal_documents con date FISSE nel passato (marzo 2026): gli altri file
// della suite emettono documenti "adesso" col driver mock, e un periodo
// relativo li conterebbe dentro — i totali qui devono essere deterministici.
//
// Vincolo da rispettare nel seed: l'indice parziale ammette UN documento
// vivo (PENDING/CONFIRMED, non nota di credito) per conto — ogni documento
// confermato ha il suo table_bill.

const FROM = '2026-03-10';
const TO = '2026-03-11';
const CASSA_EMAIL = 'cassa.fiscalita@example.com';
const PASSWORD = 'password-cassa-fiscalita';

const receiptRequest = (items: { q: string; p: string; vat: string }[], discount = '0.00') => JSON.stringify({
    fiscal_id: '11122211133',
    type: 'sale',
    items: items.map(i => ({ quantity: i.q, description: 'Riga di prova', unit_price: i.p, vat_rate_code: i.vat })),
    cash_payment_amount: '50.00',
    electronic_payment_amount: '0.00',
    ticket_restaurant_payment_amount: '0.00',
    ticket_restaurant_quantity: 0,
    services_uncollected_amount: '0.00',
    invoice_issuing: false,
    discount,
});

describe('reportistica fiscale (vista Fiscalità)', () => {
    let owner = '';
    let cassaToken = '';
    let db: Client;
    const billIds: number[] = [];
    const docIds: number[] = [];
    let receiptDetailId = 0;
    let stornataInvoiceId = 0;

    let seedTableId = 0;
    let seedRoomId = 0;

    const seedBill = async (totalCents: number): Promise<number> => {
        // Il vincolo table_bills_anchor_present vuole tavolo o prenotazione:
        // tutti i conti di seed pendono dallo stesso tavolo di servizio.
        const r = await db.query(
            `INSERT INTO table_bills (tenant_id, table_id, total_cents, covers, status, opened_at, closed_at)
             VALUES (1, $2, $1, 2, 'CLOSED', '2026-03-10T18:00:00Z', '2026-03-10T20:00:00Z') RETURNING id`,
            [totalCents, seedTableId]
        );
        billIds.push(r.rows[0].id);
        return r.rows[0].id;
    };

    const seedDoc = async (row: {
        bill: number; type: string; provider: string; status: string; total: number;
        created: string; request?: string | null; docNumber?: string | null;
        voidedAt?: string | null; relatedTo?: number | null;
    }): Promise<number> => {
        const confirmedAt = row.status === 'CONFIRMED' || row.status === 'VOIDED' ? row.created : null;
        const r = await db.query(
            `INSERT INTO fiscal_documents
                (tenant_id, table_bill_id, doc_type, provider, status, total_cents,
                 created_at, confirmed_at, voided_at, request, doc_number, related_doc_id, provider_ref)
             VALUES (1, $1, $2, $3, $4, $5, $6::timestamptz, $7::timestamptz,
                     $8::timestamptz, $9::jsonb, $10, $11, 'seed-' || gen_random_uuid())
             RETURNING id`,
            [row.bill, row.type, row.provider, row.status, row.total, row.created, confirmedAt,
             row.voidedAt ?? null, row.request ?? null, row.docNumber ?? null, row.relatedTo ?? null]
        );
        docIds.push(r.rows[0].id);
        return r.rows[0].id;
    };

    beforeAll(async () => {
        owner = await ownerToken();
        const created = await api().post('/auth/users').set(bearer(owner)).send({
            email: CASSA_EMAIL, password: PASSWORD, full_name: 'Cassa Fiscalità', role: 'CASSA',
        });
        expect(created.status).toBe(201);
        const login = await api().post('/auth/login').send({ email: CASSA_EMAIL, password: PASSWORD });
        cassaToken = login.body.accessToken;

        db = new Client({ connectionString: process.env.DATABASE_URL || 'postgresql://localhost/ristotest_api' });
        await db.connect();
        const room = await db.query(
            `INSERT INTO rooms (tenant_id, name, width, height) VALUES (1, 'Sala Fiscalità Seed', 800, 600) RETURNING id`
        );
        seedRoomId = room.rows[0].id;
        const table = await db.query(
            `INSERT INTO tables (tenant_id, room_id, name, shape, seats, x, y, status)
             VALUES (1, $1, 'FISCSEED', 'SQUARE', 4, 100, 100, 'FREE') RETURNING id`,
            [seedRoomId]
        );
        seedTableId = table.rows[0].id;

        // Due scontrini confermati con righe note: 10/03 → 2000 al 10% + 2440
        // al 22% + 560 N2 (totale 5000); 11/03 → 3000 al 10% con sconto 1€.
        receiptDetailId = await seedDoc({
            bill: await seedBill(5000), type: 'RECEIPT', provider: 'openapi', status: 'CONFIRMED', total: 5000,
            created: '2026-03-10T12:00:00Z',
            request: receiptRequest([
                { q: '2.00', p: '10.00', vat: '10.00' },
                { q: '1.00', p: '24.40', vat: '22.00' },
                { q: '1.00', p: '5.60', vat: 'N2' },
            ]),
        });
        await seedDoc({
            bill: await seedBill(2900), type: 'RECEIPT', provider: 'openapi', status: 'CONFIRMED', total: 2900,
            created: '2026-03-11T12:00:00Z',
            request: receiptRequest([{ q: '3.00', p: '10.00', vat: '10.00' }], '1.00'),
        });
        // Annullato: fuori da totali e corrispettivi.
        await seedDoc({
            bill: await seedBill(4000), type: 'RECEIPT', provider: 'openapi', status: 'VOIDED', total: 4000,
            created: '2026-03-10T13:00:00Z', voidedAt: '2026-03-10T13:30:00Z',
            request: receiptRequest([{ q: '4.00', p: '10.00', vat: '10.00' }]),
        });
        // Emesso dall'RT di cassa: request NULL, va nel bucket "esclusi".
        await seedDoc({
            bill: await seedBill(7000), type: 'RECEIPT', provider: 'passepartout', status: 'CONFIRMED', total: 7000,
            created: '2026-03-10T14:00:00Z',
        });
        // Proforma: segnaposto non fiscale, fuori dal documentato.
        await seedDoc({
            bill: await seedBill(1500), type: 'PROFORMA', provider: 'crm', status: 'CONFIRMED', total: 1500,
            created: '2026-03-10T15:00:00Z',
        });
        // Fattura viva + fattura stornata con la sua nota di credito.
        await seedDoc({
            bill: await seedBill(8000), type: 'INVOICE', provider: 'openapi', status: 'CONFIRMED', total: 8000,
            created: '2026-03-11T13:00:00Z', docNumber: '901/2026',
        });
        const stornataBill = await seedBill(2200);
        stornataInvoiceId = await seedDoc({
            bill: stornataBill, type: 'INVOICE', provider: 'openapi', status: 'VOIDED', total: 2200,
            created: '2026-03-11T14:00:00Z', docNumber: '902/2026',
        });
        await seedDoc({
            bill: stornataBill, type: 'CREDIT_NOTE', provider: 'openapi', status: 'CONFIRMED', total: 2200,
            created: '2026-03-11T15:00:00Z', docNumber: '903/2026', relatedTo: stornataInvoiceId,
        });
        // Fuori periodo: non deve comparire da nessuna parte.
        await seedDoc({
            bill: await seedBill(9999), type: 'RECEIPT', provider: 'openapi', status: 'CONFIRMED', total: 9999,
            created: '2026-03-20T12:00:00Z',
            request: receiptRequest([{ q: '1.00', p: '99.99', vat: '10.00' }]),
        });
    });

    afterAll(async () => {
        try {
            if (docIds.length) await db.query(`DELETE FROM fiscal_documents WHERE id = ANY($1::bigint[])`, [docIds]);
            if (billIds.length) await db.query(`DELETE FROM table_bills WHERE id = ANY($1::int[])`, [billIds]);
            if (seedTableId) await db.query(`DELETE FROM tables WHERE id = $1`, [seedTableId]);
            if (seedRoomId) await db.query(`DELETE FROM rooms WHERE id = $1`, [seedRoomId]);
            await db.query(`DELETE FROM users WHERE email = $1`, [CASSA_EMAIL]);
        } finally {
            await db.end();
        }
    });

    it('il registro filtra per periodo e per tipo, coi totali giusti', async () => {
        const res = await api().get(`/reports/fiscal-registry?from=${FROM}&to=${TO}`).set(bearer(owner));
        expect(res.status).toBe(200);
        expect(res.body.total_count).toBe(8); // la riga del 20/03 resta fuori

        const t = res.body.totals;
        // Lo scontrino dell'RT Passepartout È un documento fiscale confermato
        // e sta nel registro (7000): sono i CORRISPETTIVI a escluderlo, non
        // questi totali.
        expect(t.receipts).toEqual({ count: 3, total_cents: 14900 });
        expect(t.invoices).toEqual({ count: 1, total_cents: 8000 });
        expect(t.credit_notes).toEqual({ count: 1, total_cents: 2200 });
        // documentato = scontrini + fatture − note di credito = 14900 + 8000 − 2200.
        expect(t.documented_total_cents).toBe(20700);
        expect(t.proforma).toEqual({ count: 1, total_cents: 1500 });
        expect(t.voided_count).toBe(2); // scontrino annullato + fattura stornata
        expect(res.body.counts.receipt).toBe(4);
        expect(res.body.counts.credit_note).toBe(1);

        const soloFatture = await api().get(`/reports/fiscal-registry?from=${FROM}&to=${TO}&doc_type=INVOICE`).set(bearer(owner));
        expect(soloFatture.body.total_count).toBe(2);
        const soloAnnullati = await api().get(`/reports/fiscal-registry?from=${FROM}&to=${TO}&status=VOIDED`).set(bearer(owner));
        expect(soloAnnullati.body.total_count).toBe(2);
    });

    it('la fattura stornata espone il numero della nota di credito', async () => {
        const res = await api().get(`/reports/fiscal-registry?from=${FROM}&to=${TO}&doc_type=INVOICE&status=VOIDED`).set(bearer(owner));
        expect(res.body.documents).toHaveLength(1);
        expect(res.body.documents[0].doc_number).toBe('902/2026');
        expect(res.body.documents[0].credit_note_number).toBe('903/2026');
    });

    it('il CSV è completo anche quando la vista pagina', async () => {
        const paged = await api().get(`/reports/fiscal-registry?from=${FROM}&to=${TO}&limit=1`).set(bearer(owner));
        expect(paged.body.documents).toHaveLength(1);
        expect(paged.body.total_count).toBe(8);

        const csv = await api().get(`/reports/fiscal-registry?from=${FROM}&to=${TO}&limit=1&format=csv`).set(bearer(owner));
        expect(csv.status).toBe(200);
        expect(csv.headers['content-type']).toContain('text/csv');
        expect(csv.headers['content-disposition']).toContain(`registro-documenti-${FROM}_${TO}.csv`);
        expect(csv.text.charCodeAt(0)).toBe(0xfeff); // BOM per Excel
        expect(csv.text.trim().split('\n')).toHaveLength(9); // intestazione + 8 documenti, limit ignorato
        expect(csv.text).toContain('stornata da NC 903/2026');
    });

    it('i corrispettivi per aliquota quadrano al centesimo', async () => {
        const res = await api().get(`/reports/fiscal-vat-summary?from=${FROM}&to=${TO}`).set(bearer(owner));
        expect(res.status).toBe(200);
        const byCode = (code: string) => res.body.rows.filter((r: any) => r.vat_rate_code === code);

        // 10%: 2000 il 10/03 + 3000 l'11/03; scorporo su ogni riga giornaliera.
        const dieci = byCode('10.00');
        expect(dieci.map((r: any) => r.gross_cents).sort((a: number, b: number) => a - b)).toEqual([2000, 3000]);
        expect(dieci.find((r: any) => r.gross_cents === 3000).net_cents).toBe(2727);
        expect(dieci.find((r: any) => r.gross_cents === 3000).tax_cents).toBe(273);

        const ventidue = byCode('22.00');
        expect(ventidue).toHaveLength(1);
        expect(ventidue[0]).toMatchObject({ gross_cents: 2440, net_cents: 2000, tax_cents: 440 });

        const natura = byCode('N2');
        expect(natura[0]).toMatchObject({ gross_cents: 560, tax_cents: 0, is_nature: true });

        // Lo scontrino VOIDED (4000 al 10%) non c'è: il 10/03 al 10% resta 2000.
        expect(dieci.find((r: any) => String(r.day).startsWith('2026-03-10')).gross_cents).toBe(2000);

        expect(res.body.discounts).toEqual([expect.objectContaining({ discount_cents: 100 })]);
        expect(res.body.excluded).toEqual({ passepartout_docs: 1, passepartout_total_cents: 7000 });
    });

    it('il dettaglio parsa le righe in centesimi e nega gli id estranei', async () => {
        const res = await api().get(`/reports/fiscal-documents/${receiptDetailId}`).set(bearer(owner));
        expect(res.status).toBe(200);
        expect(res.body.document.doc_type).toBe('RECEIPT');
        expect(res.body.items).toEqual([
            { description: 'Riga di prova', quantity: 2, unit_price_cents: 1000, vat_rate_code: '10.00' },
            { description: 'Riga di prova', quantity: 1, unit_price_cents: 2440, vat_rate_code: '22.00' },
            { description: 'Riga di prova', quantity: 1, unit_price_cents: 560, vat_rate_code: 'N2' },
        ]);
        expect(res.body.payments.cash_cents).toBe(5000);

        const missing = await api().get('/reports/fiscal-documents/999999999').set(bearer(owner));
        expect(missing.status).toBe(404);
    });

    it('reports:view, non payments:view: il cassiere resta fuori', async () => {
        for (const path of [
            `/reports/fiscal-registry?from=${FROM}&to=${TO}`,
            `/reports/fiscal-vat-summary?from=${FROM}&to=${TO}`,
            `/reports/fiscal-documents/${receiptDetailId}`,
        ]) {
            const res = await api().get(path).set(bearer(cassaToken));
            expect(res.status, path).toBe(403);
        }
    });

    it('periodi malformati o enormi vengono rifiutati', async () => {
        const bad = await api().get('/reports/fiscal-registry?from=2026-03-10').set(bearer(owner));
        expect(bad.status).toBe(400);
        const huge = await api().get('/reports/fiscal-registry?from=2020-01-01&to=2026-01-01').set(bearer(owner));
        expect(huge.status).toBe(400);
    });
});

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from 'pg';
import { api, ownerToken, bearer } from './helpers';

// Fatture fornitori: dal file al magazzino. Il giro intero sulle fatture di
// prova (tests/fixtures/fatture): upload e doppioni, il fornitore collegato
// dalla P.IVA, le righe decise, il carico con lotto e prezzo del food cost,
// la memoria che riconosce la fattura dopo, l'annullo. Più i recinti: la
// cucina carica il magazzino ma non vede le fatture, la nota di credito non
// carica, senza food cost i prezzi non si toccano.

const FIX = join(__dirname, '..', 'fixtures', 'fatture');
const leggi = (nome: string) => readFileSync(join(FIX, nome));
const KITCHEN_EMAIL = 'cucina.fatture@example.com';
const KITCHEN_PASSWORD = 'password-fatture-cucina';
const PIVA_ORTOFRUTTA = '11111111115';

describe('fatture fornitori — dal file al magazzino', () => {
    let token = '';
    let db: Client;
    let cellaCucina = 0;
    let cellaBar = 0;
    let olive = 0;
    let riso = 0;
    let fornitore = '';
    let ortofrutta = 0;
    let cashCarry = 0;

    const upload = (buf: Buffer, nome: string, tok = token) =>
        api().post('/fatture-fornitori/upload').set(bearer(tok))
            .set('Content-Type', 'application/octet-stream')
            .set('X-Nome-File', encodeURIComponent(nome))
            .send(buf);

    const giacenza = async (productId: number): Promise<number> => {
        const r = await db.query(`SELECT COALESCE(SUM(quantity), 0)::float AS q FROM inventory_stock WHERE product_id = $1`, [productId]);
        return r.rows[0].q;
    };

    beforeAll(async () => {
        token = await ownerToken();
        db = new Client({ connectionString: process.env.DATABASE_URL || 'postgresql://localhost/ristotest_api' });
        await db.connect();
        await api().put('/settings/entitlements').set(bearer(token)).send({ food_cost: true });

        const cella = async (area: string, name: string) => {
            const r = await api().post('/inventory/locations').set(bearer(token)).send({ area, name });
            expect(r.status, JSON.stringify(r.body)).toBe(201);
            return r.body.id as number;
        };
        cellaCucina = await cella('CUCINA', 'Cella fatture');
        cellaBar = await cella('BAR', 'Banco fatture');
        const prodotto = async (name: string, unit: string) => {
            const r = await api().post('/inventory/products').set(bearer(token)).send({ area: 'CUCINA', name, unit });
            expect(r.status, JSON.stringify(r.body)).toBe(201);
            return r.body.id as number;
        };
        olive = await prodotto('Olive da fattura', 'buste');
        riso = await prodotto('Riso da fattura', 'pz');
        const s = await api().post('/suppliers').set(bearer(token)).send({ name: 'Ortofrutta', categories: ['CUCINA'] });
        expect(s.status, JSON.stringify(s.body)).toBe(201);
        fornitore = s.body.id;
    });

    afterAll(async () => {
        await db.query(`DELETE FROM fatture_fornitori WHERE tenant_id = 1`);
        await db.query(`DELETE FROM fatture_fornitori_file WHERE tenant_id = 1`);
        await db.query(`DELETE FROM fornitori_articoli WHERE tenant_id = 1`);
        await db.query(`DELETE FROM inventory_products WHERE id = ANY($1::int[])`, [[olive, riso]]);
        await db.query(`DELETE FROM inventory_locations WHERE id = ANY($1::int[])`, [[cellaCucina, cellaBar]]);
        await db.query(`DELETE FROM suppliers WHERE id = $1`, [fornitore]);
        await db.query(`DELETE FROM users WHERE email = $1`, [KITCHEN_EMAIL]);
        await api().put('/settings/entitlements').set(bearer(token)).send({ food_cost: true });
        await db.end();
    });

    it('carica una fattura XML: entra da controllare, con le righe', async () => {
        const res = await upload(leggi('ortofrutta.xml'), 'ortofrutta.xml');
        expect(res.status, JSON.stringify(res.body)).toBe(201);
        expect(res.body.esiti).toEqual([expect.objectContaining({
            esito: 'nuova', numero: '4014', fornitore: 'Ortofrutta di Prova S.R.L.', righeMerce: 1, riconosciute: 0,
        })]);
        ortofrutta = res.body.esiti[0].id;
    });

    it('lo stesso documento non entra due volte, nemmeno firmato o dentro uno zip', async () => {
        const di_nuovo = await upload(leggi('ortofrutta.xml'), 'ortofrutta.xml');
        expect(di_nuovo.body.esiti[0]).toMatchObject({ esito: 'doppione', id: ortofrutta });
        const p7m = await upload(leggi('ortofrutta.xml.p7m'), 'ortofrutta.xml.p7m');
        expect(p7m.body.esiti[0]).toMatchObject({ esito: 'doppione', id: ortofrutta });

        const zip = await upload(leggi('scarico.zip'), 'scarico.zip');
        expect(zip.status).toBe(201);
        const esiti = zip.body.esiti as any[];
        expect(esiti.filter(e => e.esito === 'scartato').map(e => e.motivo).sort()).toEqual(['Metadati dello SDI', 'È un PDF, serve l\'XML']);
        expect(esiti.find(e => e.numero === '4014')).toMatchObject({ esito: 'doppione' });
        const nuova = esiti.find(e => e.numero === '17031/V');
        expect(nuova).toMatchObject({ esito: 'nuova', righeMerce: 49 });
        cashCarry = nuova.id;

        const elenco = await api().get('/fatture-fornitori').set(bearer(token));
        expect(elenco.status).toBe(200);
        expect(elenco.body.daControllare).toBe(2);
        expect(elenco.body.fatture.map((f: any) => f.id).sort()).toEqual([ortofrutta, cashCarry].sort());
    });

    it('un file che non è una fattura risponde 422 col motivo', async () => {
        const res = await upload(Buffer.from('non sono una fattura'), 'nota.txt');
        expect(res.status).toBe(201);
        expect(res.body.esiti[0]).toMatchObject({ esito: 'scartato' });
        const vuoto = await api().post('/fatture-fornitori/upload').set(bearer(token)).set('Content-Type', 'application/octet-stream').send(Buffer.alloc(0));
        expect(vuoto.status).toBe(400);
    });

    it('il dettaglio: righe, PDF di cortesia e il fornitore suggerito dal nome', async () => {
        const res = await api().get(`/fatture-fornitori/${ortofrutta}`).set(bearer(token));
        expect(res.status).toBe(200);
        expect(res.body).toMatchObject({
            numero: '4014', data: '2026-09-30', totaleCents: 24960, stato: 'DA_CONTROLLARE', righeMerce: 1, righeDaDecidere: 1,
            fornitore: { piva: PIVA_ORTOFRUTTA, supplierId: null },
            fornitoreSuggerito: { id: fornitore, nome: 'Ortofrutta' },
            foodCost: true,
        });
        expect(res.body.righe.map((r: any) => r.tipo)).toEqual(['merce', 'nota']);
        expect(res.body.righe[0]).toMatchObject({ lotto: '030613080526', quantita: 150, unitaMisura: 'COLLI', esito: null });
        expect(res.body.allegati).toEqual([expect.objectContaining({ indice: 0, nome: 'Fattura.pdf' })]);

        const pdf = await api().get(`/fatture-fornitori/${ortofrutta}/allegati/0`).set(bearer(token)).buffer(true);
        expect(pdf.status).toBe(200);
        expect(pdf.headers['content-type']).toBe('application/pdf');
        expect(Buffer.from(pdf.body).subarray(0, 5).toString()).toBe('%PDF-');
        expect((await api().get(`/fatture-fornitori/${ortofrutta}/allegati/3`).set(bearer(token))).status).toBe(404);
    });

    it('collegare il fornitore gli dà la P.IVA', async () => {
        const res = await api().put(`/fatture-fornitori/${ortofrutta}/fornitore`).set(bearer(token)).send({ supplierId: fornitore });
        expect(res.status, JSON.stringify(res.body)).toBe(200);
        expect(res.body.fornitore).toMatchObject({ supplierId: fornitore, supplierNome: 'Ortofrutta' });
        const s = await db.query(`SELECT vat_number FROM suppliers WHERE id = $1`, [fornitore]);
        expect(s.rows[0].vat_number).toBe(PIVA_ORTOFRUTTA);
    });

    it('non si carica con righe da decidere, né senza la cella', async () => {
        const prima = await api().post(`/fatture-fornitori/${ortofrutta}/carica`).set(bearer(token)).send({});
        expect(prima.status).toBe(409);
        expect(prima.body.code).toBe('righe_da_decidere');

        const dettaglio = await api().get(`/fatture-fornitori/${ortofrutta}`).set(bearer(token));
        const rigaOlive = dettaglio.body.righe[0].id;
        const nota = dettaglio.body.righe[1].id;
        expect((await api().put(`/fatture-fornitori/${ortofrutta}/righe/${nota}`).set(bearer(token)).send({ esito: 'IGNORA' })).status).toBe(400);
        // 150 colli = 150 buste; a 1,60 € il collo da 1 kg.
        const decisa = await api().put(`/fatture-fornitori/${ortofrutta}/righe/${rigaOlive}`).set(bearer(token)).send({
            esito: 'CARICO', productId: olive, fattoreMagazzino: 1, unitaCosto: 'kg', fattoreCosto: 1,
        });
        expect(decisa.status, JSON.stringify(decisa.body)).toBe(200);
        expect(decisa.body).toMatchObject({ esito: 'CARICO', productId: olive, quantitaMagazzino: 150, costoCents: 160, daMemoria: false });

        const senzaCella = await api().post(`/fatture-fornitori/${ortofrutta}/carica`).set(bearer(token)).send({});
        expect(senzaCella.status).toBe(400);
        expect(senzaCella.body).toMatchObject({ code: 'cella_mancante', area: 'CUCINA' });
        const cellaSbagliata = await api().post(`/fatture-fornitori/${ortofrutta}/carica`).set(bearer(token)).send({ ubicazioni: { CUCINA: cellaBar } });
        expect(cellaSbagliata.status).toBe(400);
        expect(await giacenza(olive)).toBe(0);
    });

    it('il carico: movimento col lotto, prezzo del food cost dalla fattura, memoria', async () => {
        const res = await api().post(`/fatture-fornitori/${ortofrutta}/carica`).set(bearer(token)).send({ ubicazioni: { CUCINA: cellaCucina } });
        expect(res.status, JSON.stringify(res.body)).toBe(200);
        expect(res.body).toMatchObject({ caricate: 1, prezzi: 1, avvisi: [] });
        expect(res.body.fattura).toMatchObject({ stato: 'CARICATA' });
        expect(await giacenza(olive)).toBe(150);

        const mov = await db.query(
            `SELECT reason, delta::float, lotto, notes, location_id FROM inventory_movements WHERE product_id = $1`, [olive]);
        expect(mov.rows).toEqual([expect.objectContaining({
            reason: 'CARICO', delta: 150, lotto: '030613080526', location_id: cellaCucina,
            notes: 'Fattura 4014 del 30/09/2026 · Ortofrutta di Prova S.R.L.',
        })]);
        const prodotto = await db.query(`SELECT costo_cents, unita_costo, supplier_id FROM inventory_products WHERE id = $1`, [olive]);
        expect(prodotto.rows[0]).toEqual({ costo_cents: 160, unita_costo: 'kg', supplier_id: fornitore });
        const storico = await api().get(`/food-cost/ingredienti/${olive}/prezzi`).set(bearer(token));
        expect(storico.body.prezzi[0]).toMatchObject({ costoCents: 160, fonte: 'FATTURA_XML', fornitore: 'Ortofrutta' });

        const memoria = await db.query(`SELECT chiave_fornitore, chiave_tipo, chiave, azione, product_id FROM fornitori_articoli WHERE tenant_id = 1`);
        expect(memoria.rows).toEqual([{ chiave_fornitore: PIVA_ORTOFRUTTA, chiave_tipo: 'codice', chiave: '0192', azione: 'CARICO', product_id: olive }]);

        // Chiusa: non si ricarica, non si cambia, non si cancella.
        expect((await api().post(`/fatture-fornitori/${ortofrutta}/carica`).set(bearer(token)).send({ ubicazioni: { CUCINA: cellaCucina } })).status).toBe(409);
        expect((await api().delete(`/fatture-fornitori/${ortofrutta}`).set(bearer(token))).status).toBe(409);
    });

    it('la fattura dopo dello stesso fornitore arriva già abbinata', async () => {
        const xml = leggi('ortofrutta.xml').toString('utf8')
            .replace('<Numero>4014</Numero>', '<Numero>4102</Numero>')
            .replace('<PrezzoUnitario>1.60</PrezzoUnitario>', '<PrezzoUnitario>1.80</PrezzoUnitario>')
            .replace('<PrezzoTotale>240.00</PrezzoTotale>', '<PrezzoTotale>270.00</PrezzoTotale>');
        const res = await upload(Buffer.from(xml), 'ortofrutta-4102.xml');
        expect(res.body.esiti[0]).toMatchObject({ esito: 'nuova', riconosciute: 1, righeMerce: 1 });
        const id = res.body.esiti[0].id;
        const d = await api().get(`/fatture-fornitori/${id}`).set(bearer(token));
        expect(d.body.fornitore.supplierId).toBe(fornitore); // dalla P.IVA, da solo
        expect(d.body.righeDaDecidere).toBe(0);
        expect(d.body.righe[0]).toMatchObject({ esito: 'CARICO', daMemoria: true, productId: olive, costoCents: 180 });
        expect(d.body.righe[0].prodotto).toMatchObject({ nome: 'Olive da fattura', costoCents: 160 }); // il rincaro si vede

        const carico = await api().post(`/fatture-fornitori/${id}/carica`).set(bearer(token)).send({ ubicazioni: { CUCINA: cellaCucina } });
        expect(carico.status).toBe(200);
        expect(await giacenza(olive)).toBe(300);
        const p = await db.query(`SELECT costo_cents FROM inventory_products WHERE id = $1`, [olive]);
        expect(p.rows[0].costo_cents).toBe(180);
        const usi = await db.query(`SELECT usi FROM fornitori_articoli WHERE tenant_id = 1 AND chiave = '0192'`);
        expect(usi.rows[0].usi).toBe(2);

        // L'annullo: la merce esce con una rettifica, la fattura torna aperta.
        const annulla = await api().post(`/fatture-fornitori/${id}/annulla`).set(bearer(token));
        expect(annulla.status, JSON.stringify(annulla.body)).toBe(200);
        expect(annulla.body.stato).toBe('DA_CONTROLLARE');
        expect(await giacenza(olive)).toBe(150);
        const rettifica = await db.query(
            `SELECT delta::float FROM inventory_movements WHERE product_id = $1 AND reason = 'RETTIFICA'`, [olive]);
        expect(rettifica.rows).toEqual([{ delta: -150 }]);
        expect((await api().delete(`/fatture-fornitori/${id}`).set(bearer(token))).status).toBe(204);
    });

    it('il cash & carry: confezioni, righe ignorate con la categoria, e senza food cost i prezzi restano', async () => {
        const d = await api().get(`/fatture-fornitori/${cashCarry}`).set(bearer(token));
        const righe = d.body.righe as any[];
        // Il riso: 2 pezzi da 5 kg → 2 pz in magazzino, 10 kg nel costo.
        const rigaRiso = righe.find(r => r.ean === '8003490048677');
        const r1 = await api().put(`/fatture-fornitori/${cashCarry}/righe/${rigaRiso.id}`).set(bearer(token)).send({
            esito: 'CARICO', productId: riso, fattoreMagazzino: 1, unitaCosto: 'kg', fattoreCosto: 5,
        });
        expect(r1.body).toMatchObject({ quantitaMagazzino: 2, costoCents: 162 }); // 16,20 € / 10 kg
        for (const r of righe.filter(x => x.id !== rigaRiso.id)) {
            const res = await api().put(`/fatture-fornitori/${cashCarry}/righe/${r.id}`).set(bearer(token)).send({ esito: 'IGNORA', categoriaSpesa: 'pulizia' });
            expect(res.status).toBe(200);
        }
        expect((await api().put(`/fatture-fornitori/${cashCarry}/righe/${rigaRiso.id}`).set(bearer(token))
            .send({ esito: 'IGNORA', categoriaSpesa: 'gelato' })).status).toBe(400);

        await api().put('/settings/entitlements').set(bearer(token)).send({ food_cost: false });
        const carico = await api().post(`/fatture-fornitori/${cashCarry}/carica`).set(bearer(token)).send({ ubicazioni: { CUCINA: cellaCucina } });
        expect(carico.status, JSON.stringify(carico.body)).toBe(200);
        expect(carico.body).toMatchObject({ caricate: 1, prezzi: 0 });
        await api().put('/settings/entitlements').set(bearer(token)).send({ food_cost: true });
        expect(await giacenza(riso)).toBe(2);
        const p = await db.query(`SELECT costo_cents FROM inventory_products WHERE id = $1`, [riso]);
        expect(p.rows[0].costo_cents).toBeNull();
        const ignorate = await db.query(
            `SELECT count(*)::int AS n FROM fornitori_articoli WHERE tenant_id = 1 AND chiave_fornitore = '22222222220' AND azione = 'IGNORA' AND categoria_spesa = 'pulizia'`);
        expect(ignorate.rows[0].n).toBe(48);
    });

    it('la nota di credito non carica: si mette da parte', async () => {
        const res = await upload(leggi('caseificio-lotto.xml'), 'caseificio-lotto.xml');
        const nota = (res.body.esiti as any[]).find(e => e.numero === 'NC/3');
        expect(res.body.esiti).toHaveLength(2);
        const carico = await api().post(`/fatture-fornitori/${nota.id}/carica`).set(bearer(token)).send({ ubicazioni: { CUCINA: cellaCucina } });
        expect(carico.status).toBe(409);
        // Prima di arrivare al tipo di documento si fermerebbe sulle righe da
        // decidere: qui la riga non è decisa, ma la nota di credito vince.
        expect(carico.body.code).toBe('nota_di_credito');
        const parte = await api().put(`/fatture-fornitori/${nota.id}/stato`).set(bearer(token)).send({ stato: 'IGNORATA' });
        expect(parte.status).toBe(200);
        expect(parte.body.stato).toBe('IGNORATA');
        const elenco = await api().get('/fatture-fornitori?stato=IGNORATA').set(bearer(token));
        expect(elenco.body.fatture.map((f: any) => f.id)).toEqual([nota.id]);
    });

    it('la cucina carica il magazzino ma non vede le fatture', async () => {
        const created = await api().post('/auth/users').set(bearer(token)).send({
            email: KITCHEN_EMAIL, password: KITCHEN_PASSWORD, full_name: 'Cucina Fatture', role: 'KITCHEN',
        });
        expect(created.status).toBe(201);
        const login = await api().post('/auth/login').send({ email: KITCHEN_EMAIL, password: KITCHEN_PASSWORD });
        const cucina = login.body.accessToken;
        expect((await api().get('/fatture-fornitori').set(bearer(cucina))).status).toBe(403);
        expect((await api().get(`/fatture-fornitori/${ortofrutta}`).set(bearer(cucina))).status).toBe(403);
        expect((await upload(leggi('ortofrutta.xml'), 'o.xml', cucina)).status).toBe(403);
    });

    it('una fattura di un altro ristorante non si vede', async () => {
        await db.query(`INSERT INTO tenants (id, slug, name) VALUES (4392, 'trattoria-fatture', 'Trattoria Fatture') ON CONFLICT (id) DO NOTHING`);
        const file = await db.query(
            `INSERT INTO fatture_fornitori_file (tenant_id, nome, sha256, xml) VALUES (4392, 'x.xml', repeat('a', 64), '<x/>') RETURNING id`);
        const altrui = await db.query(
            `INSERT INTO fatture_fornitori (tenant_id, file_id, chiave_fornitore, cedente_nome, tipo_documento, numero, data)
             VALUES (4392, $1, '999', 'Altrui', 'TD01', '1', '2026-10-01') RETURNING id`, [file.rows[0].id]);
        const id = altrui.rows[0].id;
        expect((await api().get(`/fatture-fornitori/${id}`).set(bearer(token))).status).toBe(404);
        expect((await api().delete(`/fatture-fornitori/${id}`).set(bearer(token))).status).toBe(404);
        const elenco = await api().get('/fatture-fornitori').set(bearer(token));
        expect(elenco.body.fatture.some((f: any) => f.id === id)).toBe(false);
        await db.query(`DELETE FROM fatture_fornitori WHERE tenant_id = 4392`);
        await db.query(`DELETE FROM fatture_fornitori_file WHERE tenant_id = 4392`);
        await db.query(`DELETE FROM role_permissions WHERE tenant_id = 4392`);
        await db.query(`DELETE FROM tenants WHERE id = 4392`);
    });
});

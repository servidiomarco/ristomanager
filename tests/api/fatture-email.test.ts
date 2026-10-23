import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Client } from 'pg';
import http from 'node:http';
import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { api, ownerToken, bearer } from './helpers';
// Il sorgente, non dist: l'indirizzo è fatto di funzioni pure.
import { allegatoFattura, indirizzoFatture, slugPerIndirizzo, tokenDaDestinatari } from '../../utils/fattureEmail';

// Fatture via email (PR 3): ogni locale ha un indirizzo suo, Resend chiama il
// webhook `email.received`, gli allegati diventano fatture «da controllare» e
// quelle di un fornitore col carico automatico, con tutte le righe note, si
// caricano da sole. Resend è uno stub sulla porta del server + 15
// (RESEND_FATTURE_API_URL in globalSetup).

const dbUrl = () => process.env.DATABASE_URL || 'postgresql://localhost/ristotest_api';
const STUB_PORT = Number(process.env.TEST_API_PORT || 3199) + 15;
const SEGRETO = Buffer.from('test-fatture-webhook-secret');
const FIXTURES = path.join(process.cwd(), 'tests', 'fixtures', 'fatture');
const leggi = (nome: string) => readFileSync(path.join(FIXTURES, nome));
const PIVA_ORTOFRUTTA = '11111111115';

describe('fatture via email: l\'indirizzo', () => {
    it('slug, token e dominio; lo slug si pulisce', () => {
        expect(indirizzoFatture('vecchiofrantoio', 'abc123def456', 'Fatture.Sympotia.com'))
            .toBe('vecchiofrantoio-abc123def456@fatture.sympotia.com');
        expect(slugPerIndirizzo('Il Vecchio  Frantoio!')).toBe('il-vecchio-frantoio');
        expect(slugPerIndirizzo('')).toBe('fatture');
        expect(slugPerIndirizzo('a'.repeat(50)).length).toBe(30);
    });

    it('il token si legge dai destinatari del nostro dominio, con nome o col +', () => {
        expect(tokenDaDestinatari([
            'Fatture Frantoio <vecchiofrantoio-abc123def456@fatture.sympotia.com>',
            'altro-xyz789xyz789@altrodominio.it',
            'pizzeria-0011223344aa+mollo@FATTURE.sympotia.com',
            'corto-abc@fatture.sympotia.com',
            42,
        ], 'fatture.sympotia.com')).toEqual(['abc123def456', '0011223344aa']);
    });

    it('quali allegati si aprono', () => {
        expect(allegatoFattura('IT01234567890_0001.xml')).toBe(true);
        expect(allegatoFattura('fattura.XML.p7m')).toBe(true);
        expect(allegatoFattura('marzo.zip')).toBe(true);
        expect(allegatoFattura('allegato', 'application/xml')).toBe(true);
        expect(allegatoFattura('fattura.pdf', 'application/pdf')).toBe(false);
    });
});

describe('fatture via email', () => {
    let token = '';
    let db: Client;
    let stub: http.Server;
    let indirizzo = '';
    let cella = 0;
    let olive = 0;
    // Le email che lo stub di Resend conosce: id → allegati.
    const email = new Map<string, { nome: string; tipo: string; dati: Buffer }[]>();
    const richiesteSenzaChiave: string[] = [];

    const firma = (corpo: string, id = `msg_${Date.now()}_${Math.random()}`) => {
        const ts = String(Math.floor(Date.now() / 1000));
        const sig = createHmac('sha256', SEGRETO).update(`${id}.${ts}.${corpo}`).digest('base64');
        return { 'svix-id': id, 'svix-timestamp': ts, 'svix-signature': `v1,${sig}` };
    };
    const webhook = (emailId: string, to: string[], opzioni: { firmaSbagliata?: boolean; receivedFor?: string[] } = {}) => {
        const corpo = JSON.stringify({
            type: 'email.received',
            created_at: new Date().toISOString(),
            data: {
                email_id: emailId, from: 'Studio Rossi <studio@example.it>', to, subject: 'Fatture di ottobre',
                ...(opzioni.receivedFor ? { received_for: opzioni.receivedFor } : {}),
            },
        });
        const h = firma(corpo);
        if (opzioni.firmaSbagliata) h['svix-signature'] = 'v1,AAAA';
        return api().post('/webhook/fatture-email').set(h).set('Content-Type', 'application/json').send(corpo);
    };
    const righeLog = async () =>
        (await db.query(`SELECT resend_id, esito FROM fatture_email_ricevute WHERE tenant_id = 1 ORDER BY id`)).rows;
    // Il webhook risponde prima di lavorare: si aspetta che la riga del
    // registro abbia il suo esito.
    const aspettaEsito = async (emailId: string) => {
        for (let i = 0; i < 50; i++) {
            const r = await db.query(
                `SELECT esito FROM fatture_email_ricevute WHERE tenant_id = 1 AND resend_id = $1 AND esito <> '[]'::jsonb`, [emailId]);
            if (r.rowCount) return r.rows[0].esito as any[];
            await new Promise(res => setTimeout(res, 100));
        }
        throw new Error(`nessun esito per ${emailId}`);
    };

    beforeAll(async () => {
        token = await ownerToken();
        db = new Client({ connectionString: dbUrl() });
        await db.connect();

        stub = http.createServer((req, res) => {
            const url = req.url ?? '';
            if (req.headers.authorization !== 'Bearer test-resend-fatture-key' && !url.startsWith('/download/')) {
                richiesteSenzaChiave.push(url);
                res.writeHead(401).end();
                return;
            }
            const lista = url.match(/^\/emails\/receiving\/([^/]+)\/attachments$/);
            if (lista) {
                const allegati = email.get(decodeURIComponent(lista[1])) ?? [];
                res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({
                    object: 'list',
                    has_more: false,
                    data: allegati.map((a, i) => ({
                        id: `att_${i}`, filename: a.nome, size: a.dati.length, content_type: a.tipo,
                        download_url: `http://127.0.0.1:${STUB_PORT}/download/${encodeURIComponent(lista[1])}/${i}`,
                        expires_at: new Date(Date.now() + 3600_000).toISOString(),
                    })),
                }));
                return;
            }
            const scarica = url.match(/^\/download\/([^/]+)\/(\d+)$/);
            if (scarica) {
                const a = email.get(decodeURIComponent(scarica[1]))?.[Number(scarica[2])];
                if (!a) { res.writeHead(404).end(); return; }
                res.writeHead(200, { 'Content-Type': a.tipo }).end(a.dati);
                return;
            }
            res.writeHead(404).end();
        });
        await new Promise<void>(r => stub.listen(STUB_PORT, '127.0.0.1', () => r()));

        const loc = await api().post('/inventory/locations').set(bearer(token)).send({ area: 'CUCINA', name: 'Cella fatture email', sort_order: 9 });
        expect(loc.status).toBe(201);
        cella = loc.body.id;
        const p = await api().post('/inventory/products').set(bearer(token)).send({ area: 'CUCINA', name: 'Olive da email', unit: 'buste' });
        expect(p.status).toBe(201);
        olive = p.body.id;
    });

    afterAll(async () => {
        await new Promise<void>(r => stub.close(() => r()));
        try {
            // Prima i movimenti dei carichi (fattura_riga_id li lega alle righe),
            // poi le fatture: il file dopo dei test sulle fatture deve
            // ritrovare la 4014 come nuova.
            await db.query(`DELETE FROM inventory_movements WHERE product_id = $1`, [olive]);
            await db.query(`DELETE FROM fatture_fornitori WHERE tenant_id = 1 AND chiave_fornitore LIKE $1`, [`%${PIVA_ORTOFRUTTA}%`]);
            await db.query(`DELETE FROM fatture_fornitori_file WHERE tenant_id = 1 AND id NOT IN (SELECT file_id FROM fatture_fornitori WHERE tenant_id = 1)`);
            await db.query(`DELETE FROM fornitori_articoli WHERE tenant_id = 1 AND chiave_fornitore LIKE $1`, [`%${PIVA_ORTOFRUTTA}%`]);
            await db.query(`DELETE FROM fornitori_carico_automatico WHERE tenant_id = 1`);
            await db.query(`DELETE FROM fatture_email_ricevute WHERE tenant_id = 1`);
            await db.query(`DELETE FROM notifications WHERE tag LIKE 'fatture-email-%'`);
            await db.query(`DELETE FROM inventory_products WHERE id = $1`, [olive]);
            await db.query(`DELETE FROM inventory_locations WHERE id = $1`, [cella]);
            await db.query(`UPDATE tenants SET fatture_email_token = NULL WHERE id = 1`);
        } finally {
            await db.end();
        }
    });

    it('il locale ha il suo indirizzo, sempre lo stesso', async () => {
        const res = await api().get('/fatture-fornitori/email').set(bearer(token));
        expect(res.status).toBe(200);
        expect(res.body.attivo).toBe(true);
        expect(res.body.indirizzo).toMatch(/^[a-z0-9-]+-[a-z0-9]{12}@fatture\.test\.local$/);
        indirizzo = res.body.indirizzo;
        expect((await api().get('/fatture-fornitori/email').set(bearer(token))).body.indirizzo).toBe(indirizzo);
    });

    it('un webhook senza firma giusta: 401, e niente registro', async () => {
        email.set('em_firma', [{ nome: 'ortofrutta.xml', tipo: 'application/xml', dati: leggi('ortofrutta.xml') }]);
        const res = await webhook('em_firma', [indirizzo], { firmaSbagliata: true });
        expect(res.status).toBe(401);
        expect(await righeLog()).toEqual([]);
    });

    it('l\'email inoltrata: la fattura entra da controllare, il PDF accanto si ignora', async () => {
        email.set('em_1', [
            { nome: 'IT01234567890_4014.xml', tipo: 'application/xml', dati: leggi('ortofrutta.xml') },
            { nome: 'copia di cortesia.pdf', tipo: 'application/pdf', dati: Buffer.from('%PDF-1.4 finto') },
        ]);
        const res = await webhook('em_1', [`Fatture <${indirizzo}>`, 'altro@example.it']);
        expect(res.status).toBe(200);
        const esito = await aspettaEsito('em_1');
        expect(esito).toEqual(expect.arrayContaining([
            expect.objectContaining({ esito: 'nuova', numero: '4014', fornitore: 'Ortofrutta di Prova S.R.L.' }),
            expect.objectContaining({ file: 'copia di cortesia.pdf', esito: 'scartato' }),
        ]));
        expect(richiesteSenzaChiave).toEqual([]);

        const elenco = await api().get('/fatture-fornitori').set(bearer(token));
        const f = elenco.body.fatture.find((x: any) => x.numero === '4014');
        expect(f).toMatchObject({ stato: 'DA_CONTROLLARE', origine: 'EMAIL' });

        const pagina = await api().get('/fatture-fornitori/email').set(bearer(token));
        expect(pagina.body.ricevute[0]).toMatchObject({ mittente: 'studio@example.it', allegati: 2 });

        const avviso = await db.query(
            `SELECT title, body FROM notifications WHERE tenant_id = 1 AND tag LIKE 'fatture-email-%' ORDER BY id DESC LIMIT 1`);
        expect(avviso.rows[0]).toMatchObject({ title: 'Fattura da controllare' });
        expect(avviso.rows[0].body).toContain('n. 4014');
    });

    it('lo stesso webhook ripetuto da Resend non importa due volte', async () => {
        const res = await webhook('em_1', [indirizzo]);
        expect(res.status).toBe(200);
        await new Promise(r => setTimeout(r, 400));
        expect((await righeLog()).filter(r => r.resend_id === 'em_1')).toHaveLength(1);
    });

    it('carico a mano con «le prossime caricale da sole», poi la fattura dopo si carica da sola', async () => {
        const elenco = await api().get('/fatture-fornitori').set(bearer(token));
        const id = elenco.body.fatture.find((x: any) => x.numero === '4014').id;
        const d = await api().get(`/fatture-fornitori/${id}`).set(bearer(token));
        expect(d.body.caricoAutomatico).toBeNull();
        const riga = d.body.righe.find((r: any) => r.tipo === 'merce').id;
        const decisa = await api().put(`/fatture-fornitori/${id}/righe/${riga}`).set(bearer(token))
            .send({ esito: 'CARICO', productId: olive, fattoreMagazzino: 1 });
        expect(decisa.status, JSON.stringify(decisa.body)).toBe(200);
        const carico = await api().post(`/fatture-fornitori/${id}/carica`).set(bearer(token))
            .send({ ubicazioni: { CUCINA: cella }, caricoAutomatico: true });
        expect(carico.status, JSON.stringify(carico.body)).toBe(200);
        expect(carico.body.fattura.caricoAutomatico).toEqual({ attivo: true, ubicazioni: { CUCINA: cella } });

        // La fattura dopo: stesso fornitore, stessa merce, numero nuovo.
        const xml = leggi('ortofrutta.xml').toString('utf8').replace('<Numero>4014</Numero>', '<Numero>4015</Numero>');
        email.set('em_2', [{ nome: 'IT01234567890_4015.xml', tipo: 'text/xml', dati: Buffer.from(xml, 'utf8') }]);
        expect((await webhook('em_2', [indirizzo])).status).toBe(200);
        const esito = await aspettaEsito('em_2');
        expect(esito).toEqual([expect.objectContaining({ esito: 'nuova', numero: '4015', caricata: true })]);

        const f = (await api().get('/fatture-fornitori?stato=CARICATA').set(bearer(token))).body.fatture.find((x: any) => x.numero === '4015');
        expect(f).toMatchObject({ stato: 'CARICATA', origine: 'EMAIL', caricataDa: 'Carico automatico' });
        const giacenza = await db.query(`SELECT COALESCE(SUM(quantity), 0)::float AS q FROM inventory_stock WHERE product_id = $1`, [olive]);
        expect(giacenza.rows[0].q).toBe(300);
        const avviso = await db.query(
            `SELECT title FROM notifications WHERE tenant_id = 1 AND tag LIKE 'fatture-email-%' ORDER BY id DESC LIMIT 1`);
        expect(avviso.rows[0].title).toBe('Fattura caricata in magazzino');
    });

    it('carico automatico spento: la fattura dopo aspetta', async () => {
        const id = (await api().get('/fatture-fornitori?stato=CARICATA').set(bearer(token))).body.fatture.find((x: any) => x.numero === '4015').id;
        const spento = await api().put(`/fatture-fornitori/${id}/carico-automatico`).set(bearer(token)).send({ attivo: false });
        expect(spento.status, JSON.stringify(spento.body)).toBe(200);
        expect(spento.body.caricoAutomatico).toEqual({ attivo: false, ubicazioni: { CUCINA: cella } });

        const xml = leggi('ortofrutta.xml').toString('utf8').replace('<Numero>4014</Numero>', '<Numero>4016</Numero>');
        email.set('em_3', [{ nome: '4016.xml', tipo: 'application/xml', dati: Buffer.from(xml, 'utf8') }]);
        expect((await webhook('em_3', [indirizzo])).status).toBe(200);
        expect(await aspettaEsito('em_3')).toEqual([expect.objectContaining({ esito: 'nuova', numero: '4016' })]);
        const f = (await api().get('/fatture-fornitori').set(bearer(token))).body.fatture.find((x: any) => x.numero === '4016');
        expect(f.stato).toBe('DA_CONTROLLARE');
    });

    it('inoltro automatico: «A» è la casella del commercialista, il nostro indirizzo sta in received_for', async () => {
        const xml = leggi('ortofrutta.xml').toString('utf8').replace('<Numero>4014</Numero>', '<Numero>4017</Numero>');
        email.set('em_inoltro', [{ nome: '4017.xml', tipo: 'application/xml', dati: Buffer.from(xml, 'utf8') }]);
        const res = await webhook('em_inoltro', ['studio@example.it'], { receivedFor: [indirizzo] });
        expect(res.status).toBe(200);
        expect(await aspettaEsito('em_inoltro')).toEqual([expect.objectContaining({ esito: 'nuova', numero: '4017' })]);
    });

    it('solo il PDF: si annota perché non entra', async () => {
        email.set('em_pdf', [{ nome: 'fattura.pdf', tipo: 'application/pdf', dati: Buffer.from('%PDF-1.7 finto') }]);
        expect((await webhook('em_pdf', [indirizzo])).status).toBe(200);
        expect(await aspettaEsito('em_pdf')).toEqual([expect.objectContaining({ esito: 'scartato', motivo: 'È un PDF, serve l\'XML' })]);
    });

    it('indirizzo cambiato: il vecchio non porta più fatture', async () => {
        const vecchio = indirizzo;
        const nuovo = await api().post('/fatture-fornitori/email/rigenera').set(bearer(token));
        expect(nuovo.status).toBe(200);
        expect(nuovo.body.indirizzo).not.toBe(vecchio);
        indirizzo = nuovo.body.indirizzo;

        email.set('em_vecchio', [{ nome: 'ortofrutta.xml', tipo: 'application/xml', dati: leggi('ortofrutta.xml') }]);
        expect((await webhook('em_vecchio', [vecchio])).status).toBe(200);
        await new Promise(r => setTimeout(r, 400));
        expect((await righeLog()).some(r => r.resend_id === 'em_vecchio')).toBe(false);
    });

    it('la cucina carica il magazzino ma non vede l\'indirizzo delle fatture', async () => {
        const created = await api().post('/auth/users').set(bearer(token))
            .send({ email: 'cuoco.fatture.email@test.local', password: 'Fatture-Email-2026!', full_name: 'Cuoco Email', role: 'KITCHEN' });
        expect(created.status).toBe(201);
        try {
            const s = await api().post('/auth/login').send({ email: 'cuoco.fatture.email@test.local', password: 'Fatture-Email-2026!' });
            expect((await api().get('/fatture-fornitori/email').set(bearer(s.body.accessToken))).status).toBe(403);
        } finally {
            await db.query(`DELETE FROM users WHERE id = $1`, [created.body.id]);
        }
    });
});

// Collaudo delle API Openapi (invoice.openapi.com) in SANDBOX: scontrino
// elettronico (e-receipt) e fattura elettronica (SDI). Non tocca il database
// né il server: parla direttamente con la sandbox usando gli stessi builder
// di produzione (dist/services/fiscalService.js — serve `npm run build:server`).
//
// Il token NON viene mai stampato: si legge da .env (OPENAPI_INVOICE_TOKEN)
// e finisce solo nell'header Authorization.
//
// Uso (dalla root del progetto):
//   node scripts/collaudo-fiscale.mjs probe               # che endpoint vede il token
//   node scripts/collaudo-fiscale.mjs config              # lista/crea la IT-configuration di test
//   node scripts/collaudo-fiscale.mjs scontrino           # emette un documento commerciale di prova
//   node scripts/collaudo-fiscale.mjs stato <id>          # stato di un documento emesso
//   node scripts/collaudo-fiscale.mjs annullo <id>        # annulla un documento emesso
//   node scripts/collaudo-fiscale.mjs fattura             # valida e invia una FatturaPA di prova
//   node scripts/collaudo-fiscale.mjs all                 # sequenza completa di collaudo
//   node scripts/collaudo-fiscale.mjs webhook <url>       # registra il callback esiti nella configurazione

import { readFileSync } from 'node:fs';
import { buildEReceiptPayload, buildFatturaPaXml } from '../dist/services/fiscalService.js';

// --- env: parse minimale di .env (niente dotenv: lo script gira anche fuori da npm)
const envText = (() => { try { return readFileSync(new URL('../.env', import.meta.url), 'utf8'); } catch { return ''; } })();
for (const line of envText.split('\n')) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
}

const BASE = (process.env.OPENAPI_INVOICE_BASE_URL || 'https://test.invoice.openapi.com').replace(/\/$/, '');
const TOKEN = process.env.OPENAPI_INVOICE_TOKEN;
if (!TOKEN) { console.error('OPENAPI_INVOICE_TOKEN mancante in .env'); process.exit(1); }
if (!BASE.includes('test.')) {
    console.error(`ATTENZIONE: base URL non-sandbox (${BASE}). Questo script è solo per il collaudo: rifiuto.`);
    process.exit(1);
}
console.log(`Sandbox: ${BASE}\n`);

// P.IVA della IT-configuration sandbox già creata su console.openapi.com
// ("ristomanager sandbox", e_receipts + customer_invoice attivi). La sandbox
// simula la comunicazione con AdE, nessun dato arriva a sistemi reali.
const TEST_VAT = process.env.OPENAPI_COLLAUDO_FISCAL_ID || '88806881905';
const SELLER = {
    vat_number: TEST_VAT,
    business_name: 'Ristorante Collaudo SRL',
    regime: 'RF01',
    address: { street: 'Via delle Prove 1', zip: '00100', city: 'Roma', province: 'RM' },
};

async function call(method, path, body, contentType = 'application/json') {
    const res = await fetch(`${BASE}${path}`, {
        method,
        headers: { 'Authorization': `Bearer ${TOKEN}`, ...(body != null ? { 'Content-Type': contentType } : {}) },
        body: body == null ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)),
    });
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* body non-JSON */ }
    return { status: res.status, json, text };
}

const show = (label, r) => {
    console.log(`\n== ${label} → HTTP ${r.status}`);
    console.log(r.json ? JSON.stringify(r.json, null, 2).slice(0, 3000) : r.text.slice(0, 1000));
};

// --- comandi -----------------------------------------------------------------

async function probe() {
    // GET sugli endpoint candidati: dice quali percorsi esistono e che scope
    // copre il token (401/403 = fuori scope, 200 = ok).
    for (const p of ['/IT-configurations', '/IT-e-receipts', '/IT-receipts', '/IT-invoices']) {
        const r = await call('GET', p);
        const hint = r.json?.message ?? r.json?.error ?? '';
        console.log(`GET ${p.padEnd(20)} → ${r.status}  ${typeof hint === 'string' ? hint.slice(0, 120) : ''}`);
    }
}

async function config() {
    const list = await call('GET', '/IT-configurations');
    show('GET /IT-configurations', list);
    const rows = Array.isArray(list.json?.data) ? list.json.data : [];
    const mine = rows.find(c => String(c.fiscal_id ?? c.vat_number ?? '') === TEST_VAT);
    if (mine) { console.log(`\nConfigurazione per ${TEST_VAT} già presente.`); return mine; }

    const create = await call('POST', '/IT-configurations', {
        fiscal_id: TEST_VAT,
        name: SELLER.business_name,
        email: 'collaudo@example.com',
        receipts: true,          // abilita il canale scontrino (richiesto dai docs)
        invoices: true,
        // In sandbox le credenziali AdE del delegato non servono (simulate).
    });
    show('POST /IT-configurations', create);
    return create.json?.data ?? null;
}

// Conto tipo da ristorante: 2 coperti, 3 righe, pagamento misto contanti+POS.
function samplePayload() {
    return buildEReceiptPayload({
        fiscalId: TEST_VAT,
        totalCents: 6550, // 65.50 €
        items: [
            { name: 'Coperto', qty: 2, unit_price_cents: 250, vat_rate: 10 },
            { name: 'Tagliolini al tartufo', qty: 2, unit_price_cents: 1800, vat_rate: 10 },
            { name: 'Bottiglia Verdicchio', qty: 1, unit_price_cents: 2450, vat_rate: 22 },
        ],
        payments: [
            { method: 'CONTANTI', amount_cents: 3000 },
            { method: 'POS_FISICO', amount_cents: 3550 },
        ],
        depositCreditCents: 0,
        fallbackVatRate: 10,
    });
}

async function scontrino() {
    const payload = samplePayload();
    console.log('Payload documento commerciale:\n' + JSON.stringify(payload, null, 2));
    // Prova prima il percorso usato dal driver, poi quello dei docs pubblici:
    // il collaudo serve proprio a scoprire quale dei due è vivo in sandbox.
    for (const path of ['/IT-e-receipts', '/IT-receipts']) {
        const r = await call('POST', path, payload);
        show(`POST ${path}`, r);
        if (r.status < 400) {
            const id = r.json?.data?.id;
            if (id) {
                const st = await call('GET', `${path}/${encodeURIComponent(id)}`);
                show(`GET ${path}/${id}`, st);
            }
            return { path, id };
        }
    }
    return null;
}

async function stato(id) {
    for (const path of ['/IT-e-receipts', '/IT-receipts']) {
        const r = await call('GET', `${path}/${encodeURIComponent(id)}`);
        if (r.status !== 404) { show(`GET ${path}/${id}`, r); return; }
    }
    console.log('Documento non trovato su nessun percorso.');
}

async function annullo(id) {
    for (const path of ['/IT-e-receipts', '/IT-receipts']) {
        const r = await call('DELETE', `${path}/${encodeURIComponent(id)}`);
        if (r.status !== 404) { show(`DELETE ${path}/${id}`, r); return; }
    }
    console.log('Documento non trovato su nessun percorso.');
}

function sampleXml() {
    // Fattura B2C a persona fisica (via cassetto fiscale, SDI 0000000):
    // scorporo IVA del conto da 65.50 € — 41.00 lordi al 10% + 24.50 al 22%.
    return buildFatturaPaXml({
        seller: SELLER,
        buyer: {
            name: 'Mario Rossi',
            tax_code: 'RSSMRA80A01H501U',
            sdi_code: '0000000',
            address: { street: 'Via del Collaudo 2', zip: '20100', city: 'Milano', province: 'MI' },
        },
        doc_number: 'COLLAUDO-1',
        doc_date: new Date().toISOString().slice(0, 10),
        vat_rows: [
            { rate: 10, net_cents: 3727, vat_cents: 373, gross_cents: 4100 },
            { rate: 22, net_cents: 2008, vat_cents: 442, gross_cents: 2450 },
        ],
        total_gross_cents: 6550,
        description: 'Somministrazione alimenti e bevande — collaudo sandbox',
    });
}

async function fattura() {
    const xml = sampleXml();
    console.log('XML FatturaPA generato (' + xml.length + ' byte)');
    // Prima la validazione formale (se l'endpoint esiste), poi l'invio vero.
    const val = await call('POST', '/IT-invoices_validate', xml, 'application/xml');
    show('POST /IT-invoices_validate (XML)', val);
    const r = await call('POST', '/IT-invoices', xml, 'application/xml');
    show('POST /IT-invoices (XML)', r);
    if (r.status >= 400) {
        // Alcune versioni dell'API vogliono un JSON con l'XML incapsulato:
        // secondo tentativo per scoprire il contratto reale.
        const rJson = await call('POST', '/IT-invoices', { fiscal_id: TEST_VAT, invoice: Buffer.from(xml).toString('base64') });
        show('POST /IT-invoices (JSON+base64)', rJson);
        return rJson.json?.data ?? null;
    }
    const id = r.json?.data?.id ?? r.json?.data?.uuid;
    if (id) {
        const st = await call('GET', `/IT-invoices/${encodeURIComponent(id)}`);
        show(`GET /IT-invoices/${id}`, st);
    }
    return r.json?.data ?? null;
}

// Registra l'URL del webhook esiti nella IT-configuration (sandbox o prod:
// dipende dalla base URL). L'URL è quello di GET /settings/webhook-info
// (esempio openapi_fiscale) — deve essere raggiungibile da Openapi, quindi
// in locale serve un tunnel; il comando serve soprattutto per la produzione.
async function webhook(url) {
    if (!/^https:\/\//.test(url)) { console.error('Serve un URL https raggiungibile da Openapi'); process.exit(1); }
    const events = ['customer-invoice', 'receipt', 'receipt-error'];
    const r = await call('PATCH', `/IT-configurations/${TEST_VAT}`, {
        api_configurations: events.map(event => ({ event, callback: { method: 'JSON', url } })),
    });
    show(`PATCH /IT-configurations/${TEST_VAT} (webhook → ${url})`, r);
}

// --- dispatch ----------------------------------------------------------------

const [cmd, arg] = process.argv.slice(2);
switch (cmd) {
    case 'probe': await probe(); break;
    case 'config': await config(); break;
    case 'scontrino': await scontrino(); break;
    case 'stato': if (!arg) { console.error('serve <id>'); process.exit(1); } await stato(arg); break;
    case 'annullo': if (!arg) { console.error('serve <id>'); process.exit(1); } await annullo(arg); break;
    case 'fattura': await fattura(); break;
    case 'webhook': if (!arg) { console.error('serve <url>'); process.exit(1); } await webhook(arg); break;
    case 'all': {
        await probe();
        await config();
        const doc = await scontrino();
        if (doc?.id) await annullo(doc.id);
        await fattura();
        break;
    }
    default:
        console.log('Comandi: probe | config | scontrino | stato <id> | annullo <id> | fattura | webhook <url> | all');
        process.exit(1);
}

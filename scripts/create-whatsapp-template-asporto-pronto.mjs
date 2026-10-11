#!/usr/bin/env node
// Crea (idempotente) e sottomette a Meta il template «ordine d'asporto
// pronto» (TAKEAWAY_READY nel catalogo, services/whatsapp/takeawayReady.ts):
// serve solo fuori dalla finestra di 24 ore, dentro parte un testo libero.
//
// Forma: twilio/text, {{1}} nome, {{2}} numero d'ordine del giorno, {{3}}
// nome del locale.
//
// Meta rifiuta un template che inizia o finisce con una variabile: «{{3}}.»
// conta come fine, per questo dopo il nome del locale c'è un saluto. La prima
// versione (takeaway_ready_it/_en, 11/10) è stata rifiutata così, e i nomi
// rifiutati restano occupati: da qui il suffisso _v2.
//
// L'approvazione Meta richiede ore o giorni. Finché la SID non è su Railway
// (TWILIO_WA_CONTENT_SID_TAKEAWAY_READY[_EN]) l'avviso parte solo dentro la
// finestra di 24 ore.
//
// Uso (serve l'ambiente con le credenziali Twilio):
//   railway run --service ristomanager node scripts/create-whatsapp-template-asporto-pronto.mjs [--dry-run]

const API_BASE = 'https://content.twilio.com/v1';
const accountSid = process.env.TWILIO_ACCOUNT_SID;
const authToken = process.env.TWILIO_AUTH_TOKEN;
const dryRun = process.argv.includes('--dry-run');

if (!accountSid || !authToken) {
    console.error('Mancano TWILIO_ACCOUNT_SID e/o TWILIO_AUTH_TOKEN.');
    process.exit(2);
}

const auth = 'Basic ' + Buffer.from(`${accountSid}:${authToken}`).toString('base64');
const headers = { Authorization: auth, 'Content-Type': 'application/json' };

const TEMPLATES = [
    {
        friendlyName: 'takeaway_ready_v2_it',
        envKey: 'TWILIO_WA_CONTENT_SID_TAKEAWAY_READY',
        language: 'it',
        body: 'Ciao {{1}}! Il tuo ordine d\'asporto n. {{2}} è pronto: ti aspettiamo da {{3}}. A presto!',
    },
    {
        friendlyName: 'takeaway_ready_v2_en',
        envKey: 'TWILIO_WA_CONTENT_SID_TAKEAWAY_READY_EN',
        language: 'en',
        body: 'Hi {{1}}! Your takeaway order no. {{2}} is ready: see you at {{3}}. Thank you!',
    },
];

const sampleVariables = () => ({ '1': 'Mario', '2': '12', '3': 'Vecchio Frantoio' });

async function listAllContent() {
    const all = [];
    let url = `${API_BASE}/Content?PageSize=1000`;
    while (url) {
        const res = await fetch(url, { headers });
        if (!res.ok) throw new Error(`GET Content fallita: ${res.status} ${await res.text()}`);
        const body = await res.json();
        all.push(...(body.contents ?? []));
        url = body.meta?.next_page_url || null;
    }
    return all;
}

async function createContent(tpl) {
    const res = await fetch(`${API_BASE}/Content`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
            friendly_name: tpl.friendlyName,
            language: tpl.language,
            variables: sampleVariables(),
            types: {
                'twilio/text': { body: tpl.body },
            },
        }),
    });
    if (!res.ok) throw new Error(`POST Content fallita: ${res.status} ${await res.text()}`);
    return res.json();
}

// Categoria UTILITY: avviso su un ordine esistente.
async function submitForWhatsAppApproval(contentSid, tpl) {
    const res = await fetch(`${API_BASE}/Content/${contentSid}/ApprovalRequests/whatsapp`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ name: tpl.friendlyName, category: 'UTILITY' }),
    });
    if (!res.ok) throw new Error(`POST ApprovalRequests fallita: ${res.status} ${await res.text()}`);
    return res.json();
}

const existing = await listAllContent();
const sids = {};

console.log(dryRun ? '--dry-run: nessuna chiamata di scrittura.\n' : '');
for (const tpl of TEMPLATES) {
    console.log(`${tpl.friendlyName}:`);
    console.log(`  body: "${tpl.body}"`);
    const already = existing.find(c => c.friendly_name === tpl.friendlyName);
    if (already) {
        sids[tpl.envKey] = already.sid;
        console.log(`  ⏭️  esiste già (SID ${already.sid}) — salto la creazione.`);
    } else if (!dryRun) {
        const created = await createContent(tpl);
        sids[tpl.envKey] = created.sid;
        console.log(`  ✅ creato, SID ${created.sid}`);
        const approval = await submitForWhatsAppApproval(created.sid, tpl);
        console.log(`  ✅ sottomesso per approvazione WhatsApp (categoria UTILITY, stato: ${approval.status ?? 'in coda'})`);
    }
    console.log('');
}

console.log('=== Da incollare su Railway (Variables) ===');
for (const tpl of TEMPLATES) console.log(`${tpl.envKey}=${sids[tpl.envKey] ?? '(non creato)'}`);
if (!dryRun) {
    console.log('\nLe SID vanno su Railway solo quando sono "approved": un template non approvato non parte.');
}

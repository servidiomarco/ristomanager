#!/usr/bin/env node
// Card dev board #34 — crea (idempotente) e sottomette a Meta per
// approvazione i cinque template WhatsApp inglesi che affiancano quelli
// italiani già approvati (booking_confirmed, _reminder, _updated, _declined,
// _received). Usa la Twilio Content API: stessa forma a 4 variabili
// ({{1}} nome, {{2}} ospiti, {{3}} data, {{4}} ora) dei template italiani —
// vedi buildBooking*Template in server.ts — così le SID risultanti si
// incollano dritte nei TWILIO_WA_CONTENT_SID_*_EN di .env.example senza
// toccare codice.
//
// L'approvazione Meta richiede una review (ore/giorni), non un'attesa
// dell'utente: lancia lo script, poi ricontrolla lo stato dei template dalla
// console Twilio (Content Template Builder) o via GET
// /v1/Content/{Sid}/ApprovalRequests. Finché una SID _EN non è approvata,
// server.ts continua a usare la SID italiana (fallback automatico, vedi
// pickWhatsAppTemplateSid) — questo script non blocca né rompe nulla nel
// frattempo.
//
// Va eseguito da un ambiente che raggiunge api.twilio.com con
// TWILIO_ACCOUNT_SID/TWILIO_AUTH_TOKEN validi (Railway, o in locale con le
// stesse credenziali) — NON dal sandbox di Claude Code, che non le ha.
//
// Uso (dalla root del repo):
//   TWILIO_ACCOUNT_SID=ACxxx TWILIO_AUTH_TOKEN=xxx \
//     node scripts/create-whatsapp-templates-en.mjs [--dry-run]

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

// Identità hardcoded qui apposta: sono le stesse di IDENTITY_FALLBACK in
// server.ts, che è ciò che i template italiani già approvati incorporano
// come testo statico (un template WhatsApp non può leggere l'identità a
// runtime — è testo fisso approvato da Meta).
const BUSINESS_NAME = 'Il Vecchio Frantoio';
const BUSINESS_PHONE = '0985 876578';

// friendlyName → { body, envKey }. envKey è solo per il riepilogo finale
// (quale TWILIO_WA_CONTENT_SID_*_EN valorizzare su Railway).
const TEMPLATES = [
    {
        friendlyName: 'booking_confirmed_en',
        envKey: 'TWILIO_WA_CONTENT_SID_BOOKING_CONFIRMED_EN',
        body: `Hi {{1}}, your reservation for {{2}} on {{3}} at {{4}} at ${BUSINESS_NAME} is confirmed. See you soon!`,
    },
    {
        friendlyName: 'booking_reminder_en',
        envKey: 'TWILIO_WA_CONTENT_SID_BOOKING_REMINDER_EN',
        body: `Hi {{1}}! We look forward to seeing you on {{3}} at {{4}}: a table for {{2}} at ${BUSINESS_NAME}. Need to change anything? Call us at ${BUSINESS_PHONE} — we'll sort it out. See you soon!`,
    },
    {
        friendlyName: 'booking_updated_en',
        envKey: 'TWILIO_WA_CONTENT_SID_BOOKING_UPDATED_EN',
        body: `Hi {{1}}, your reservation at ${BUSINESS_NAME} has been updated: {{2}}, {{3}} at {{4}}. If anything looks off, call us at ${BUSINESS_PHONE}. See you soon!`,
    },
    {
        friendlyName: 'booking_declined_en',
        envKey: 'TWILIO_WA_CONTENT_SID_BOOKING_DECLINED_EN',
        body: `Hi {{1}}, unfortunately we weren't able to confirm your reservation request for {{2}} on {{3}} at {{4}}. Please call us at ${BUSINESS_PHONE} to check another date or time. Thank you!`,
    },
    {
        friendlyName: 'booking_received_en',
        envKey: 'TWILIO_WA_CONTENT_SID_BOOKING_RECEIVED_EN',
        body: `Hi {{1}}, we've received your reservation request for {{2}} on {{3}} at {{4}} at ${BUSINESS_NAME}. We'll get back to you shortly to confirm it. Thank you!`,
    },
];

const SAMPLE_VARIABLES = { '1': 'Mario', '2': '2 guests', '3': '24/12/2026', '4': '20:30' };

// Elenca TUTTO il contenuto esistente, paginando su meta.next_page_url —
// serve a controllare se un template con lo stesso friendly_name esiste
// già, per non ricrearlo (e non ripagare/riavviare un'approvazione Meta)
// a ogni rerun dello script.
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
            language: 'en',
            variables: SAMPLE_VARIABLES,
            types: { 'twilio/text': { body: tpl.body } },
        }),
    });
    if (!res.ok) throw new Error(`POST Content fallita: ${res.status} ${await res.text()}`);
    return res.json();
}

// Sottomissione per l'approvazione WhatsApp — categoria UTILITY: sono tutti
// messaggi transazionali legati a una prenotazione già in corso, non
// marketing (che richiederebbe MARKETING e ha vincoli di opt-in diversi).
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
const existingByName = new Map(existing.map(c => [c.friendly_name, c]));

console.log(dryRun ? '--dry-run: nessuna chiamata di scrittura verrà eseguita.\n' : '');

const results = [];
for (const tpl of TEMPLATES) {
    const already = existingByName.get(tpl.friendlyName);
    if (already) {
        console.log(`⏭️  ${tpl.friendlyName}: esiste già (SID ${already.sid}) — salto la creazione.`);
        results.push({ ...tpl, sid: already.sid, created: false });
        continue;
    }
    console.log(`${tpl.friendlyName}:`);
    console.log(`  body: "${tpl.body}"`);
    if (dryRun) {
        results.push({ ...tpl, sid: null, created: false });
        continue;
    }
    try {
        const created = await createContent(tpl);
        console.log(`  ✅ creato, SID ${created.sid}`);
        await submitForWhatsAppApproval(created.sid, tpl);
        console.log('  ✅ sottomesso per approvazione WhatsApp (categoria UTILITY)');
        results.push({ ...tpl, sid: created.sid, created: true });
    } catch (err) {
        console.error(`  ❌ ${err.message}`);
        results.push({ ...tpl, sid: null, created: false, error: err.message });
    }
}

console.log('\n=== Riepilogo — incolla su Railway (Variables) ===');
for (const r of results) {
    console.log(`${r.envKey}=${r.sid ?? '(non creato)'}`);
}
if (!dryRun) {
    console.log('\nL\'approvazione Meta arriva in ore/giorni. Controlla lo stato in Twilio Console →');
    console.log('Messaging → Content Template Builder, oppure GET /v1/Content/{Sid}/ApprovalRequests.');
    console.log('Finché una SID non è "approved" il codice resta sulla SID italiana (fallback automatico).');
}

#!/usr/bin/env node
// Crea (idempotente) e sottomette a Meta i quattro template WhatsApp col
// bottone «Gestisci la prenotazione»: la controparte approvabile della
// gestione dall'ospite (services/guestManage.ts, pickBookingTemplateSid in
// server.ts). Conferma e promemoria, in italiano e in inglese.
//
// Forma: twilio/call-to-action, body {{1}} nome, {{2}} ospiti, {{3}} data,
// {{4}} ora, {{5}} nome del locale; bottone URL
// https://app.sympotia.com/r/{{6}} con SOLO il token in {{6}} — l'host vive
// nel template, come per caparra e conto. Il nome del locale è una
// variabile (non testo fisso come nei template storici) così gli stessi
// template servono a ogni ristorante.
//
// I testi non promettono più di quanto la pagina fa: «gestisci la
// prenotazione» resta vero anche quando arriverà la modifica di data e ora,
// senza rifare approvare niente.
//
// L'approvazione Meta richiede ore/giorni. Finché una SID non c'è, server.ts
// manda il template di prima senza bottone (SMS ed email portano già il
// link), quindi valorizzare le variabili su Railway non rompe nulla.
//
// Uso (serve l'ambiente con le credenziali Twilio):
//   railway run --service ristomanager node scripts/create-whatsapp-templates-gestione.mjs [--dry-run]

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

// Deve coincidere con GUEST_MANAGE_BASE_URL in server.ts.
const MANAGE_URL = 'https://app.sympotia.com/r/{{6}}';

const TEMPLATES = [
    {
        friendlyName: 'booking_confirmed_link_it',
        envKey: 'TWILIO_WA_CONTENT_SID_BOOKING_CONFIRMED_LINK',
        language: 'it',
        body: 'Ciao {{1}}, la tua prenotazione per {{2}} il {{3}} alle {{4}} da {{5}} è confermata. Se cambia qualcosa, gestiscila dal pulsante qui sotto. A presto!',
        buttonTitle: 'Gestisci la prenotazione',
    },
    {
        friendlyName: 'booking_confirmed_link_en',
        envKey: 'TWILIO_WA_CONTENT_SID_BOOKING_CONFIRMED_LINK_EN',
        language: 'en',
        body: 'Hi {{1}}, your reservation for {{2}} on {{3}} at {{4}} at {{5}} is confirmed. If anything changes, manage it with the button below. See you soon!',
        buttonTitle: 'Manage your booking',
    },
    {
        friendlyName: 'booking_reminder_link_it',
        envKey: 'TWILIO_WA_CONTENT_SID_BOOKING_REMINDER_LINK',
        language: 'it',
        body: 'Ciao {{1}}! Ti aspettiamo il {{3}} alle {{4}}: tavolo per {{2}} da {{5}}. Ci sarai? Confermalo dal pulsante qui sotto, o gestisci la prenotazione se cambia qualcosa. A presto!',
        buttonTitle: 'Gestisci la prenotazione',
    },
    {
        friendlyName: 'booking_reminder_link_en',
        envKey: 'TWILIO_WA_CONTENT_SID_BOOKING_REMINDER_LINK_EN',
        language: 'en',
        body: 'Hi {{1}}! We look forward to seeing you on {{3}} at {{4}}: a table for {{2}} at {{5}}. Will you make it? Confirm with the button below, or manage your booking if anything changes. See you soon!',
        buttonTitle: 'Manage your booking',
    },
];

const sampleVariables = (language) => ({
    '1': 'Mario',
    '2': language === 'en' ? '4 guests' : '4 persone',
    '3': '12/10/2026',
    '4': '20:30',
    '5': 'Vecchio Frantoio',
    '6': 'AbCdEfGhIjKlMnOpQrStUv',
});

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
            variables: sampleVariables(tpl.language),
            types: {
                'twilio/call-to-action': {
                    body: tpl.body,
                    actions: [{ type: 'URL', title: tpl.buttonTitle, url: MANAGE_URL }],
                },
            },
        }),
    });
    if (!res.ok) throw new Error(`POST Content fallita: ${res.status} ${await res.text()}`);
    return res.json();
}

// Categoria UTILITY: messaggio transazionale su una prenotazione esistente.
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
    console.log(`  bottone: [${tpl.buttonTitle}] → ${MANAGE_URL}`);
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
    console.log('\nStato approvazione: Twilio Console → Messaging → Content Template Builder,');
    console.log(`oppure GET ${API_BASE}/Content/<SID>/ApprovalRequests.`);
    console.log('Finché non sono "approved", conferma e promemoria partono col template di prima, senza bottone.');
}

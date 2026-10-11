#!/usr/bin/env node
// Crea (idempotente) e sottomette a Meta il promemoria coi tasti di
// risposta rapida «Ci saremo», «Devo modificare», «Annulla»: la versione a
// tasti di BOOKING_REMINDER (services/whatsapp/templates/catalog.ts,
// buildBookingReminderQrTemplate in server.ts). I tocchi li gestisce
// services/whatsapp/buttons.ts, anche con l'agente spento.
//
// Forma: twilio/quick-reply, body {{1}} nome, {{2}} ospiti, {{3}} data,
// {{4}} ora, {{5}} nome del locale. Gli id dei tasti sono fissi (rsv_confirm,
// rsv_manage, rsv_cancel): la prenotazione si ritrova dal messaggio a cui il
// cliente risponde (OriginalRepliedMessageSid), che porta il suo id.
// WhatsApp non permette di mescolare tasti di risposta e pulsanti link nello
// stesso template, per questo «Devo modificare» è un tasto e non il link.
//
// L'approvazione Meta richiede ore o giorni. Finché la SID non è su Railway
// (TWILIO_WA_CONTENT_SID_BOOKING_REMINDER_QR[_EN]) il promemoria parte come
// prima anche con l'interruttore acceso.
//
// Uso (serve l'ambiente con le credenziali Twilio):
//   railway run --service ristomanager node scripts/create-whatsapp-template-promemoria-tasti.mjs [--dry-run]

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

// Gli id devono coincidere con PAYLOAD_RE in services/whatsapp/buttons.ts.
const TEMPLATES = [
    {
        friendlyName: 'booking_reminder_qr_it',
        envKey: 'TWILIO_WA_CONTENT_SID_BOOKING_REMINDER_QR',
        language: 'it',
        body: 'Ciao {{1}}! Ti aspettiamo il {{3}} alle {{4}}: tavolo per {{2}} da {{5}}. Ci sarai?',
        actions: [
            { title: 'Ci saremo', id: 'rsv_confirm' },
            { title: 'Devo modificare', id: 'rsv_manage' },
            { title: 'Annulla', id: 'rsv_cancel' },
        ],
    },
    {
        friendlyName: 'booking_reminder_qr_en',
        envKey: 'TWILIO_WA_CONTENT_SID_BOOKING_REMINDER_QR_EN',
        language: 'en',
        body: 'Hi {{1}}! We look forward to seeing you on {{3}} at {{4}}: a table for {{2}} at {{5}}. Will you make it?',
        actions: [
            { title: "We'll be there", id: 'rsv_confirm' },
            { title: 'I need to change', id: 'rsv_manage' },
            { title: 'Cancel', id: 'rsv_cancel' },
        ],
    },
];

const sampleVariables = (tpl) => ({
    '1': 'Mario',
    '2': tpl.language === 'en' ? '4 guests' : '4 persone',
    '3': '12/10/2026',
    '4': '20:30',
    '5': 'Vecchio Frantoio',
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
            variables: sampleVariables(tpl),
            types: {
                'twilio/quick-reply': { body: tpl.body, actions: tpl.actions },
            },
        }),
    });
    if (!res.ok) throw new Error(`POST Content fallita: ${res.status} ${await res.text()}`);
    return res.json();
}

// Categoria UTILITY: promemoria di una prenotazione esistente.
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
    for (const a of tpl.actions) console.log(`  tasto: [${a.title}] → ${a.id}`);
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

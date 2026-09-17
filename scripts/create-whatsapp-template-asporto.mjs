#!/usr/bin/env node
// Crea (idempotente) e sottomette a Meta il template WhatsApp del link
// conto ASPORTO — la controparte approvabile di buildTakeawayBillLinkTemplate
// in server.ts: twilio/call-to-action, body {{1}} nome, {{2}} ora di ritiro,
// {{3}} totale, bottone URL https://app.sympotia.com/pay/{{4}} (solo il
// token in {{4}}: l'host vive nel template, come per i template caparra).
//
// NON riusa il template del tavolo (table_bill_link_qr_v2): il suo testo
// fisso parla di coperti e di tavolo, che su un asporto sarebbero falsi.
//
// L'approvazione Meta richiede ore/giorni. Finché la SID non è approvata,
// server.ts manda l'SMS (fallback automatico in sendBookingConfirmation),
// quindi valorizzare subito TWILIO_WA_CONTENT_SID_TAKEAWAY_BILL_LINK_CTA
// su Railway non rompe nulla.
//
// Uso (serve l'ambiente con le credenziali Twilio):
//   railway run --service ristomanager node scripts/create-whatsapp-template-asporto.mjs [--dry-run]

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

// Identità fissa come nei template prenotazioni: un template WhatsApp è
// testo statico approvato da Meta, non può leggere l'anagrafe a runtime.
const BUSINESS_NAME = 'Vecchio Frantoio';

const TEMPLATE = {
    friendlyName: 'takeaway_bill_link_cta',
    envKey: 'TWILIO_WA_CONTENT_SID_TAKEAWAY_BILL_LINK_CTA',
    body: `Ciao {{1}}, ecco il link per pagare il tuo ordine d'asporto delle {{2}} dal ${BUSINESS_NAME} (totale {{3}}). Puoi inoltrarlo a chi è con te: ognuno paga i propri piatti. Grazie!`,
    buttonTitle: 'Paga il conto',
    buttonUrl: 'https://app.sympotia.com/pay/{{4}}',
};

const SAMPLE_VARIABLES = { '1': 'Mario', '2': '19:30', '3': '26,50 €', '4': 'tok_esempio_123' };

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
            language: 'it',
            variables: SAMPLE_VARIABLES,
            types: {
                'twilio/call-to-action': {
                    body: tpl.body,
                    actions: [{ type: 'URL', title: tpl.buttonTitle, url: tpl.buttonUrl }],
                },
            },
        }),
    });
    if (!res.ok) throw new Error(`POST Content fallita: ${res.status} ${await res.text()}`);
    return res.json();
}

// Categoria UTILITY: messaggio transazionale su un ordine già in corso.
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
const already = existing.find(c => c.friendly_name === TEMPLATE.friendlyName);

console.log(dryRun ? '--dry-run: nessuna chiamata di scrittura.\n' : '');
console.log(`${TEMPLATE.friendlyName}:`);
console.log(`  body: "${TEMPLATE.body}"`);
console.log(`  bottone: [${TEMPLATE.buttonTitle}] → ${TEMPLATE.buttonUrl}`);

let sid = null;
if (already) {
    sid = already.sid;
    console.log(`  ⏭️  esiste già (SID ${sid}) — salto la creazione.`);
} else if (!dryRun) {
    const created = await createContent(TEMPLATE);
    sid = created.sid;
    console.log(`  ✅ creato, SID ${sid}`);
    const approval = await submitForWhatsAppApproval(sid, TEMPLATE);
    console.log(`  ✅ sottomesso per approvazione WhatsApp (categoria UTILITY, stato: ${approval.status ?? 'in coda'})`);
}

console.log('\n=== Da incollare su Railway (Variables) ===');
console.log(`${TEMPLATE.envKey}=${sid ?? '(non creato)'}`);
if (!dryRun) {
    console.log('\nStato approvazione: Twilio Console → Messaging → Content Template Builder,');
    console.log(`oppure GET ${API_BASE}/Content/${sid}/ApprovalRequests.`);
    console.log('Finché non è "approved", il link parte via SMS (fallback automatico).');
}

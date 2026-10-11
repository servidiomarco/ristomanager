#!/usr/bin/env node
// Crea (idempotente) e sottomette a Meta il template delle campagne
// (CAMPAIGN nel catalogo, services/whatsapp/campaigns/send.ts): {{1}} nome
// del cliente, {{2}} nome del locale, {{3}} il testo della campagna, e il
// tasto «Stop promozioni» che revoca il consenso.
//
// Categoria MARKETING. Meta può rifiutare un template il cui contenuto è
// quasi tutto una variabile: se succede, il motivo compare in Impostazioni ›
// WhatsApp › Template, e va riscritto con più testo fisso.
//
// Uso (serve l'ambiente con le credenziali Twilio):
//   railway run --service ristomanager node scripts/create-whatsapp-template-campagna.mjs [--dry-run]

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

// L'id del tasto deve coincidere con STOP_PAYLOAD in
// services/whatsapp/campaigns/consent.ts.
const TEMPLATES = [
    {
        friendlyName: 'campaign_it',
        envKey: 'TWILIO_WA_CONTENT_SID_CAMPAIGN',
        language: 'it',
        body: 'Ciao {{1}}, una novità da {{2}}: {{3}}\n\nSe non vuoi più ricevere promozioni tocca il tasto qui sotto.',
        actions: [{ title: 'Stop promozioni', id: 'marketing_stop' }],
    },
    {
        friendlyName: 'campaign_en',
        envKey: 'TWILIO_WA_CONTENT_SID_CAMPAIGN_EN',
        language: 'en',
        body: 'Hi {{1}}, some news from {{2}}: {{3}}\n\nIf you no longer want promotions, tap the button below.',
        actions: [{ title: 'Stop promotions', id: 'marketing_stop' }],
    },
];

const sampleVariables = (tpl) => ({
    '1': 'Mario',
    '2': 'Vecchio Frantoio',
    '3': tpl.language === 'en' ? 'this Friday truffle dinner, book a table by replying here.' : 'venerdì cena al tartufo, prenota rispondendo qui.',
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

// Categoria MARKETING: è una promozione, e Meta la tratta come tale.
async function submitForWhatsAppApproval(contentSid, tpl) {
    const res = await fetch(`${API_BASE}/Content/${contentSid}/ApprovalRequests/whatsapp`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ name: tpl.friendlyName, category: 'MARKETING' }),
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
        console.log(`  ✅ sottomesso per approvazione WhatsApp (categoria MARKETING, stato: ${approval.status ?? 'in coda'})`);
    }
    console.log('');
}

console.log('=== Da incollare su Railway (Variables) ===');
for (const tpl of TEMPLATES) console.log(`${tpl.envKey}=${sids[tpl.envKey] ?? '(non creato)'}`);
if (!dryRun) {
    console.log('\nLe SID vanno su Railway solo quando sono "approved": un template non approvato non parte.');
}

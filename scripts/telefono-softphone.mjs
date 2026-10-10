#!/usr/bin/env node
// Prepara Twilio per il softphone nel CRM (docs/telefono-piano.md, Fase 3).
// Lo lancia l'utente: crea risorse nell'account Twilio e variabili su Railway.
//
// Con --apply:
//   1. crea una API key «sympotia-softphone» (firma i token dei browser);
//   2. crea (o aggiorna) la TwiML App «sympotia-softphone», che porta le
//      chiamate in uscita dal CRM a /webhook/twilio/voice/client-call;
//   3. imposta su Railway (servizio ristomanager) TWILIO_API_KEY_SID,
//      TWILIO_API_KEY_SECRET e TWILIO_TWIML_APP_SID. Il segreto non viene
//      mai stampato. Railway riavvia il servizio con le variabili nuove.
// Senza flag: solo lettura. Rilanciarlo è sicuro: se la chiave c'è già la
// riusa, e aggiorna solo gli URL della TwiML App.
//
// Uso (dalla cartella ristomanager-ai, già collegata a Railway):
//   railway run -s ristomanager node <percorso>/scripts/telefono-softphone.mjs [--apply]

import { execFileSync } from 'node:child_process';

const NAME = 'sympotia-softphone';
const API_BASE = (process.env.API_BASE || 'https://ristomanager-production.up.railway.app').replace(/\/$/, '');
const ACC = process.env.TWILIO_ACCOUNT_SID;
const AUTH = process.env.TWILIO_AUTH_TOKEN;
const apply = process.argv.includes('--apply');

if (!ACC || !AUTH) {
    console.error('Mancano le variabili Twilio: lanciare con `railway run -s ristomanager`.');
    process.exit(2);
}

const twilio = async (method, path, form) => {
    const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${ACC}${path}`, {
        method,
        headers: {
            Authorization: 'Basic ' + Buffer.from(`${ACC}:${AUTH}`).toString('base64'),
            ...(form ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
        },
        body: form ? new URLSearchParams(form).toString() : undefined,
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`Twilio ${method} ${path} → ${res.status} ${text.slice(0, 300)}`);
    return text ? JSON.parse(text) : {};
};

const voiceUrl = `${API_BASE}/webhook/twilio/voice/client-call`;
const statusUrl = `${API_BASE}/webhook/twilio/voice/client-status`;

// Il controllo che il deploy abbia la rotta: senza firma risponde 403, non 404.
const probe = await fetch(voiceUrl, { method: 'POST' });
console.log(`Controllo ${voiceUrl} senza firma → ${probe.status} ${probe.status === 403 ? '(ok)' : '(ATTESO 403: manca il deploy)'}`);
if (probe.status !== 403) process.exit(1);

const existingKeySid = process.env.TWILIO_API_KEY_SID;
let keyOk = false;
if (existingKeySid) {
    try { await twilio('GET', `/Keys/${existingKeySid}.json`); keyOk = true; } catch { keyOk = false; }
}
const apps = (await twilio('GET', `/Applications.json?FriendlyName=${encodeURIComponent(NAME)}`)).applications || [];
const app = apps[0];
console.log(`API key su Railway: ${existingKeySid ? (keyOk ? `${existingKeySid} (valida)` : `${existingKeySid} (NON trovata su Twilio)`) : 'assente'}`);
console.log(`TwiML App «${NAME}»: ${app ? `${app.sid} → ${app.voice_url}` : 'assente'}`);
console.log(`TWILIO_TWIML_APP_SID su Railway: ${process.env.TWILIO_TWIML_APP_SID || 'assente'}`);

if (!apply) {
    console.log('\nSolo lettura. --apply per preparare il softphone.');
    process.exit(0);
}

const vars = [];
if (!keyOk) {
    const key = await twilio('POST', '/Keys.json', { FriendlyName: NAME });
    vars.push(['TWILIO_API_KEY_SID', key.sid], ['TWILIO_API_KEY_SECRET', key.secret]);
    console.log(`Creata API key ${key.sid}.`);
}
const appForm = { FriendlyName: NAME, VoiceUrl: voiceUrl, VoiceMethod: 'POST', StatusCallback: statusUrl, StatusCallbackMethod: 'POST' };
const appSid = app
    ? (await twilio('POST', `/Applications/${app.sid}.json`, appForm)).sid
    : (await twilio('POST', '/Applications.json', appForm)).sid;
console.log(`${app ? 'Aggiornata' : 'Creata'} TwiML App ${appSid}.`);
if (process.env.TWILIO_TWIML_APP_SID !== appSid) vars.push(['TWILIO_TWIML_APP_SID', appSid]);

if (vars.length === 0) {
    console.log('\nNiente da cambiare su Railway: il softphone era già pronto.');
    process.exit(0);
}
// Il segreto passa a railway da stdin (né sullo schermo né negli argomenti
// del processo), senza riavvio; le altre variabili con un solo riavvio.
const secret = vars.find(([k]) => k === 'TWILIO_API_KEY_SECRET');
if (secret) {
    execFileSync('railway', ['variables', '-s', 'ristomanager', '--set-from-stdin', secret[0], '--skip-deploys'],
        { input: secret[1], stdio: ['pipe', 'ignore', 'inherit'] });
}
const plain = vars.filter(([k]) => k !== 'TWILIO_API_KEY_SECRET');
if (plain.length > 0) {
    execFileSync('railway', ['variables', '-s', 'ristomanager', ...plain.flatMap(([k, v]) => ['--set', `${k}=${v}`])],
        { stdio: ['ignore', 'ignore', 'inherit'] });
}
console.log(`\nOK: ${vars.map(([k]) => k).join(', ')} impostate su Railway. Il servizio si riavvia da solo (qualche minuto).`);

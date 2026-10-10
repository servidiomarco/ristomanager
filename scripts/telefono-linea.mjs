#!/usr/bin/env node
// Mette Sympotia davanti al numero di Sofia, o la toglie (docs/telefono-piano.md,
// Fase 2). Lo lancia l'utente: tocca la linea vera.
//
// Cosa cambia con --apply:
//   1. l'agente ElevenLabs passa all'audio μ-law 8000, che register-call
//      richiede (l'integrazione nativa lo accetta lo stesso, quindi l'ordine
//      è sicuro);
//   2. il numero Twilio chiama /webhook/t/<token>/voice/inbound invece di
//      ElevenLabs, con ElevenLabs come fallback: se Sympotia non risponde,
//      risponde Sofia come prima. La fine chiamata va a /voice/status.
// --rollback rimette il numero su ElevenLabs (l'agente resta in μ-law, che
// con l'integrazione nativa funziona). Senza flag: solo lettura e controlli.
//
// Uso (dalla cartella ristomanager-ai, col token del tenant letto dal DB):
//   TENANT_WEBHOOK_TOKEN=$(psql "$(railway variables --kv -s Postgres | grep '^DATABASE_PUBLIC_URL=' | cut -d= -f2-)" -Atc "select webhook_token from tenants where id = 1") \
//     railway run -s ristomanager node scripts/telefono-linea.mjs [--apply | --rollback]
//
// Attenzione: modificare il numero dal pannello ElevenLabs (Numeri di
// telefono) può rimettere il webhook di ElevenLabs su Twilio. Dopo, rilanciare
// questo script senza flag per controllare.

const NUMERO = process.env.NUMERO || '+390985010032';
const API_BASE = (process.env.API_BASE || 'https://ristomanager-production.up.railway.app').replace(/\/$/, '');
const ELEVENLABS_INBOUND = 'https://api.us.elevenlabs.io/twilio/inbound_call';
const ELEVENLABS_STATUS = 'https://api.us.elevenlabs.io/twilio/status-callback';

const ACC = process.env.TWILIO_ACCOUNT_SID;
const AUTH = process.env.TWILIO_AUTH_TOKEN;
const XI = process.env.ELEVENLABS_API_KEY;
const AGENT = process.env.ELEVENLABS_AGENT_ID;
const TOKEN = process.env.TENANT_WEBHOOK_TOKEN;
const apply = process.argv.includes('--apply');
const rollback = process.argv.includes('--rollback');

if (!ACC || !AUTH || !XI || !AGENT) {
    console.error('Mancano le variabili Twilio/ElevenLabs: lanciare con `railway run -s ristomanager`.');
    process.exit(2);
}
if (apply && rollback) {
    console.error('O --apply o --rollback, non tutti e due.');
    process.exit(2);
}
if (!rollback && !TOKEN) {
    console.error('Manca TENANT_WEBHOOK_TOKEN (vedi «Uso» in testa al file).');
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
    return JSON.parse(text);
};
const eleven = async (method, path, body) => {
    const res = await fetch(`https://api.elevenlabs.io/v1${path}`, {
        method,
        headers: { 'xi-api-key': XI, ...(body ? { 'Content-Type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`ElevenLabs ${method} ${path} → ${res.status} ${text.slice(0, 300)}`);
    return JSON.parse(text);
};
// Il token del tenant non si stampa: nei log basta sapere che c'è.
const mask = (url) => (TOKEN ? String(url).replace(TOKEN, '<token>') : String(url));

const found = await twilio('GET', `/IncomingPhoneNumbers.json?PhoneNumber=${encodeURIComponent(NUMERO)}`);
const number = found.incoming_phone_numbers?.[0];
if (!number) {
    console.error(`Numero ${NUMERO} non trovato nell'account Twilio.`);
    process.exit(1);
}
const agent = await eleven('GET', `/convai/agents/${encodeURIComponent(AGENT)}`);
const tts = agent.conversation_config?.tts?.agent_output_audio_format;
const asr = agent.conversation_config?.asr?.user_input_audio_format;

const inboundUrl = `${API_BASE}/webhook/t/${TOKEN}/voice/inbound`;
const statusUrl = `${API_BASE}/webhook/t/${TOKEN}/voice/status`;

console.log(`Numero ${NUMERO} (${number.sid})`);
console.log(`  voice_url         ${mask(number.voice_url)}`);
console.log(`  voice_fallback    ${mask(number.voice_fallback_url || '—')}`);
console.log(`  status_callback   ${mask(number.status_callback || '—')}`);
console.log(`Agente ${agent.name} (${AGENT}): audio in uscita ${tts}, in ingresso ${asr}`);

if (!rollback) {
    // Il deploy ha le rotte voce e il token è giusto se, senza firma, il
    // webhook risponde 403 (firma) e non 404 (token o rotta mancanti).
    const probe = await fetch(inboundUrl, { method: 'POST' });
    console.log(`Controllo ${mask(inboundUrl)} senza firma → ${probe.status} ${probe.status === 403 ? '(ok)' : '(ATTESO 403: deploy o token sbagliati)'}`);
    if (probe.status !== 403) process.exit(1);
}

if (!apply && !rollback) {
    const davanti = number.voice_url === inboundUrl;
    console.log(davanti ? '\nSympotia è già davanti al numero.' : '\nSolo lettura. --apply per mettere Sympotia davanti al numero.');
    process.exit(0);
}

if (rollback) {
    await twilio('POST', `/IncomingPhoneNumbers/${number.sid}.json`, {
        VoiceUrl: ELEVENLABS_INBOUND,
        VoiceMethod: 'POST',
        VoiceFallbackUrl: '',
        StatusCallback: ELEVENLABS_STATUS,
        StatusCallbackMethod: 'POST',
    });
    console.log('\nOK: il numero risponde di nuovo con l\'integrazione nativa di ElevenLabs.');
    process.exit(0);
}

if (tts !== 'ulaw_8000' || asr !== 'ulaw_8000') {
    await eleven('PATCH', `/convai/agents/${encodeURIComponent(AGENT)}`, {
        conversation_config: {
            tts: { agent_output_audio_format: 'ulaw_8000' },
            asr: { user_input_audio_format: 'ulaw_8000' },
        },
    });
    const check = await eleven('GET', `/convai/agents/${encodeURIComponent(AGENT)}`);
    const okFormat = check.conversation_config?.tts?.agent_output_audio_format === 'ulaw_8000'
        && check.conversation_config?.asr?.user_input_audio_format === 'ulaw_8000';
    if (!okFormat) {
        console.error('L\'agente non risulta in μ-law dopo la modifica: mi fermo, il numero non è stato toccato.');
        process.exit(1);
    }
    console.log('Agente passato a μ-law 8000.');
}

await twilio('POST', `/IncomingPhoneNumbers/${number.sid}.json`, {
    VoiceUrl: inboundUrl,
    VoiceMethod: 'POST',
    VoiceFallbackUrl: ELEVENLABS_INBOUND,
    VoiceFallbackMethod: 'POST',
    StatusCallback: statusUrl,
    StatusCallbackMethod: 'POST',
});
console.log('\nOK: Sympotia è davanti al numero, con ElevenLabs come fallback.');
console.log('Per tornare indietro: lo stesso comando con --rollback.');

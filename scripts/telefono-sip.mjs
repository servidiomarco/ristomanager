#!/usr/bin/env node
// Prepara Twilio per il cordless del locale (docs/telefono-piano.md, Fase 4).
// Lo lancia l'utente: crea risorse nell'account Twilio e variabili su Railway.
//
// Con --apply:
//   1. crea (o riusa) la Credential List «sympotia-cordless»: le credenziali
//      dei singoli cordless le crea poi il CRM (Impostazioni › AI);
//   2. crea (o aggiorna) il dominio SIP <nome>.sip.twilio.com con la
//      registrazione SIP accesa, le chiamate in uscita verso
//      /webhook/twilio/voice/sip-call e la fine chiamata verso /client-status;
//   3. collega la Credential List al dominio, per registrarsi e per chiamare;
//   4. imposta su Railway (servizio ristomanager) TWILIO_SIP_DOMAIN e
//      TWILIO_SIP_CREDENTIAL_LIST_SID. Railway riavvia il servizio.
// Senza flag: solo lettura. Rilanciarlo è sicuro: riusa quello che c'è.
//
// Uso (dalla cartella ristomanager-ai, già collegata a Railway):
//   railway run -s ristomanager node <percorso>/scripts/telefono-sip.mjs [--apply] [--name sympotia-voce]

import { execFileSync } from 'node:child_process';

const NAME = 'sympotia-cordless';
const API_BASE = (process.env.API_BASE || 'https://ristomanager-production.up.railway.app').replace(/\/$/, '');
const ACC = process.env.TWILIO_ACCOUNT_SID;
const AUTH = process.env.TWILIO_AUTH_TOKEN;
const apply = process.argv.includes('--apply');
const nameArg = process.argv[process.argv.indexOf('--name') + 1];

if (!ACC || !AUTH) {
    console.error('Mancano le variabili Twilio: lanciare con `railway run -s ristomanager`.');
    process.exit(2);
}
// Il nome del dominio è unico in tutto Twilio: di serie uno legato all'account.
const domainName = `${process.argv.includes('--name') && nameArg ? nameArg : `sympotia-${ACC.slice(-6).toLowerCase()}`}.sip.twilio.com`;
if (!/^[a-z0-9-]+\.sip\.twilio\.com$/.test(domainName)) {
    console.error(`Nome del dominio non valido: ${domainName} (solo lettere minuscole, cifre e trattini).`);
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

const voiceUrl = `${API_BASE}/webhook/twilio/voice/sip-call`;
const statusUrl = `${API_BASE}/webhook/twilio/voice/client-status`;

// Il controllo che il deploy abbia la rotta: senza firma risponde 403, non 404.
const probe = await fetch(voiceUrl, { method: 'POST' });
console.log(`Controllo ${voiceUrl} senza firma → ${probe.status} ${probe.status === 403 ? '(ok)' : '(ATTESO 403: manca il deploy)'}`);
if (probe.status !== 403) process.exit(1);

const lists = (await twilio('GET', '/SIP/CredentialLists.json?PageSize=100')).credential_lists || [];
const list = lists.find(l => l.friendly_name === NAME);
const domains = (await twilio('GET', '/SIP/Domains.json?PageSize=100')).domains || [];
const domain = domains.find(d => d.domain_name === (process.env.TWILIO_SIP_DOMAIN || domainName)) || domains.find(d => d.friendly_name === NAME);
console.log(`Credential List «${NAME}»: ${list ? list.sid : 'assente'}`);
console.log(`Dominio SIP: ${domain ? `${domain.domain_name} (${domain.sid}) registrazione ${domain.sip_registration ? 'accesa' : 'SPENTA'} → ${domain.voice_url}` : `assente (verrà creato ${domainName})`}`);
console.log(`TWILIO_SIP_DOMAIN su Railway: ${process.env.TWILIO_SIP_DOMAIN || 'assente'}`);
console.log(`TWILIO_SIP_CREDENTIAL_LIST_SID su Railway: ${process.env.TWILIO_SIP_CREDENTIAL_LIST_SID || 'assente'}`);

if (!apply) {
    console.log('\nSolo lettura. --apply per preparare il cordless.');
    process.exit(0);
}

const listSid = list ? list.sid : (await twilio('POST', '/SIP/CredentialLists.json', { FriendlyName: NAME })).sid;
if (!list) console.log(`Creata Credential List ${listSid}.`);

const domainForm = {
    FriendlyName: NAME,
    VoiceUrl: voiceUrl,
    VoiceMethod: 'POST',
    VoiceStatusCallbackUrl: statusUrl,
    VoiceStatusCallbackMethod: 'POST',
    SipRegistration: 'true',
};
const domainSid = domain
    ? (await twilio('POST', `/SIP/Domains/${domain.sid}.json`, domainForm)).sid
    : (await twilio('POST', '/SIP/Domains.json', { ...domainForm, DomainName: domainName })).sid;
const finalDomain = domain ? domain.domain_name : domainName;
console.log(`${domain ? 'Aggiornato' : 'Creato'} dominio ${finalDomain} (${domainSid}).`);

for (const kind of ['Registrations', 'Calls']) {
    const path = `/SIP/Domains/${domainSid}/Auth/${kind}/CredentialListMappings.json`;
    const page = await twilio('GET', path);
    const items = page.contents || page.credential_list_mappings || [];
    const mapped = items.some(m => m.sid === listSid || m.credential_list_sid === listSid);
    if (!mapped) {
        try {
            await twilio('POST', path, { CredentialListSid: listSid });
            console.log(`Collegata la Credential List al dominio (${kind === 'Registrations' ? 'registrazione' : 'chiamate'}).`);
        } catch (err) {
            // Già collegata con un formato di risposta diverso: va bene così.
            if (!/already|exists|21231/i.test(String(err?.message))) throw err;
        }
    }
}

const vars = [];
if (process.env.TWILIO_SIP_DOMAIN !== finalDomain) vars.push(['TWILIO_SIP_DOMAIN', finalDomain]);
if (process.env.TWILIO_SIP_CREDENTIAL_LIST_SID !== listSid) vars.push(['TWILIO_SIP_CREDENTIAL_LIST_SID', listSid]);
if (vars.length === 0) {
    console.log('\nNiente da cambiare su Railway: il cordless era già pronto.');
    process.exit(0);
}
execFileSync('railway', ['variables', '-s', 'ristomanager', ...vars.flatMap(([k, v]) => ['--set', `${k}=${v}`])],
    { stdio: ['ignore', 'ignore', 'inherit'] });
console.log(`\nOK: ${vars.map(([k]) => k).join(', ')} impostate su Railway. Il servizio si riavvia da solo (qualche minuto).`);

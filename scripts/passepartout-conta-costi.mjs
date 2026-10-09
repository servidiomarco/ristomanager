#!/usr/bin/env node
// Food cost, Fase 0: cosa c'è già in Passepartout? SOLA LETTURA.
//
// Chiama GetArticoli (l'intero catalogo) e conta quanti articoli hanno un
// costo d'acquisto (CostoUltimo), una distinta base (IsDBA / Componenti),
// prezzi dei fornitori (Fornitori[].PrezzoBase) e quanti sono materie prime.
// Stampa solo conteggi e qualche esempio di descrizione: mai credenziali.
//
// Senza dipendenze, per girare anche sul PC della cassa con il solo node.
// Le credenziali si prendono dall'ambiente (PASSEPARTOUT_WS_URL, _USER,
// _PASSWORD, _AZIENDA, _BEW), dal .cmd dell'agente installato a mano oppure
// dal nodo.json dell'installatore:
//
//   node scripts/passepartout-conta-costi.mjs --cmd C:\ristomanager-agents\run-passepartout-agent.cmd
//   node scripts/passepartout-conta-costi.mjs --nodo C:\Sympotia\Cassa\nodo.json
//
// Vedi docs/passepartout/articoli-costi.md.

import { readFileSync } from 'node:fs';

const args = process.argv.slice(2);
const cmdIdx = args.indexOf('--cmd');
const nodoIdx = args.indexOf('--nodo');
const env = {};
for (const k of ['PASSEPARTOUT_WS_URL', 'PASSEPARTOUT_WS_USER', 'PASSEPARTOUT_WS_PASSWORD', 'PASSEPARTOUT_WS_AZIENDA', 'PASSEPARTOUT_WS_BEW']) {
    if (process.env[k]) env[k] = process.env[k];
}
if (cmdIdx >= 0) {
    for (const raw of readFileSync(args[cmdIdx + 1], 'utf8').split(/\r?\n/)) {
        const m = raw.match(/^\s*set\s+"?(PASSEPARTOUT_WS_[A-Z_]+)=(.*?)"?\s*$/i);
        if (m) env[m[1].toUpperCase()] = m[2];
    }
}
if (nodoIdx >= 0) {
    // L'installatore scrive in UTF-8; un BOM lasciato da un editor romperebbe JSON.parse.
    const nodo = JSON.parse(readFileSync(args[nodoIdx + 1], 'utf8').replace(/^\uFEFF/, ''));
    for (const [k, v] of Object.entries(nodo?.passepartout_agent?.env ?? {})) {
        if (k.startsWith('PASSEPARTOUT_WS_') && typeof v === 'string') env[k] = v;
    }
}
const URL_WS = (env.PASSEPARTOUT_WS_URL || '').trim().replace(/\/$/, '');
if (!URL_WS) {
    console.error('PASSEPARTOUT_WS_URL assente (ambiente, --cmd o --nodo)');
    process.exit(1);
}

const TEMPURI = 'http://tempuri.org/';
const NS_KERNEL = 'http://schemas.datacontract.org/2004/07/PMessageBox.Kernel';
const esc = (v) => String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const login = () => {
    const p = [];
    if (env.PASSEPARTOUT_WS_AZIENDA) p.push(`<k:Azienda>${esc(env.PASSEPARTOUT_WS_AZIENDA)}</k:Azienda>`);
    if (env.PASSEPARTOUT_WS_BEW) p.push(`<k:Bew>${esc(env.PASSEPARTOUT_WS_BEW)}</k:Bew>`);
    p.push(`<k:Password>${esc(env.PASSEPARTOUT_WS_PASSWORD || '')}</k:Password>`);
    p.push(`<k:Utente>${esc(env.PASSEPARTOUT_WS_USER || '')}</k:Utente>`);
    return `<datiLogin xmlns:k="${NS_KERNEL}">${p.join('')}</datiLogin>`;
};

async function soapGet(op, params = '') {
    // La guardia è il punto dello script: niente Put, niente Conto.
    if (!/^Get[A-Za-z]+$/.test(op)) throw new Error('solo operazioni Get');
    const body = `<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body><${op} xmlns="${TEMPURI}">${login()}${params}</${op}></s:Body></s:Envelope>`;
    const res = await fetch(URL_WS, {
        method: 'POST',
        headers: { 'Content-Type': 'text/xml; charset=utf-8', SOAPAction: `"${TEMPURI}IAdapterWS/${op}"` },
        body,
        signal: AbortSignal.timeout(180_000),
    });
    const text = await res.text();
    const fault = text.match(/<faultstring[^>]*>([\s\S]*?)<\/faultstring>/i);
    if (fault) throw new Error(`${op}: ${fault[1].replace(/\s+/g, ' ').slice(0, 300)}`);
    return text;
}

// Parsing a espressioni regolari: basta per contare, e lo script resta senza
// dipendenze. I prefissi di namespace cambiano fra installazioni (a:, b:…), e
// WCF apre i contratti con attributi (`<a:ContrattoArticolo z:Id="i1" …>`):
// senza ammetterli la demo dava 0 articoli su 348. I tag vuoti (`…/>`) no.
const blocchi = (xml, tag) => {
    const re = new RegExp(`<(?:\\w+:)?${tag}(?:\\s[^>]*)?(?<!/)>([\\s\\S]*?)</(?:\\w+:)?${tag}>`, 'g');
    return [...xml.matchAll(re)].map(m => m[1]);
};
const campo = (xml, tag) => {
    const m = xml.match(new RegExp(`<(?:\\w+:)?${tag}>([^<]*)</(?:\\w+:)?${tag}>`));
    return m ? m[1].trim() : null;
};
const numero = (s) => {
    const n = Number(String(s ?? '').replace(',', '.'));
    return Number.isFinite(n) ? n : 0;
};

const xml = await soapGet('GetArticoli', '<ultimaModifica>2000-01-01T00:00:00</ultimaModifica>');
// Le immagini incorporate pesano megabyte e non servono al conteggio.
const articoli = blocchi(xml.replace(/<(?:\w+:)?(?:ImmagineBin|FotoBin|AllegatoBin)>[^<]*<\/(?:\w+:)?(?:ImmagineBin|FotoBin|AllegatoBin)>/g, ''), 'ContrattoArticolo');

const perTipo = {};
let conCosto = 0, conDba = 0, conComponenti = 0, conPrezzoFornitore = 0;
const esempiCosto = [], esempiDba = [], esempiFornitore = [];
const materiePrime = { totale: 0, conCosto: 0, conFornitore: 0 };

// I contratti annidati (categoria, aliquota, listini…) hanno anche loro una
// Descrizione: i campi dell'articolo si leggono dopo averli tolti.
const ANNIDATI = ['AliquotaIVA', 'Categoria', 'Componenti', 'Fornitori', 'Magazzini', 'Prezzi', 'Alias', 'ScontoListino', 'SerieTaglia', 'DescrizioneInLingua', 'Extra'];
const soloArticolo = (a) => ANNIDATI.reduce(
    (acc, tag) => acc.replace(new RegExp(`<(?:\\w+:)?${tag}(?:\\s[^>]*)?>[\\s\\S]*?</(?:\\w+:)?${tag}>`, 'g'), ''),
    a,
);

for (const a of articoli) {
    const top = soloArticolo(a);
    const tipo = campo(top, 'TipoEnum') ?? '?';
    perTipo[tipo] = (perTipo[tipo] ?? 0) + 1;
    const descrizione = campo(top, 'Descrizione') ?? '';
    const costo = numero(campo(top, 'CostoUltimo'));
    const componenti = blocchi(a, 'PMBComponenteDB');
    const prezziFornitore = blocchi(a, 'PMBFornitoreArticolo').map(f => numero(campo(f, 'PrezzoBase'))).filter(p => p > 0);
    if (costo > 0) {
        conCosto++;
        if (esempiCosto.length < 5) esempiCosto.push(`${descrizione} (${tipo}): ${costo}`);
    }
    if (campo(top, 'IsDBA') === 'true') conDba++;
    if (componenti.length > 0) {
        conComponenti++;
        if (esempiDba.length < 5) esempiDba.push(`${descrizione}: ${componenti.length} componenti`);
    }
    if (prezziFornitore.length > 0) {
        conPrezzoFornitore++;
        if (esempiFornitore.length < 5) esempiFornitore.push(`${descrizione}: ${prezziFornitore.join(', ')}`);
    }
    if (tipo === 'MateriaPrima') {
        materiePrime.totale++;
        if (costo > 0) materiePrime.conCosto++;
        if (prezziFornitore.length > 0) materiePrime.conFornitore++;
    }
}

console.log(`Articoli: ${articoli.length}`);
console.log('Per tipo:', perTipo);
console.log(`Con costo ultimo > 0: ${conCosto}`);
for (const e of esempiCosto) console.log(`  · ${e}`);
console.log(`Con distinta base (IsDBA): ${conDba} — con componenti: ${conComponenti}`);
for (const e of esempiDba) console.log(`  · ${e}`);
console.log(`Con prezzo del fornitore: ${conPrezzoFornitore}`);
for (const e of esempiFornitore) console.log(`  · ${e}`);
console.log(`Materie prime: ${materiePrime.totale} (con costo ${materiePrime.conCosto}, con prezzo fornitore ${materiePrime.conFornitore})`);

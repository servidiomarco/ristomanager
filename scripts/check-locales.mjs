#!/usr/bin/env node
/**
 * Guardia di sincronia dei dizionari di public/locales.
 *
 * Il typecheck non vede le chiavi di traduzione: una chiave aggiunta solo in
 * italiano esce in italiano anche a chi ha l'inglese, e nessuno se ne accorge
 * finché non lo vede un cliente. Questo script è il controllo che manca, e in
 * CI vale per TUTTE le namespace (prenota, ordina, paytable, receipt, quote,
 * common, e quelle delle viste man mano che arrivano).
 *
 * Fallisce se, rispetto all'italiano (la lingua di riferimento):
 *   - manca il file di una namespace in una lingua;
 *   - mancano o avanzano chiavi;
 *   - i segnaposto {{var}} di una stessa chiave non coincidono;
 *   - una traduzione è vuota.
 *
 * Le forme plurali (chiave_one / chiave_other) sono chiavi come le altre:
 * italiano e inglese hanno le stesse due categorie, quindi il confronto
 * diretto basta.
 */
import fs from 'fs';
import path from 'path';

const BASE = path.join(process.cwd(), 'public', 'locales');
const RIFERIMENTO = 'it';

const flatten = (obj, prefix = '') => {
    const out = new Map();
    for (const [k, v] of Object.entries(obj)) {
        if (v && typeof v === 'object' && !Array.isArray(v)) {
            for (const [ck, cv] of flatten(v, `${prefix}${k}.`)) out.set(ck, cv);
        } else {
            out.set(`${prefix}${k}`, String(v));
        }
    }
    return out;
};

const placeholders = (s) => [...new Set(s.match(/\{\{\w+\}\}/g) ?? [])].sort().join(',');

const leggi = (lang, file) => {
    const p = path.join(BASE, lang, file);
    try {
        return flatten(JSON.parse(fs.readFileSync(p, 'utf8')));
    } catch (err) {
        return { errore: `${lang}/${file}: ${err.message}` };
    }
};

const errori = [];
const lingue = fs.readdirSync(BASE).filter(d => fs.statSync(path.join(BASE, d)).isDirectory());
const altre = lingue.filter(l => l !== RIFERIMENTO);
const namespaces = fs.readdirSync(path.join(BASE, RIFERIMENTO)).filter(f => f.endsWith('.json'));

if (namespaces.length === 0) errori.push(`Nessuna namespace in ${path.join(BASE, RIFERIMENTO)}`);

for (const file of namespaces) {
    const base = leggi(RIFERIMENTO, file);
    if (base.errore) { errori.push(base.errore); continue; }

    for (const lang of altre) {
        if (!fs.existsSync(path.join(BASE, lang, file))) {
            errori.push(`${lang}/${file}: file mancante (esiste in ${RIFERIMENTO})`);
            continue;
        }
        const tradotto = leggi(lang, file);
        if (tradotto.errore) { errori.push(tradotto.errore); continue; }

        for (const chiave of base.keys()) {
            if (!tradotto.has(chiave)) errori.push(`${lang}/${file}: manca la chiave "${chiave}"`);
        }
        for (const chiave of tradotto.keys()) {
            if (!base.has(chiave)) errori.push(`${lang}/${file}: chiave "${chiave}" assente in ${RIFERIMENTO}`);
        }
        for (const [chiave, valore] of tradotto) {
            if (!base.has(chiave)) continue;
            if (valore.trim() === '') errori.push(`${lang}/${file}: "${chiave}" è vuota`);
            const attesi = placeholders(base.get(chiave));
            const trovati = placeholders(valore);
            if (attesi !== trovati) {
                errori.push(`${lang}/${file}: "${chiave}" ha segnaposto [${trovati}], in ${RIFERIMENTO} sono [${attesi}]`);
            }
        }
    }
}


/* Una chiamata di traduzione dentro un attributo fra virgolette NON è codice:
 * è testo. «title={t('x')}» mostra la traduzione, «title="{t('x')}"» mostra
 * al cliente la stringa «{t('x')}». Il typecheck non può accorgersene — una
 * stringa fra virgolette è valida — e i test non guardano il frontend: è
 * successo davvero, su 67 attributi in 13 file, e in produzione si vedeva.
 */
const cercaAttributiRotti = (dir) => {
    const trovati = [];
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) { trovati.push(...cercaAttributiRotti(p)); continue; }
        if (!e.name.endsWith('.tsx')) continue;
        const righe = fs.readFileSync(p, 'utf8').split('\n');
        righe.forEach((riga, i) => {
            if (/="\s*\{\s*\w+\(/.test(riga)) trovati.push(`${p}:${i + 1}`);
        });
    }
    return trovati;
};

const attributiRotti = ['components', 'App.tsx'].flatMap(p =>
    fs.existsSync(p) ? (fs.statSync(p).isDirectory() ? cercaAttributiRotti(p)
        : (/="\s*\{\s*\w+\(/.test(fs.readFileSync(p, 'utf8')) ? [p] : [])) : []);
for (const t of attributiRotti) errori.push(`${t}: chiamata dentro un attributo fra virgolette — va in graffe, altrimenti il cliente legge il codice`);

/* Ogni chiave chiesta da un componente deve esistere e valere una stringa.
 *
 * i18next non fallisce su una chiave che non c'è: restituisce la chiave stessa,
 * e lo schermo mostra «noneAssignedToYou» al posto della frase. Peggio ancora
 * una chiave che esiste ma è un ramo di mappa — è successo con «priority», che
 * era insieme l'etichetta del campo e la mappa Alta/Media/Bassa: la seconda
 * definizione vince e t('priority') torna un oggetto. Il typecheck non vede
 * nulla in nessuno dei due casi.
 *
 * Si controllano i file che dichiarano una namespace sola. Una chiave scritta
 * «common:loading» va cercata in common qualunque sia la namespace del file:
 * è il modo di leggere un testo condiviso senza averne una copia per vista.
 */
const chiaviMancanti = [];
const scansiona = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) { scansiona(p); continue; }
        if (!e.name.endsWith('.tsx')) continue;
        const testo = fs.readFileSync(p, 'utf8');
        const ns = [...new Set([...testo.matchAll(/useTranslation\(\s*'([\w-]+)'/g)].map(m => m[1]))];
        if (ns.length !== 1) continue;
        const dizionarioDi = (nome) => {
            const file = path.join(BASE, RIFERIMENTO, `${nome}.json`);
            return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null;
        };
        if (!dizionarioDi(ns[0])) continue;
        const valore = (chiave, nome) => {
            const d = dizionarioDi(nome);
            return d ? chiave.split('.').reduce((o, k) => (o == null ? undefined : o[k]), d) : undefined;
        };
        // `t` e i suoi alias: dove `t` era già preso da un'altra variabile la
        // traduzione si chiama `tr` o `tv`. Niente `\w*`: matcherebbe toggle().
        for (const m of testo.matchAll(/\b(?:t|tr|tv)\(\s*'([\w.]+|[\w-]+:[\w.]+)'/g)) {
            const grezza = m[1];
            const conPrefisso = grezza.includes(':');
            const nome = conPrefisso ? grezza.split(':')[0] : ns[0];
            const chiave = conPrefisso ? grezza.split(':').slice(1).join(':') : grezza;
            // Una chiave al plurale non esiste da sola: vale per le sue due forme.
            const v = valore(chiave, nome) ?? valore(`${chiave}_other`, nome);
            const riga = testo.slice(0, m.index).split('\n').length;
            if (v === undefined) chiaviMancanti.push(`${p}:${riga}: "${chiave}" non esiste in ${nome}.json`);
            else if (typeof v !== 'string') chiaviMancanti.push(`${p}:${riga}: "${chiave}" in ${nome}.json è una mappa, non una stringa`);
        }
    }
};
if (fs.existsSync('components')) scansiona('components');
errori.push(...chiaviMancanti);

if (errori.length > 0) {
    console.error('Dizionari fuori sincrono:\n' + errori.map(e => `  - ${e}`).join('\n'));
    process.exit(1);
}

const totali = namespaces.map(f => `${f} (${leggi(RIFERIMENTO, f).size})`).join(', ');
console.log(`Dizionari allineati — lingue: ${lingue.join(', ')}; namespace: ${totali}`);

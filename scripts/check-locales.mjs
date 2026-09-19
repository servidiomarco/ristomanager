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

if (errori.length > 0) {
    console.error('Dizionari fuori sincrono:\n' + errori.map(e => `  - ${e}`).join('\n'));
    process.exit(1);
}

const totali = namespaces.map(f => `${f} (${leggi(RIFERIMENTO, f).size})`).join(', ');
console.log(`Dizionari allineati — lingue: ${lingue.join(', ')}; namespace: ${totali}`);

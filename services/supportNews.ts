// «Novità» (supporto, fase 4): cosa è cambiato nell'app, letto dal
// «Registro aggiornamenti» di docs/funzionalita-app.md. Ogni PR che cambia
// qualcosa di visibile ci aggiunge una riga (regola di CLAUDE.md), quindi le
// novità si scrivono da sole: nessun secondo posto da tenere allineato.
//
// Il file arriva nell'immagine dal Dockerfile (lo usa anche l'assistente).
// Si legge una volta per processo: cambia solo con un deploy.

import fs from 'fs';
import path from 'path';

export interface NewsEntry {
    date: string;
    section: string;
    text: string;
}

// Le righe che parlano di strumenti del team Sympotia (pannello, dev board,
// roadmap, consumi) non sono novità per chi lavora in un ristorante.
const INTERNAL_SECTION = /piattaforma|development|roadmap|consumi ai/i;

let cache: NewsEntry[] | null = null;

/** Il markdown della riga, reso testo: grassetti e codice non servono a chi
 *  legge una novità, e il client mostra testo semplice. */
const plain = (s: string): string => s
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/\\\|/g, '|')
    .trim();

export function parseNewsRegistry(markdown: string): NewsEntry[] {
    const start = markdown.indexOf('## Registro aggiornamenti');
    if (start < 0) return [];
    const entries: NewsEntry[] = [];
    for (const line of markdown.slice(start).split('\n')) {
        const m = /^\|\s*(\d{4}-\d{2}-\d{2})\s*\|(.+)\|\s*$/.exec(line);
        if (!m) continue;
        // Due colonne dopo la data: sezione e modifica. Una barra dentro il
        // testo (rara, ma possibile) resta nel testo.
        const rest = m[2];
        const cut = rest.indexOf('|');
        if (cut < 0) continue;
        const section = plain(rest.slice(0, cut));
        const text = plain(rest.slice(cut + 1));
        if (!section || !text || INTERNAL_SECTION.test(section)) continue;
        entries.push({ date: m[1], section, text });
    }
    // Più recenti in alto; a parità di data resta l'ordine del registro.
    return entries
        .map((e, i) => ({ e, i }))
        .sort((a, b) => (a.e.date === b.e.date ? a.i - b.i : a.e.date < b.e.date ? 1 : -1))
        .map(x => x.e);
}

export function loadNews(): NewsEntry[] {
    if (cache) return cache;
    try {
        const md = fs.readFileSync(path.resolve(process.cwd(), 'docs', 'funzionalita-app.md'), 'utf8');
        cache = parseNewsRegistry(md);
    } catch {
        cache = [];
    }
    return cache;
}

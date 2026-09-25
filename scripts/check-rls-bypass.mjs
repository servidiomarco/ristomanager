#!/usr/bin/env node
/**
 * Guardia dei bypass della RLS lato server.
 *
 * In produzione la RLS è rigida: una query senza contesto tenant vede zero
 * righe, una query dentro runAsPlatform vede TUTTI i tenant. Entrambe le cose
 * sono invisibili ai test normali (server superuser, RLS permissiva) e sono
 * la classe di guasti vista solo in produzione: print agent 21/08, gate del
 * nodo 16/09, cursore dell'upstream 24/09 — e, all'audit del 25/09, i bypass
 * da cui passavano i dati degli altri tenant.
 *
 * Il job CI con RLS rigida vede solo i percorsi coperti dai test. Questa
 * guardia vede TUTTI i call site: ogni punto che scavalca il contesto deve
 * dire perché, con un commento sulla stessa riga o su quella subito sopra:
 *
 *     // rls-bypass: <perché serve, e cosa scopa le query>
 *
 * Cosa conta come bypass (fuori da db.ts, che È lo strato del contesto):
 *   - runAsPlatform(          → app.rls_bypass: si vedono tutti i tenant;
 *   - pool.query(             → nessun contesto: zero righe con la RLS rigida;
 *   - new Pool( / new Client( → connessione fuori dal pool incartato;
 *   - set_config('app.…'      → contesto impostato a mano, fuori da db.ts.
 *
 * Un sito nuovo senza motivazione fa fallire la CI: non è un divieto, è
 * l'obbligo di scrivere il perché dove chi rilegge lo trova.
 */
import fs from 'fs';
import path from 'path';

const ROOT = process.cwd();
const FILES_SINGOLI = ['server.ts'];
const CARTELLE = ['auth', 'services', 'utils', 'activityLogs'];
const ESCLUSI = new Set(['db.ts']);
// Una riga sola: con una finestra più larga un sito nuovo scritto subito
// sotto uno già motivato passerebbe col marcatore del vicino.
const FINESTRA = 1;

const PATTERN = [
    { nome: 'runAsPlatform', re: /\brunAsPlatform\s*\(/ },
    { nome: 'pool.query nudo', re: /\bpool\.query\s*\(/ },
    { nome: 'connessione fuori dal pool', re: /\bnew\s+(?:pg\.)?(?:Pool|Client)\s*\(/ },
    { nome: 'contesto a mano', re: /set_config\(\s*'app\./ },
];
const MARCATORE = /rls-bypass:\s*\S/;

const elencaTs = (dir) => {
    const abs = path.join(ROOT, dir);
    if (!fs.existsSync(abs)) return [];
    const out = [];
    for (const voce of fs.readdirSync(abs, { withFileTypes: true })) {
        const rel = path.join(dir, voce.name);
        if (voce.isDirectory()) out.push(...elencaTs(rel));
        else if (voce.name.endsWith('.ts') && !voce.name.endsWith('.d.ts')) out.push(rel);
    }
    return out;
};

const eCommento = (riga) => {
    const t = riga.trim();
    return t.startsWith('//') || t.startsWith('*') || t.startsWith('/*');
};

const file = [...FILES_SINGOLI, ...CARTELLE.flatMap(elencaTs)]
    .filter(f => !ESCLUSI.has(path.basename(f)))
    .sort();

const senzaMotivo = [];
let motivati = 0;

for (const rel of file) {
    const righe = fs.readFileSync(path.join(ROOT, rel), 'utf8').split('\n');
    righe.forEach((riga, i) => {
        if (eCommento(riga)) return;
        const colpito = PATTERN.find(p => p.re.test(riga));
        if (!colpito) return;
        const contesto = righe.slice(Math.max(0, i - FINESTRA), i + 1);
        if (contesto.some(r => MARCATORE.test(r))) {
            motivati++;
            return;
        }
        senzaMotivo.push(`${rel}:${i + 1}  [${colpito.nome}]  ${riga.trim().slice(0, 100)}`);
    });
}

if (senzaMotivo.length > 0) {
    console.error(`✗ ${senzaMotivo.length} bypass della RLS senza motivazione:\n`);
    for (const s of senzaMotivo) console.error(`  ${s}`);
    console.error(
        '\nOgni sito vuole un «// rls-bypass: <perché>» sulla stessa riga o su quella subito sopra.' +
        '\nPrima di scriverlo: dentro runAsPlatform ogni query deve filtrare per tenant_id da sola;' +
        '\nun pool.query nudo sul cloud vede zero righe con la RLS rigida (usare queryWithRetry).'
    );
    process.exit(1);
}

console.log(`✓ ${motivati} bypass della RLS, tutti motivati (${file.length} file controllati)`);

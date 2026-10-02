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
 * Questa guardia vede i bypass ESPLICITI, anche sui percorsi che nessun test
 * esercita: ogni punto che scavalca il contesto deve dire perché, con un
 * commento sulla riga subito sopra (o in coda alla riga stessa):
 *
 *     // rls-bypass: <perché serve, e cosa scopa le query>
 *
 * Cosa conta come bypass (fuori da db.ts, che È lo strato del contesto):
 *   - runAsPlatform           → app.rls_bypass: si vedono tutti i tenant;
 *   - pool.query / pool?.query / pool.connect a callback
 *                             → nessun contesto: zero righe con la RLS rigida;
 *   - new Pool( / new Client( → connessione fuori dal pool incartato;
 *   - set_config('app.… / SET app.… → contesto impostato a mano;
 *   - import del pool o di runAsPlatform sotto un altro nome.
 *
 * Cosa NON vede, e resta compito del job CI «Test API (RLS rigida)»: un
 * queryWithRetry lanciato dove il contesto non c'è (handler socket, callback
 * di EventEmitter: zero righe), e il codice che il contesto lo EREDITA, come
 * i timer avviati dentro un runAsPlatform (vedono tutti i tenant).
 *
 * Un sito nuovo senza motivazione fa fallire la CI: non è un divieto, è
 * l'obbligo di scrivere il perché dove chi rilegge lo trova.
 */
import fs from 'fs';
import path from 'path';

const ROOT = process.cwd();
const CARTELLE = ['auth', 'services', 'utils', 'activityLogs'];
const ESCLUSO = 'db.ts';

const PATTERN = [
    { nome: 'runAsPlatform', re: /\brunAsPlatform\b/ },
    {
        nome: 'pool senza contesto',
        // pool.query, pool?.query, (pool as any).query, pool.query<T>(,
        // e la forma a callback di pool.connect, che db.ts lascia nuda.
        re: /\bpool\s*\)?\s*(?:\?\.|\.)\s*query\b|\bpool\s+as\s|\bpool\.connect\s*\(\s*(?:function\b|\(|[A-Za-z_$])/,
    },
    { nome: 'connessione fuori dal pool', re: /\bnew\s+(?:pg\.)?(?:Pool|Client)\s*\(/ },
    { nome: 'contesto a mano', re: /set_config\s*\(\s*\\?['"`]app\.|\bSET\s+(?:LOCAL\s+|SESSION\s+)?app\./i },
];
const IMPORT_DB = /^\s*import\b.*['"](?:\.\.?\/)+db(?:\.js)?['"]/;
// Default import del pool con un nome diverso da `pool`, o runAsPlatform
// rinominato: la guardia cerca quei nomi, un alias la renderebbe cieca.
const ALIAS = /\brunAsPlatform\s+as\b|^\s*import\s+(?!pool\b)[A-Za-z_$][\w$]*\s*(?:,|from)/;
const MARCATORE = /rls-bypass:\s*\S/;
const MARCATORE_IN_CODA = /\/\/.*rls-bypass:\s*\S/;

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

// Tutti i .ts della radice (server.ts e i moduli che importa) più le
// cartelle lato server; db.ts escluso per percorso, non per nome.
const radice = fs.readdirSync(ROOT, { withFileTypes: true })
    .filter(v => v.isFile() && v.name.endsWith('.ts') && !v.name.endsWith('.d.ts'))
    .map(v => v.name);
const file = [...radice, ...CARTELLE.flatMap(elencaTs)]
    .filter(f => f !== ESCLUSO)
    .sort();

// Toglie i commenti (// e /* … */, anche su più righe) e dice se la riga è
// solo commento. Tiene conto delle stringhe, così un «/public/*» in un
// commento o in un path non apre un finto commento a blocco che nasconde il
// codice dopo. Il CONTENUTO delle stringhe resta: il SET app.… sta nell'SQL.
// I template literal attraversano le righe (l'SQL è quasi tutto lì).
const spogliaCommenti = (righe) => {
    let stato = 'codice'; // 'codice' | 'blocco' | "'" | '"' | '`'
    return righe.map((riga) => {
        let codice = '';
        for (let i = 0; i < riga.length; i++) {
            const c = riga[i];
            const due = riga.slice(i, i + 2);
            if (stato === 'blocco') {
                if (due === '*/') { stato = 'codice'; i++; }
                continue;
            }
            if (stato === 'codice') {
                if (due === '//') break;
                if (due === '/*') { stato = 'blocco'; i++; continue; }
                if (c === "'" || c === '"' || c === '`') stato = c;
                codice += c;
                continue;
            }
            // Dentro una stringa: il carattere resta, si esce sulla chiusa.
            codice += c;
            if (c === '\\') { codice += riga[i + 1] ?? ''; i++; continue; }
            if (c === stato) stato = 'codice';
        }
        // Gli apici singoli e doppi non attraversano la riga.
        if (stato === "'" || stato === '"') stato = 'codice';
        const t = codice.trim();
        return { codice, soloCommento: t === '' };
    });
};

const senzaMotivo = [];
let motivati = 0;

for (const rel of file) {
    const righe = fs.readFileSync(path.join(ROOT, rel), 'utf8').split(/\r?\n/);
    const spogliate = spogliaCommenti(righe);
    righe.forEach((riga, i) => {
        const { codice, soloCommento } = spogliate[i];
        if (soloCommento) return;
        const segnala = (nome) => senzaMotivo.push(`${rel}:${i + 1}  [${nome}]  ${riga.trim().slice(0, 100)}`);
        if (IMPORT_DB.test(codice)) {
            if (ALIAS.test(codice)) segnala('alias del pool o di runAsPlatform');
            return;
        }
        const colpito = PATTERN.find(p => p.re.test(codice));
        if (!colpito) return;
        // Il marcatore vale solo come commento: sulla riga subito sopra, se
        // quella è un commento, o in coda alla riga stessa. Così un marcatore
        // in coda al sito vicino, o dentro una stringa, non copre questo.
        const sopra = i > 0 && spogliate[i - 1].soloCommento && MARCATORE.test(righe[i - 1]);
        if (sopra || MARCATORE_IN_CODA.test(riga)) {
            motivati++;
            return;
        }
        segnala(colpito.nome);
    });
}

if (senzaMotivo.length > 0) {
    console.error(`✗ ${senzaMotivo.length} bypass della RLS senza motivazione:\n`);
    for (const s of senzaMotivo) console.error(`  ${s}`);
    console.error(
        '\nOgni sito vuole un «// rls-bypass: <perché>» sulla riga subito sopra (o in coda alla riga).' +
        '\nPrima di scriverlo: dentro runAsPlatform ogni query deve filtrare per tenant_id da sola;' +
        '\nun pool.query nudo sul cloud vede zero righe con la RLS rigida (usare queryWithRetry).'
    );
    process.exit(1);
}

console.log(`✓ ${motivati} bypass della RLS, tutti motivati (${file.length} file controllati)`);

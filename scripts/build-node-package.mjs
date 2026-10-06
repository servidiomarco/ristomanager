#!/usr/bin/env node
// Costruisce il pacchetto installabile del nodo di sala (fase A4 del piano
// «sala, comande e conto sul nodo»): una cartella autosufficiente, con la
// sua versione, da appoggiare nella inbox del supervisore (o in versions/
// alla prima installazione). Uguale per Windows, Linux e Mac: le dipendenze
// sono tutte JavaScript, serve solo Node >= 20 sulla macchina.
//
//   npm run package:node            → build/nodo/<sha>/
//   npm run package:node -- --zip   → in più build/nodo/sympotia-nodo-<sha>.zip
//
// Dentro: dist/ (server + agente Passepartout compilati), node_modules di
// produzione, migrations/, public/, i manuali che il server legge,
// scripts/print-agent.mjs, sala-node/supervisor.mjs, build-info.json.

import { execFileSync, execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { stdio: 'inherit', ...opts });

const sha = (() => {
    if (process.env.BUILD_SHA) return process.env.BUILD_SHA.slice(0, 7);
    try { return execSync('git rev-parse --short=7 HEAD', { encoding: 'utf8' }).trim(); } catch { return 'dev'; }
})();
const dirty = (() => {
    try { return execSync('git status --porcelain', { encoding: 'utf8' }).trim() !== ''; } catch { return false; }
})();
if (dirty) console.warn('⚠️  modifiche non committate: il pacchetto non corrisponde esattamente a', sha);

const outBase = path.join(root, 'build', 'nodo');
const out = path.join(outBase, sha);
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });

console.log(`📦 pacchetto del nodo ${sha} → ${out}`);
run('npx', ['tsc', '-p', 'tsconfig.nodepkg.json', '--outDir', path.join(out, 'dist')], { shell: process.platform === 'win32' });

const copy = (rel, dest = rel) => {
    const from = path.join(root, rel);
    if (!fs.existsSync(from)) return;
    fs.cpSync(from, path.join(out, dest), { recursive: true });
};
copy('migrations');
copy('public');
copy('package.json');
copy('package-lock.json');
copy('scripts/print-agent.mjs');
copy('sala-node/supervisor.mjs');
copy('sala-node/README.md', 'LEGGIMI-nodo.md');
for (const doc of ['docs/funzionalita-app.md', 'docs/Manuale_Utente_CRM.md', 'docs/manuale-operativo-comande-cucina-passe.md']) copy(doc);

run('npm', ['ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: out, shell: process.platform === 'win32' });

fs.writeFileSync(path.join(out, 'build-info.json'), JSON.stringify({
    sha,
    dirty,
    built_at: new Date().toISOString(),
    node: process.version,
}, null, 2));

if (process.argv.includes('--zip')) {
    const zip = path.join(outBase, `sympotia-nodo-${sha}.zip`);
    fs.rmSync(zip, { force: true });
    run('zip', ['-qr', zip, '.'], { cwd: out });
    console.log(`🗜️  ${zip}`);
}
console.log(`✅ pronto. Sul nodo: copialo in inbox/ (aggiornamento) o in versions/ (prima installazione).`);

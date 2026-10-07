#!/usr/bin/env node
// Costruisce il pacchetto LEGGERO dell'agente della cassa Passepartout (piano
// «Passepartout plug and play», punto 3): per i ristoranti che hanno solo la
// cassa, senza nodo di sala. Un solo file JavaScript con le dipendenze dentro
// (socket.io-client, fast-xml-parser), niente server, niente node_modules:
// poche centinaia di KB invece dei ~40 MB del pacchetto del nodo, che resta
// per chi il nodo ce l'ha (scripts/build-node-package.mjs).
//
//   npm run package:agent            → build/agente/<sha>/
//   npm run package:agent -- --zip   → in più build/agente/sympotia-agente-<sha>.zip
//
// Dentro: passepartout-agent.js, package.json (type module),
// sala-node/supervisor.mjs, build-info.json. In build-info.json
// `contenuto_sha256` è l'impronta di agente e supervisore: due build dello
// stesso codice la danno uguale, così il cloud non pubblica un «rilascio»
// nuovo a ogni merge che non tocca l'agente.

import { execFileSync, execSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { build } from 'esbuild';

const root = process.cwd();

const sha = (() => {
    if (process.env.BUILD_SHA) return process.env.BUILD_SHA.slice(0, 7);
    try { return execSync('git rev-parse --short=7 HEAD', { encoding: 'utf8' }).trim(); } catch { return 'dev'; }
})();
const dirty = (() => {
    try { return execSync('git status --porcelain', { encoding: 'utf8' }).trim() !== ''; } catch { return false; }
})();
if (dirty) console.warn('⚠️  modifiche non committate: il pacchetto non corrisponde esattamente a', sha);

const outBase = path.join(root, 'build', 'agente');
const out = path.join(outBase, sha);
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });

console.log(`📦 agente leggero ${sha} → ${out}`);
await build({
    entryPoints: [path.join(root, 'scripts', 'passepartout-agent.ts')],
    outfile: path.join(out, 'passepartout-agent.js'),
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node20',
    // Le dipendenze CommonJS dentro un bundle ESM chiamano require() sui
    // moduli di Node: glielo si dà.
    banner: { js: "import { createRequire as __creaRequire } from 'node:module'; const require = __creaRequire(import.meta.url);" },
    // Il codice per i browser di socket.io-client/engine.io non serve.
    mainFields: ['module', 'main'],
    conditions: ['node'],
    legalComments: 'none',
    logLevel: 'warning',
});

fs.writeFileSync(path.join(out, 'package.json'), JSON.stringify({ name: 'sympotia-agente-cassa', private: true, type: 'module' }, null, 2));
fs.cpSync(path.join(root, 'sala-node', 'supervisor.mjs'), path.join(out, 'supervisor.mjs'));

const impronta = crypto.createHash('sha256');
for (const f of ['passepartout-agent.js', 'supervisor.mjs']) impronta.update(fs.readFileSync(path.join(out, f)));
fs.writeFileSync(path.join(out, 'build-info.json'), JSON.stringify({
    sha,
    dirty,
    tipo: 'agente',
    contenuto_sha256: impronta.digest('hex'),
    built_at: new Date().toISOString(),
    node: process.version,
}, null, 2));

const kb = Math.round(fs.statSync(path.join(out, 'passepartout-agent.js')).size / 1024);
console.log(`   passepartout-agent.js ${kb} KB`);

if (process.argv.includes('--zip')) {
    const zip = path.join(outBase, `sympotia-agente-${sha}.zip`);
    fs.rmSync(zip, { force: true });
    execFileSync('zip', ['-qr', zip, '.'], { cwd: out, stdio: 'inherit' });
    console.log(`🗜️  ${zip} (${Math.round(fs.statSync(zip).size / 1024)} KB)`);
}
console.log('✅ pronto.');

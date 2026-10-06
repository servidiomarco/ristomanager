// La versione che gira, uguale per cloud e nodo di sala (fase A3 del piano
// «sala, comande e conto sul nodo»).
//
// Prima era una stringa fissa ('2026-04-29-v3' nel log di avvio,
// 'service-node-4' nel battito del nodo): il cloud non sapeva quale codice
// girasse sul PC del locale, e un nodo rimasto indietro di settimane
// sembrava uguale a uno appena aggiornato.
//
// In ordine: BUILD_SHA (la imposta chi impacchetta il nodo), lo SHA del
// commit che Railway mette nell'ambiente, un build-info.json accanto a dist/
// (lo scriverà il pacchetto del nodo, fase A4). Altrimenti 'dev'.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const short = (sha: string): string => sha.trim().slice(0, 7);

export const BUILD_VERSION: string = (() => {
    const fromEnv = process.env.BUILD_SHA || process.env.RAILWAY_GIT_COMMIT_SHA || '';
    if (fromEnv.trim()) return short(fromEnv);
    try {
        const file = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'build-info.json');
        const sha = JSON.parse(readFileSync(file, 'utf8'))?.sha;
        if (typeof sha === 'string' && sha.trim()) return short(sha);
    } catch { /* nessun build-info.json: build locale */ }
    return 'dev';
})();

// Il log del nodo su FILE (profilo service-node) — lezione del collaudo
// del 23/09: la Scheduled Task gira come SYSTEM, headless, e quando il
// socket uplink è rimasto muto 90 minuti non c'era UN rigo da leggere da
// nessuna parte. Da qui in poi ogni console.log/warn/error del nodo
// finisce anche in SALA_NODE_STATE_DIR\\sala-node.log, con rotazione
// semplice a taglia (il file pieno diventa .old e si riparte): due file,
// mai più di ~10MB totali, zero manutenzione.
//
// Sul cloud non fa nulla: lì i log li tiene Railway.

import { appendFileSync, statSync, renameSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { isServiceNode } from './topology.js';

const MAX_BYTES = 5 * 1024 * 1024;

export const initSalaNodeFileLog = (): void => {
    if (!isServiceNode) return;
    const dir = process.env.SALA_NODE_STATE_DIR || process.cwd();
    const file = path.join(dir, 'sala-node.log');
    try { mkdirSync(dir, { recursive: true }); } catch { /* già c'è */ }

    const rotateIfFat = () => {
        try {
            if (statSync(file).size > MAX_BYTES) renameSync(file, `${file}.old`);
        } catch { /* file assente: nascerà */ }
    };

    const write = (level: string, args: any[]) => {
        try {
            rotateIfFat();
            const line = args.map(a => {
                if (typeof a === 'string') return a;
                if (a instanceof Error) return a.stack || a.message;
                try { return JSON.stringify(a); } catch { return String(a); }
            }).join(' ');
            appendFileSync(file, `${new Date().toISOString()} [${level}] ${line}\n`);
        } catch { /* il log non deve mai far cadere il nodo */ }
    };

    for (const level of ['log', 'warn', 'error'] as const) {
        const original = console[level].bind(console);
        console[level] = (...args: any[]) => {
            original(...args);
            write(level, args);
        };
    }
    console.log(`[node-log] log su file attivo: ${file}`);
};

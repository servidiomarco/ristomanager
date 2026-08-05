// Agente LAN Passepartout — gira su un computer della rete del ristorante
// (tipicamente il server Windows del Menù) e fa da ponte fra il backend su
// Railway e il gestionale, che dal cloud non è raggiungibile.
//
// Direzione della connessione: l'agente si collega LUI al backend (namespace
// socket.io `/pp-agent`), quindi sul router del ristorante non si apre nulla.
// Il backend gli invia richieste `pp:call { op, params }` e l'agente risponde
// via ack con { ok, result } o { ok: false, error, kind }.
//
// Avvio (dal checkout del repo, Node >= 20):
//   PASSEPARTOUT_WS_URL=http://192.168.1.10:7606/AdapterWS \
//   PASSEPARTOUT_WS_USER=... PASSEPARTOUT_WS_PASSWORD=... \
//   PP_AGENT_SERVER_URL=https://prenotazioni.vecchiofrantoio.com \
//   PP_AGENT_TOKEN=<stesso valore di PASSEPARTOUT_AGENT_TOKEN su Railway> \
//   node --loader ts-node/esm scripts/passepartout-agent.ts
//
// Su Windows conviene registrarlo come servizio (nssm) o operazione
// pianificata all'avvio. La riconnessione è automatica (socket.io).

import os from 'os';
import { io } from 'socket.io-client';
import {
    getVersioneGestionale,
    getComandaTavolo,
    getComanda,
    getTipiPagamento,
    getSaleMenu,
    getConto,
    isPassepartoutConfigured,
    PassepartoutError,
} from '../services/passepartoutService.js';

const SERVER_URL = (process.env.PP_AGENT_SERVER_URL || '').trim();
const TOKEN = (process.env.PP_AGENT_TOKEN || '').trim();

if (!SERVER_URL || !TOKEN) {
    console.error('Config mancante: servono PP_AGENT_SERVER_URL e PP_AGENT_TOKEN.');
    process.exit(1);
}
if (!isPassepartoutConfigured()) {
    console.error('Config mancante: servono PASSEPARTOUT_WS_URL e PASSEPARTOUT_WS_USER (più password).');
    process.exit(1);
}

type Handler = (params: Record<string, any>) => Promise<unknown>;

const handlers: Record<string, Handler> = {
    versione: () => getVersioneGestionale(),
    comandaTavolo: (p) => {
        if (typeof p?.tavolo !== 'string' || !p.tavolo) throw new Error('Parametro "tavolo" mancante');
        return getComandaTavolo(p.tavolo);
    },
    comanda: (p) => {
        const id = Number(p?.idGestionale);
        if (!Number.isFinite(id)) throw new Error('Parametro "idGestionale" non valido');
        return getComanda(id);
    },
    tipiPagamento: () => getTipiPagamento(),
    sale: () => getSaleMenu(),
    conto: (p) => {
        const id = Number(p?.idGestionale);
        if (!Number.isFinite(id)) throw new Error('Parametro "idGestionale" non valido');
        return getConto(id);
    },
    // NOTA: 'chiudi' (ContoComanda) volutamente NON esposto finché il
    // rivenditore non chiarisce la finalizzazione del conto — vedi memoria
    // di progetto: lo scontrino esce ma il conto resta sospeso.
};

const socket = io(`${SERVER_URL}/pp-agent`, {
    auth: { token: TOKEN },
    transports: ['websocket', 'polling'],
    reconnectionDelay: 2_000,
    reconnectionDelayMax: 30_000,
});

socket.on('connect', async () => {
    console.log(`[agent] connesso a ${SERVER_URL} come ${socket.id}`);
    let versioneGestionale: string | undefined;
    try {
        versioneGestionale = (await getVersioneGestionale()) ?? undefined;
        console.log(`[agent] gestionale raggiungibile, versione ${versioneGestionale}`);
    } catch (err) {
        console.warn('[agent] gestionale non raggiungibile al momento:', (err as Error).message);
    }
    socket.emit('agent:hello', { hostname: os.hostname(), versioneGestionale });
});

socket.on('connect_error', (err) => {
    console.warn('[agent] connessione rifiutata:', err.message);
});

socket.on('disconnect', (reason) => {
    console.log(`[agent] disconnesso (${reason}), riconnessione automatica...`);
});

socket.on('pp:call', async (payload: any, ack: (r: unknown) => void) => {
    const op = String(payload?.op || '');
    const started = Date.now();
    try {
        const handler = handlers[op];
        if (!handler) throw new Error(`Operazione sconosciuta: ${op}`);
        const result = await handler(payload?.params ?? {});
        console.log(`[agent] ${op} ok in ${Date.now() - started}ms`);
        ack({ ok: true, result });
    } catch (err) {
        const isGestionale = err instanceof PassepartoutError;
        console.warn(`[agent] ${op} errore (${isGestionale ? 'gestionale' : 'agent'}):`, (err as Error).message);
        ack({ ok: false, error: (err as Error).message, kind: isGestionale ? 'gestionale' : 'agent' });
    }
});

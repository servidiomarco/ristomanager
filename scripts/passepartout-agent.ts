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
//
// Fase B5: con PP_AGENT_NODE_URL l'agente si collega ANCHE al nodo di sala
// (stesso PC), con lo stesso token: con l'autorità in sala i conti nascono
// e si chiudono lì, e a linea caduta il cloud non c'è. Ognuno dei due
// server chiama l'agente per i conti che possiede; l'agente fa una
// chiusura alla volta per comanda.

import os from 'os';
import { io } from 'socket.io-client';
import {
    getVersioneGestionale,
    getComandaTavolo,
    getComanda,
    getTipiPagamento,
    getSaleMenu,
    getConto,
    getArticoliMenu,
    inviaProduzioneComanda,
    chiudiComandaCompleta,
    isPassepartoutConfigured,
    PassepartoutError,
    type TipoDocumentoConto,
} from '../services/passepartoutService.js';

const SERVER_URL = (process.env.PP_AGENT_SERVER_URL || '').trim();
const NODE_URL = (process.env.PP_AGENT_NODE_URL || '').trim().replace(/\/+$/, '');
const TOKEN = (process.env.PP_AGENT_TOKEN || '').trim();
// Cosa sa fare questo agente, annunciato nell'agent:hello: il server
// riprova da solo una chiusura solo con un agente che sa riprenderla.
const CAPABILITIES = ['chiudi-riprendi'];

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
    invia: (p) => {
        const id = Number(p?.idComanda);
        if (!Number.isFinite(id)) throw new Error('Parametro "idComanda" non valido');
        return inviaProduzioneComanda({ idComanda: id, inviaTutto: true });
    },
    // Catalogo articoli per l'import menu del CRM (senza immagini: il payload
    // deve stare nel buffer del socket).
    articoli: (p) => getArticoliMenu(typeof p?.ultimaModifica === 'string' ? p.ultimaModifica : undefined),
    // Introspezione del contratto WCF: scarica ?wsdl dall'AdapterWS e torna
    // il SOLO elenco operazioni (il contratto intero può superare il buffer
    // del socket — per quello c'è scripts/passepartout-scopri-ws.mjs in LAN).
    wsdl: async () => {
        const base = (process.env.PASSEPARTOUT_WS_URL || '').trim().replace(/\/$/, '');
        if (!base) throw new Error('PASSEPARTOUT_WS_URL non configurato');
        for (const suffix of ['?singleWsdl', '?wsdl']) {
            try {
                const res = await fetch(base + suffix, { signal: AbortSignal.timeout(15_000) });
                if (!res.ok) continue;
                const text = await res.text();
                const operations = [...new Set([...text.matchAll(/<wsdl:operation name="([^"]+)"/g)].map(m => m[1]))].sort();
                if (operations.length === 0) continue;
                const writeCandidates = operations.filter(op =>
                    /^(Write|Set|Insert|Inserisci|Crea|Nuova?|Apri|Add|Aggiungi|Salva|Registra|Update|Modifica)/i.test(op)
                    && /Comand|Cont[oi]|Tavol|Rig[ah]/i.test(op));
                return { source: suffix, size: text.length, operations, write_candidates: writeCandidates };
            } catch { /* si prova il suffisso successivo */ }
        }
        throw new Error('Metadati WCF non esposti: usare scripts/passepartout-scopri-ws.mjs probe dalla LAN');
    },
    // Chiusura del conto secondo la ricetta del supporto (25/08): invio
    // separato solo se servono righe mai inviate, ContoComanda sempre con
    // noInvio=true, verdetto finale da GetContiGiorno. Il vecchio blocco
    // "scontrino esce ma conto resta sospeso" era il conflitto di timeStmp
    // dell'invio contestuale — vedi chiudiComandaCompleta.
    chiudi: (p) => {
        const id = Number(p?.idComanda);
        if (!Number.isFinite(id)) throw new Error('Parametro "idComanda" non valido');
        return unaAllaVolta(id, () => chiudiComandaCompleta({
            idComanda: id,
            tipoPagamento: typeof p?.tipoPagamento === 'string' && p.tipoPagamento ? p.tipoPagamento : undefined,
            tipoDocumento: typeof p?.tipoDocumento === 'string' && p.tipoDocumento
                ? (p.tipoDocumento as TipoDocumentoConto) : undefined,
            importoPagato: p?.importoPagato != null && Number.isFinite(Number(p.importoPagato))
                ? Number(p.importoPagato) : undefined,
            proforma: p?.proforma === true,
            riprendi: p?.riprendi === true,
        }));
    },
};

// Una chiusura alla volta per comanda: due richieste ravvicinate (un
// ritentativo dello spazzino mentre la prima è ancora in corso, o i due
// server) si mettono in fila, e la seconda — con riprendi — trova il conto
// già in archivio invece di farne un altro.
const inCorso = new Map<number, Promise<unknown>>();
function unaAllaVolta<T>(idComanda: number, fn: () => Promise<T>): Promise<T> {
    const prima = inCorso.get(idComanda) ?? Promise.resolve();
    const questa = prima.catch(() => undefined).then(fn);
    inCorso.set(idComanda, questa);
    void questa.finally(() => { if (inCorso.get(idComanda) === questa) inCorso.delete(idComanda); }).catch(() => undefined);
    return questa;
}

const collega = (nome: string, base: string) => {
    const socket = io(`${base}/pp-agent`, {
        auth: { token: TOKEN },
        transports: ['websocket', 'polling'],
        reconnectionDelay: 2_000,
        reconnectionDelayMax: 30_000,
    });

    socket.on('connect', async () => {
        console.log(`[agent:${nome}] connesso a ${base} come ${socket.id}`);
        let versioneGestionale: string | undefined;
        try {
            versioneGestionale = (await getVersioneGestionale()) ?? undefined;
            console.log(`[agent:${nome}] gestionale raggiungibile, versione ${versioneGestionale}`);
        } catch (err) {
            console.warn(`[agent:${nome}] gestionale non raggiungibile al momento:`, (err as Error).message);
        }
        socket.emit('agent:hello', { hostname: os.hostname(), versioneGestionale, capabilities: CAPABILITIES });
    });

    socket.on('connect_error', (err) => {
        console.warn(`[agent:${nome}] connessione rifiutata:`, err.message);
    });

    socket.on('disconnect', (reason) => {
        console.log(`[agent:${nome}] disconnesso (${reason}), riconnessione automatica...`);
    });

    socket.on('pp:call', async (payload: any, ack: (r: unknown) => void) => {
        const op = String(payload?.op || '');
        const started = Date.now();
        try {
            const handler = handlers[op];
            if (!handler) throw new Error(`Operazione sconosciuta: ${op}`);
            const result = await handler(payload?.params ?? {});
            console.log(`[agent:${nome}] ${op} ok in ${Date.now() - started}ms`);
            ack({ ok: true, result });
        } catch (err) {
            const isGestionale = err instanceof PassepartoutError;
            console.warn(`[agent:${nome}] ${op} errore (${isGestionale ? 'gestionale' : 'agent'}):`, (err as Error).message);
            ack({ ok: false, error: (err as Error).message, kind: isGestionale ? 'gestionale' : 'agent' });
        }
    });
};

collega('cloud', SERVER_URL);
if (NODE_URL) collega('nodo', NODE_URL);

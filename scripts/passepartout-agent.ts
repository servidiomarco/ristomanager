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
//   PP_AGENT_TOKEN=<tenants.passepartout_agent_token del ristorante; per il
//                   ristorante 1 vale anche PASSEPARTOUT_AGENT_TOKEN su Railway> \
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
    sincronizzaPrenotazione,
    annullaPrenotazione,
    getPrenotazioniMenuGiorno,
    getPiantaSale,
    getContiCassaGiorno,
    getComandeAperte,
    precontoUnaVolta,
    isPassepartoutConfigured,
    PassepartoutError,
    type TipoDocumentoConto,
    type StatoPrenotazioneCassa,
} from '../services/passepartoutService.js';

const SERVER_URL = (process.env.PP_AGENT_SERVER_URL || '').trim();
const NODE_URL = (process.env.PP_AGENT_NODE_URL || '').trim().replace(/\/+$/, '');
const TOKEN = (process.env.PP_AGENT_TOKEN || '').trim();
// Cosa sa fare questo agente, annunciato nell'agent:hello: il server
// riprova da solo una chiusura solo con un agente che sa riprenderla, e
// manda prenotazioni solo a un agente che sa scriverle, e chiede i conti
// del giorno solo a uno che sa leggerli. 'chiudi-preconto': la chiusura
// regge una comanda col preconto stampato; 'preconto': sa stamparlo (il
// tavolo che vuole pagare dal QR diventa blu in cassa).
const CAPABILITIES = ['chiudi-riprendi', 'prenotazioni', 'conti', 'tavoli-aperti', 'chiudi-preconto', 'preconto'];

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
    // Prenotazioni del CRM nel planning della cassa. Una alla volta per
    // prenotazione, come le chiusure: due giri ravvicinati del server non
    // devono creare due volte la stessa.
    prenotazione: (p) => {
        const tag = typeof p?.tag === 'string' ? p.tag : '';
        if (!/^sympotia:\d+$/.test(tag)) throw new Error('Parametro "tag" non valido');
        const idGestionale = p?.idGestionale != null && Number.isFinite(Number(p.idGestionale)) ? Number(p.idGestionale) : null;
        const statoAtteso = typeof p?.statoAtteso === 'string' ? p.statoAtteso : null;
        if (p?.azione === 'annulla') {
            const giorno = typeof p?.giorno === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(p.giorno) ? p.giorno : '';
            // Senza numero si cerca per tag nel giorno: lì il giorno serve.
            if (!giorno && idGestionale == null) throw new Error('Parametro "giorno" non valido');
            return unaAllaVolta(tag, () => annullaPrenotazione({ idGestionale, tag, giorno, statoAtteso }));
        }
        const tavoli = Array.isArray(p?.tavoli) ? p.tavoli.filter((t: unknown): t is string => typeof t === 'string' && t !== '') : [];
        if (typeof p?.sala !== 'string' || !p.sala || tavoli.length === 0) throw new Error('Sala e tavoli obbligatori');
        if (typeof p?.dataOra !== 'string') throw new Error('Parametro "dataOra" mancante');
        return unaAllaVolta(tag, () => sincronizzaPrenotazione({
            idGestionale,
            idDati: typeof p?.idDati === 'string' ? p.idDati : null,
            dataOra: p.dataOra,
            durata: Number(p?.durata) || 60,
            sala: p.sala,
            tavoli,
            intestazione: String(p?.intestazione ?? ''),
            telefono: typeof p?.telefono === 'string' ? p.telefono : null,
            note: typeof p?.note === 'string' ? p.note : null,
            numeroPersone: Number(p?.numeroPersone) || 1,
            adulti: Number(p?.adulti) || 0,
            bambini: Number(p?.bambini) || 0,
            stato: (typeof p?.stato === 'string' ? p.stato : 'Confermata') as StatoPrenotazioneCassa,
            tag,
            statoAtteso,
        }));
    },
    prenotazioniGiorno: (p) => {
        const giorno = typeof p?.giorno === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(p.giorno) ? p.giorno : '';
        if (!giorno) throw new Error('Parametro "giorno" non valido');
        return getPrenotazioniMenuGiorno(giorno);
    },
    // Sale e tavoli coi nomi della cassa, per abbinare i tavoli del CRM.
    piantaSale: () => getPiantaSale(),
    // Conti chiusi del giorno con tavolo e prenotazione: report, spesa per
    // cliente e riscontro nel CRM. Sola lettura.
    contiGiorno: (p) => {
        const giorno = typeof p?.giorno === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(p.giorno) ? p.giorno : '';
        if (!giorno) throw new Error('Parametro "giorno" non valido');
        return getContiCassaGiorno(giorno);
    },
    // Comande ancora aperte sui tavoli: sala e disponibilità del CRM.
    comandeAperte: () => getComandeAperte(),
    preconto: (p) => {
        const id = Number(p?.idComanda);
        if (!Number.isFinite(id)) throw new Error('Parametro "idComanda" non valido');
        // In fila con la chiusura della stessa comanda: un preconto che
        // arriva mentre la si chiude troverebbe il conto a metà.
        return unaAllaVolta(id, () => precontoUnaVolta(id));
    },
    // Catalogo articoli per l'import menu del CRM (senza immagini: il payload
    // deve stare nel buffer del socket).
    articoli: (p) => getArticoliMenu(typeof p?.ultimaModifica === 'string' ? p.ultimaModifica : undefined),
    // Introspezione del contratto WCF: scarica ?wsdl dall'AdapterWS e torna
    // il SOLO elenco operazioni (il contratto intero può superare il buffer
    // del socket — per quello c'è scripts/passepartout-scopri-ws.mjs in LAN).
    //
    // I metadati stanno sull'indirizzo BASE del servizio (http://host:porta/?wsdl,
    // da cui era stato letto l'XSD il 25/08), non sull'endpoint /AdapterWS:
    // provando solo l'endpoint, la scoperta del 02/10 rispondeva «metadati
    // non esposti» con l'agente collegato. L'endpoint resta come ripiego.
    wsdl: async () => {
        const base = (process.env.PASSEPARTOUT_WS_URL || '').trim().replace(/\/$/, '');
        if (!base) throw new Error('PASSEPARTOUT_WS_URL non configurato');
        const origin = new URL(base).origin;
        const urls = [`${origin}/?singleWsdl`, `${origin}/?wsdl`, `${base}?singleWsdl`, `${base}?wsdl`];
        const tentativi: string[] = [];
        for (const url of urls) {
            try {
                const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
                if (!res.ok) { tentativi.push(`${url} HTTP ${res.status}`); continue; }
                let text = await res.text();
                // Con ?wsdl WCF può spostare portType e binding in documenti
                // importati (?wsdl=wsdl0): si seguono, un livello basta.
                for (const m of text.matchAll(/<wsdl:import[^>]*location="([^"]+)"/g)) {
                    const imp = await fetch(m[1], { signal: AbortSignal.timeout(15_000) });
                    if (imp.ok) text += await imp.text();
                }
                const operations = [...new Set([...text.matchAll(/<wsdl:operation name="([^"]+)"/g)].map(m => m[1]))].sort();
                if (operations.length === 0) { tentativi.push(`${url} senza operazioni`); continue; }
                const writeCandidates = operations.filter(op =>
                    /^(Write|Put|Set|Insert|Inserisci|Crea|Nuova?|Apri|Add|Aggiungi|Salva|Registra|Update|Modifica)/i.test(op)
                    && /Comand|Cont[oi]|Tavol|Rig[ah]|Prenot/i.test(op));
                return { source: url, size: text.length, operations, write_candidates: writeCandidates };
            } catch (err) {
                tentativi.push(`${url} ${(err as Error).message}`);
            }
        }
        throw new Error(`Metadati WCF non esposti (${tentativi.join(' · ')}): usare scripts/passepartout-scopri-ws.mjs probe dalla LAN`);
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

// Una chiusura alla volta per comanda (e una scrittura alla volta per
// prenotazione, chiave il tag): due richieste ravvicinate (un
// ritentativo dello spazzino mentre la prima è ancora in corso, o i due
// server) si mettono in fila, e la seconda — con riprendi — trova il conto
// già in archivio invece di farne un altro.
const inCorso = new Map<number | string, Promise<unknown>>();
function unaAllaVolta<T>(idComanda: number | string, fn: () => Promise<T>): Promise<T> {
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

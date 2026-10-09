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

import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
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
    scontoComanda,
    specchioComanda,
    scriviComandaViva,
    diagnosiCassa,
    isPassepartoutConfigured,
    PassepartoutError,
    type TipoDocumentoConto,
    type StatoPrenotazioneCassa,
    type EsitoComandaViva,
    type MemoriaComandaViva,
} from '../services/passepartoutService.js';

// Server e token: dalle variabili d'ambiente (installazioni di prima) o dal
// file che scrive l'abbinamento col codice (`--abbina`), accanto all'agente.
const CONFIG_FILE = path.resolve(process.env.PP_AGENT_CONFIG || 'passepartout-agent.json');
const daFile = ((): { server_url?: string; token?: string } => {
    try { return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); } catch { return {}; }
})();
const argomento = (nome: string): string | null => {
    const i = process.argv.indexOf(nome);
    return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : null;
};
const SERVER_URL = (argomento('--server') || process.env.PP_AGENT_SERVER_URL || daFile.server_url || '').trim().replace(/\/+$/, '');
const NODE_URL = (process.env.PP_AGENT_NODE_URL || '').trim().replace(/\/+$/, '');
const TOKEN = (process.env.PP_AGENT_TOKEN || daFile.token || '').trim();

// La versione dell'agente (sha del pacchetto), annunciata nel saluto: la
// sezione Passepartout la mostra, e gli aggiornamenti la confrontano.
const VERSIONE_AGENTE = ((): string | undefined => {
    const qui = path.dirname(fileURLToPath(import.meta.url));
    // Accanto all'agente (pacchetto leggero), poi alla radice del pacchetto
    // del nodo (dist/scripts → ../..), poi nella cartella di lavoro.
    for (const f of [path.resolve(qui, 'build-info.json'), path.resolve(qui, '..', '..', 'build-info.json'), path.resolve('build-info.json')]) {
        try {
            const sha = JSON.parse(fs.readFileSync(f, 'utf8'))?.sha;
            if (typeof sha === 'string' && sha.trim()) return sha.trim().slice(0, 7);
        } catch { /* prossimo */ }
    }
    return undefined;
})();

// `--abbina CODICE [--server URL]`: scambia il codice generato nella sezione
// Passepartout col token dell'agente e lo salva in CONFIG_FILE, leggibile
// solo da chi lo scrive. Poi si avvia l'agente normalmente.
const CODICE_ABBINA = argomento('--abbina');
if (CODICE_ABBINA) {
    void (async () => {
        if (!SERVER_URL) {
            console.error('Serve l\'indirizzo del server: --server https://... (o PP_AGENT_SERVER_URL).');
            process.exit(1);
        }
        try {
            const res = await fetch(`${SERVER_URL}/pp-agent/abbina`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ codice: CODICE_ABBINA, hostname: os.hostname(), versione: VERSIONE_AGENTE }),
            });
            const body = await res.json().catch(() => ({})) as any;
            if (!res.ok || typeof body?.token !== 'string') {
                console.error(`Abbinamento non riuscito: ${body?.message || body?.error || `HTTP ${res.status}`}`);
                process.exit(1);
            }
            fs.writeFileSync(CONFIG_FILE, JSON.stringify({ server_url: SERVER_URL, token: body.token }, null, 2), { mode: 0o600 });
            console.log(`Abbinato a ${body.ristorante ?? 'il ristorante'}. Configurazione salvata in ${CONFIG_FILE}: ora avvia l'agente.`);
            process.exit(0);
        } catch (err) {
            console.error(`Abbinamento non riuscito: ${(err as Error).message}`);
            process.exit(1);
        }
    })();
}
// Cosa sa fare questo agente, annunciato nell'agent:hello: il server
// riprova da solo una chiusura solo con un agente che sa riprenderla, e
// manda prenotazioni solo a un agente che sa scriverle, e chiede i conti
// del giorno solo a uno che sa leggerli. 'chiudi-preconto': la chiusura
// regge una comanda col preconto stampato; 'preconto': sa stamparlo (il
// tavolo che vuole pagare dal QR diventa blu in cassa). 'specchio': copia
// in cassa i conti chiusi nel CRM (comanda specchio, fase 4). 'diagnosi':
// la verifica guidata della sezione Passepartout. 'comanda-viva': scrive le
// righe degli ordini del CRM nella comanda in cassa del tavolo vero.
const CAPABILITIES = ['chiudi-riprendi', 'prenotazioni', 'conti', 'tavoli-aperti', 'chiudi-preconto', 'preconto', 'specchio', 'diagnosi', 'sconto-cassa', 'comanda-viva', 'comanda-viva-invio', 'comanda-viva-coperto'];

if (!CODICE_ABBINA && (!SERVER_URL || !TOKEN)) {
    console.error('Config mancante: servono PP_AGENT_SERVER_URL e PP_AGENT_TOKEN, o un abbinamento (--abbina CODICE --server URL).');
    process.exit(1);
}
if (!CODICE_ABBINA && !isPassepartoutConfigured()) {
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
        // sympotia-prova:<n> è la prenotazione di prova della verifica guidata.
        if (!/^sympotia(-prova)?:\d+$/.test(tag)) throw new Error('Parametro "tag" non valido');
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
    // La verifica guidata della sezione: sola lettura.
    diagnosi: () => diagnosiCassa(),
    specchio: (p) => {
        if (typeof p?.tag !== 'string' || !p.tag || typeof p?.tavolo !== 'string' || !p.tavolo || !Array.isArray(p?.righe)) {
            throw new Error('Parametri della comanda specchio non validi');
        }
        // In fila per tavolo: due conti del CRM chiusi insieme non si
        // contendono il tavolo della comanda specchio.
        return unaAllaVolta(`specchio:${p.tavolo}`, () => specchioComanda({
            tag: p.tag,
            sala: String(p.sala ?? ''),
            tavolo: p.tavolo,
            coperti: Number(p.coperti) || 0,
            righe: p.righe.map((r: any) => ({
                idArticolo: r?.idArticolo != null && Number.isFinite(Number(r.idArticolo)) ? Number(r.idArticolo) : null,
                descrizione: String(r?.descrizione ?? ''),
                pezzi: Number(r?.pezzi) || 1,
                prezzoCents: Math.round(Number(r?.prezzoCents) || 0),
                coperto: r?.coperto === true,
            })),
            idArticoloGenerico: p.idArticoloGenerico != null && Number.isFinite(Number(p.idArticoloGenerico)) ? Number(p.idArticoloGenerico) : null,
            tipoPagamento: String(p.tipoPagamento ?? ''),
            totaleCents: Math.round(Number(p.totaleCents) || 0),
        }));
    },
    // Le righe di un ordine del CRM nella comanda in cassa del suo tavolo.
    // In fila per tavolo: due ordini dello stesso tavolo (o due giri del
    // server) non creano due comande, e il secondo trova le righe del primo.
    comandaViva: (p) => {
        const tag = typeof p?.tag === 'string' ? p.tag : '';
        if (!/^sympotia-ordine:\d+$/.test(tag) || typeof p?.tavolo !== 'string' || !p.tavolo || !Array.isArray(p?.righe)) {
            throw new Error('Parametri della comanda viva non validi');
        }
        const intero = (v: unknown): number | null => (v != null && Number.isFinite(Number(v)) ? Math.round(Number(v)) : null);
        return unaAllaVolta(`viva:${p.tavolo}`, async () => {
            const esito = await scriviComandaViva({
                tag,
                idComanda: intero(p.idComanda),
                sala: String(p.sala ?? ''),
                tavolo: p.tavolo,
                coperti: intero(p.coperti) ?? 0,
                righe: p.righe.map((r: any) => ({
                    chiave: String(r?.chiave ?? ''),
                    idRiga: intero(r?.idRiga),
                    idArticolo: intero(r?.idArticolo),
                    descrizione: String(r?.descrizione ?? ''),
                    pezzi: intero(r?.pezzi) ?? 1,
                    prezzoCents: intero(r?.prezzoCents) ?? 0,
                    uscita: intero(r?.uscita) ?? 1,
                    varianti: Array.isArray(r?.varianti)
                        ? r.varianti.map((v: any) => ({ descrizione: String(v?.descrizione ?? ''), inAggiunta: v?.inAggiunta !== false }))
                        : [],
                    coperto: r?.coperto === true,
                    prezzoDellaCassa: r?.prezzoDellaCassa === true,
                    soloComandaNostra: r?.soloComandaNostra === true,
                    cancella: r?.cancella === true,
                })),
                idArticoloGenerico: intero(p.idArticoloGenerico),
                inviaUscite: Array.isArray(p.inviaUscite)
                    ? p.inviaUscite.map((u: unknown) => intero(u)).filter((u: number | null): u is number => u != null && u > 0)
                    : [],
            }, memoriaVive.leggi(tag));
            memoriaVive.ricorda(tag, esito);
            return esito;
        });
    },
    preconto: (p) => {
        const id = Number(p?.idComanda);
        if (!Number.isFinite(id)) throw new Error('Parametro "idComanda" non valido');
        // In fila con la chiusura della stessa comanda: un preconto che
        // arriva mentre la si chiude troverebbe il conto a metà.
        return unaAllaVolta(id, () => precontoUnaVolta(id));
    },
    // Lo sconto che la cassa ha messo sul conto aperto della comanda (il
    // preconto): il conto del QR lo deve togliere come fa la cassa.
    scontoComanda: (p) => {
        const id = Number(p?.idComanda);
        if (!Number.isFinite(id)) throw new Error('Parametro "idComanda" non valido');
        return scontoComanda(id);
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

// Stato per il supervisore in «modo agente» (sala-node/supervisor.mjs), se
// PP_AGENT_STATE_FILE c'è: collegato al cloud o no, e quante chiamate della
// cassa sono in corso. Il supervisore aggiorna solo a zero chiamate, e
// considera sana una versione nuova quando scrive di essere collegata.
const STATE_FILE = (process.env.PP_AGENT_STATE_FILE || '').trim();
let chiamateInCorso = 0;
let collegatoAlCloud: string | null = null;
const scriviStato = () => {
    if (!STATE_FILE) return;
    const tmp = `${STATE_FILE}.tmp`;
    try {
        fs.writeFileSync(tmp, JSON.stringify({
            ok: collegatoAlCloud != null,
            collegato_at: collegatoAlCloud,
            in_corso: chiamateInCorso,
            versione: VERSIONE_AGENTE ?? null,
            pid: process.pid,
            scritto_at: new Date().toISOString(),
        }));
        fs.renameSync(tmp, STATE_FILE);
    } catch { /* cartella che manca o disco pieno: l'agente non cade per questo */ }
};
if (STATE_FILE && !CODICE_ABBINA) {
    scriviStato();
    setInterval(scriviStato, Math.max(1_000, Number(process.env.PP_AGENT_STATE_MS) || 10_000));
}
// Quello che l'agente ha scritto per ogni ordine del CRM (comanda e righe),
// in un file accanto alla configurazione: se la risposta al server va persa
// (timeout, linea che cade, riavvio del server) il tentativo dopo trova le
// righe già scritte invece di aggiungerle una seconda volta. La cassa non ha
// una nota per riga: senza questa memoria non c'è modo di riconoscerle.
const memoriaVive = (() => {
    const file = path.join(path.dirname(CONFIG_FILE), 'passepartout-comande-vive.json');
    type Voce = MemoriaComandaViva & { at: string };
    let voci: Record<string, Voce> = {};
    try { voci = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* prima volta */ }
    return {
        leggi(tag: string): MemoriaComandaViva {
            const v = voci[tag];
            return { idComanda: v?.idComanda ?? null, righe: { ...(v?.righe ?? {}) } };
        },
        ricorda(tag: string, esito: EsitoComandaViva): void {
            const v: Voce = voci[tag] ?? { idComanda: null, righe: {}, at: '' };
            if (esito.idComanda != null) v.idComanda = esito.idComanda;
            for (const r of esito.righe) {
                if (r.cancellata) delete v.righe[r.chiave];
                else if (r.idRiga != null) v.righe[r.chiave] = r.idRiga;
            }
            v.at = new Date().toISOString();
            voci[tag] = v;
            // Tre giorni bastano: un ordine non resta aperto di più.
            const limite = Date.now() - 3 * 86_400_000;
            for (const [k, x] of Object.entries(voci)) if (Date.parse(x.at) < limite) delete voci[k];
            try {
                fs.writeFileSync(`${file}.tmp`, JSON.stringify(voci));
                fs.renameSync(`${file}.tmp`, file);
            } catch (err) {
                console.warn('[agent] memoria delle comande vive non salvata:', (err as Error).message);
            }
        },
    };
})();

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
        if (nome === 'cloud') { collegatoAlCloud = new Date().toISOString(); scriviStato(); }
        let versioneGestionale: string | undefined;
        try {
            versioneGestionale = (await getVersioneGestionale()) ?? undefined;
            console.log(`[agent:${nome}] gestionale raggiungibile, versione ${versioneGestionale}`);
        } catch (err) {
            console.warn(`[agent:${nome}] gestionale non raggiungibile al momento:`, (err as Error).message);
        }
        socket.emit('agent:hello', { hostname: os.hostname(), versioneGestionale, versioneAgente: VERSIONE_AGENTE, capabilities: CAPABILITIES });
    });

    socket.on('connect_error', (err) => {
        console.warn(`[agent:${nome}] connessione rifiutata:`, err.message);
    });

    socket.on('disconnect', (reason) => {
        console.log(`[agent:${nome}] disconnesso (${reason}), riconnessione automatica...`);
        if (nome === 'cloud') { collegatoAlCloud = null; scriviStato(); }
    });

    socket.on('pp:call', async (payload: any, ack: (r: unknown) => void) => {
        const op = String(payload?.op || '');
        const started = Date.now();
        chiamateInCorso += 1;
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
        } finally {
            chiamateInCorso -= 1;
        }
    });
};

if (!CODICE_ABBINA) {
    collega('cloud', SERVER_URL);
    if (NODE_URL) collega('nodo', NODE_URL);
}

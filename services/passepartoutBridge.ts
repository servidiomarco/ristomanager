// Ponte fra il backend (Railway) e l'agente LAN del ristorante che parla col
// gestionale Passepartout Menù.
//
// Il gestionale vive sulla rete del locale e non è raggiungibile dal cloud:
// l'agente (scripts/passepartout-agent.ts) apre LUI una connessione socket.io
// in uscita verso questo server, sul namespace dedicato `/pp-agent`,
// autenticandosi col token del SUO ristorante (tenants.passepartout_agent_token;
// il token storico PASSEPARTOUT_AGENT_TOKEN vale per il ristorante 1). Da quel
// momento il backend può eseguire chiamate RPC verso il gestionale di quel
// ristorante con `callPassepartout(tenantId, op, params)` — request/response
// via ack socket.io con timeout, nessuna coda e nessun polling (a differenza
// del print-agent, qui il cameriere sta aspettando la risposta a schermo).
//
// Il namespace è separato dal default "/" di proposito: il middleware JWT
// degli utenti resta intatto, e un token agente non può ricevere i broadcast
// del CRM né viceversa. Un agente alla volta PER RISTORANTE: una nuova
// connessione valida scalza la precedente dello stesso ristorante (riavvio
// dell'agente = riconnessione pulita) e non tocca quelle degli altri.

import type { Server as SocketIOServer, Socket } from 'socket.io';
import type { PassepartoutComanda } from './passepartoutService.js';

export type PassepartoutOp =
    | 'versione'
    | 'comandaTavolo'
    | 'comanda'
    | 'tipiPagamento'
    | 'sale'
    | 'conto'
    /** Catalogo articoli senza immagini — alimenta l'import menu del CRM. */
    | 'articoli'
    /** InviaProduzioneComanda (tutte le uscite) — per comande create via WS. */
    | 'invia'
    /** Sequenza di chiusura completa (chiudiComandaCompleta): azione FISCALE. */
    | 'chiudi'
    /** Scrive o annulla una prenotazione nel planning della cassa
     *  (capacità 'prenotazioni'). */
    | 'prenotazione'
    /** Prenotazioni della cassa di un giorno: da qui tornano gli arrivi. */
    | 'prenotazioniGiorno'
    /** Sale e tavoli coi nomi della cassa, per abbinare i tavoli del CRM. */
    | 'piantaSale'
    /** Conti chiusi del giorno con tavolo e prenotazione (capacità 'conti'). */
    | 'contiGiorno'
    /** Comande aperte adesso sui tavoli (capacità 'tavoli-aperti'). */
    | 'comandeAperte'
    /** Stampa il preconto della comanda, una volta sola (capacità
     *  'preconto'): in cassa il tavolo diventa «vuole pagare». */
    | 'preconto'
    /** Copia in cassa un conto chiuso nel CRM: comanda sul tavolo scelto,
     *  senza invio in produzione, chiusa come proforma col tipo esterno
     *  (capacità 'specchio'). */
    | 'specchio'
    /** Introspezione del contratto WCF (?wsdl): elenco operazioni, per
     *  scoprire da remoto se esiste la scrittura comande (comanda specchio)
     *  senza documentazione del concessionario. Sola lettura. */
    | 'wsdl';

export class PassepartoutBridgeError extends Error {
    constructor(
        message: string,
        /** 'agent_offline' | 'timeout' | 'gestionale' | 'agent' */
        public readonly kind: string,
    ) {
        super(message);
        this.name = 'PassepartoutBridgeError';
    }
}

interface AgentConn {
    socket: Socket;
    connectedAt: Date;
    hello: { hostname?: string; versioneGestionale?: string; capabilities?: string[] };
}

const agents = new Map<number, AgentConn>();

/** Dal token dell'handshake al ristorante; null = token sconosciuto. Lo
 *  fornisce server.ts, che conosce il token storico e la colonna dei
 *  token per ristorante. */
export type PassepartoutTenantResolver = (token: string) => Promise<number | null>;

export function getPassepartoutAgentStatus(tenantId: number) {
    const conn = agents.get(tenantId);
    return {
        connected: conn != null,
        connected_at: conn?.connectedAt.toISOString() ?? null,
        hostname: conn?.hello.hostname ?? null,
        versione_gestionale: conn?.hello.versioneGestionale ?? null,
        capabilities: conn?.hello.capabilities ?? [],
    };
}

/** I ristoranti con un agente collegato adesso: i giri periodici lavorano
 *  solo su questi. */
export function connectedPassepartoutTenants(): number[] {
    return [...agents.keys()];
}

/** L'agente collegato del ristorante dichiara di saper fare `cap` (nel suo
 *  agent:hello). 'chiudi-riprendi' (fase B5): prima di chiudere guarda
 *  nell'archivio del giorno se il conto della comanda c'è già, così un
 *  nuovo tentativo dopo una risposta persa non rifà lo scontrino. Un agente
 *  vecchio non lo dice, e con lui i tentativi automatici non partono. */
export function passepartoutAgentSupports(tenantId: number, cap: string): boolean {
    const conn = agents.get(tenantId);
    return conn != null && (conn.hello.capabilities ?? []).includes(cap);
}

export function setupPassepartoutBridge(io: SocketIOServer, resolveTenant: PassepartoutTenantResolver) {
    const nsp = io.of('/pp-agent');

    nsp.use((socket, next) => {
        const provided = String(socket.handshake.auth?.token || '');
        resolveTenant(provided)
            .then((tenantId) => {
                if (tenantId == null) return next(new Error('Token agente non valido'));
                socket.data.tenantId = tenantId;
                next();
            })
            .catch(() => next(new Error('Token agente non verificabile')));
    });

    nsp.on('connection', (socket) => {
        const tenantId = Number(socket.data.tenantId);
        const prima = agents.get(tenantId);
        if (prima && prima.socket.id !== socket.id) {
            try { prima.socket.disconnect(true); } catch (_) {}
        }
        const conn: AgentConn = { socket, connectedAt: new Date(), hello: {} };
        agents.set(tenantId, conn);
        console.log(`[pp-agent] agente connesso: ${socket.id} (ristorante ${tenantId})`);

        socket.on('agent:hello', (info: any) => {
            conn.hello = {
                hostname: typeof info?.hostname === 'string' ? info.hostname : undefined,
                versioneGestionale: typeof info?.versioneGestionale === 'string' ? info.versioneGestionale : undefined,
                capabilities: Array.isArray(info?.capabilities)
                    ? info.capabilities.filter((c: unknown): c is string => typeof c === 'string').slice(0, 20)
                    : [],
            };
        });

        socket.on('disconnect', (reason) => {
            if (agents.get(tenantId)?.socket.id === socket.id) agents.delete(tenantId);
            console.log(`[pp-agent] agente disconnesso (${reason}, ristorante ${tenantId})`);
        });
    });
}

/**
 * Esegue un'operazione sul gestionale del ristorante attraverso il suo
 * agente LAN. Rilancia PassepartoutBridgeError con kind:
 *  - 'agent_offline' se il ristorante non ha un agente collegato (→ 503 lato API)
 *  - 'timeout' se l'agente non risponde in tempo
 *  - 'gestionale' se il gestionale ha risposto con un errore applicativo
 *  - 'agent' per errori interni dell'agente
 */
export async function callPassepartout<T = unknown>(
    tenantId: number,
    op: PassepartoutOp,
    params: Record<string, unknown> = {},
    timeoutMs = 20_000,
): Promise<T> {
    const socket = agents.get(tenantId)?.socket;
    if (!socket) {
        throw new PassepartoutBridgeError(
            'Agente Passepartout non collegato: il ristorante è offline?',
            'agent_offline',
        );
    }
    let response: any;
    try {
        response = await socket.timeout(timeoutMs).emitWithAck('pp:call', { op, params });
    } catch (_err) {
        throw new PassepartoutBridgeError(
            `Nessuna risposta dall'agente entro ${Math.round(timeoutMs / 1000)}s`,
            'timeout',
        );
    }
    if (!response || response.ok !== true) {
        throw new PassepartoutBridgeError(
            String(response?.error || 'Errore sconosciuto dall\'agente'),
            response?.kind === 'gestionale' ? 'gestionale' : 'agent',
        );
    }
    return response.result as T;
}

// ---------------------------------------------------------------------------
// Mapping comanda → conto CRM
// ---------------------------------------------------------------------------

export interface PassepartoutBillPayload {
    id_comanda: number;
    tavolo: string | null;
    sala: string | null;
    covers: number;
    total_cents: number;
    /** Nello stesso formato di billItemsSnapshot: order_item_id univoco,
     *  somma(unit_price_cents × qty) === total_cents (requisito per_item). */
    items: Array<{ order_item_id: number; name: string; qty: number; unit_price_cents: number }>;
    /** Sconto a livello comanda sul gestionale, se presente: informativo. */
    sconto: number | null;
    external_ref: string;
}

/**
 * Converte una ContrattoComanda nel payload per aprire un table_bill.
 * Regola d'oro: la somma delle righe DEVE combaciare col totale, altrimenti
 * lo split per portata viene disabilitato dalla guardia esistente. Per le
 * righe in cui prezzo×quantità non torna col totale riga (sconti riga,
 * varianti) la riga collassa a quantità 1 con il totale riga come prezzo.
 */
export function comandaToBillPayload(comanda: PassepartoutComanda): PassepartoutBillPayload {
    const items: PassepartoutBillPayload['items'] = [];
    for (const r of comanda.righe) {
        const rowTotal = Math.round((r.totale ?? 0) * 100);
        const unit = Math.round((r.prezzo ?? 0) * 100);
        const qty = r.pezzi ?? 0;
        const name = r.descrizione || r.articolo || 'Voce';
        if (r.idGestionale == null) continue;
        if (qty > 0 && unit * qty === rowTotal) {
            items.push({ order_item_id: r.idGestionale, name, qty, unit_price_cents: unit });
        } else {
            items.push({
                order_item_id: r.idGestionale,
                name: qty > 1 ? `${qty}× ${name}` : name,
                qty: 1,
                unit_price_cents: rowTotal,
            });
        }
    }
    const total = items.reduce((sum, i) => sum + i.unit_price_cents * i.qty, 0);
    return {
        id_comanda: comanda.idGestionale ?? 0,
        tavolo: comanda.tavolo,
        sala: comanda.sala,
        covers: comanda.coperti && comanda.coperti > 0 ? comanda.coperti : 1,
        total_cents: total,
        items,
        sconto: comanda.sconto,
        external_ref: `pp:comanda:${comanda.idGestionale}`,
    };
}

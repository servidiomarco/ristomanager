// Ponte fra il backend (Railway) e l'agente LAN del ristorante che parla col
// gestionale Passepartout Menù.
//
// Il gestionale vive sulla rete del locale e non è raggiungibile dal cloud:
// l'agente (scripts/passepartout-agent.ts) apre LUI una connessione socket.io
// in uscita verso questo server, sul namespace dedicato `/pp-agent`,
// autenticandosi con il segreto condiviso PASSEPARTOUT_AGENT_TOKEN. Da quel
// momento il backend può eseguire chiamate RPC verso il gestionale con
// `callPassepartout(op, params)` — request/response via ack socket.io con
// timeout, nessuna coda e nessun polling (a differenza del print-agent, qui
// il cameriere sta aspettando la risposta a schermo).
//
// Il namespace è separato dal default "/" di proposito: il middleware JWT
// degli utenti resta intatto, e un token agente non può ricevere i broadcast
// del CRM né viceversa. Un solo agente alla volta: una nuova connessione
// valida scalza la precedente (riavvio dell'agente = riconnessione pulita).

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

let agentSocket: Socket | null = null;
let connectedAt: Date | null = null;
let agentHello: { hostname?: string; versioneGestionale?: string } = {};

export function isPassepartoutAgentConfigured(): boolean {
    return Boolean((process.env.PASSEPARTOUT_AGENT_TOKEN || '').trim());
}

export function getPassepartoutAgentStatus() {
    return {
        configured: isPassepartoutAgentConfigured(),
        connected: agentSocket != null,
        connected_at: connectedAt?.toISOString() ?? null,
        hostname: agentHello.hostname ?? null,
        versione_gestionale: agentHello.versioneGestionale ?? null,
    };
}

export function setupPassepartoutBridge(io: SocketIOServer) {
    const nsp = io.of('/pp-agent');

    nsp.use((socket, next) => {
        const expected = (process.env.PASSEPARTOUT_AGENT_TOKEN || '').trim();
        if (!expected) return next(new Error('Agente Passepartout non configurato'));
        const provided = String(socket.handshake.auth?.token || '');
        if (provided !== expected) return next(new Error('Token agente non valido'));
        next();
    });

    nsp.on('connection', (socket) => {
        if (agentSocket && agentSocket.id !== socket.id) {
            try { agentSocket.disconnect(true); } catch (_) {}
        }
        agentSocket = socket;
        connectedAt = new Date();
        agentHello = {};
        console.log(`[pp-agent] agente connesso: ${socket.id}`);

        socket.on('agent:hello', (info: any) => {
            agentHello = {
                hostname: typeof info?.hostname === 'string' ? info.hostname : undefined,
                versioneGestionale: typeof info?.versioneGestionale === 'string' ? info.versioneGestionale : undefined,
            };
        });

        socket.on('disconnect', (reason) => {
            if (agentSocket?.id === socket.id) {
                agentSocket = null;
                connectedAt = null;
                agentHello = {};
            }
            console.log(`[pp-agent] agente disconnesso (${reason})`);
        });
    });
}

/**
 * Esegue un'operazione sul gestionale attraverso l'agente LAN.
 * Rilancia PassepartoutBridgeError con kind:
 *  - 'agent_offline' se nessun agente è collegato (→ 503 lato API)
 *  - 'timeout' se l'agente non risponde in tempo
 *  - 'gestionale' se il gestionale ha risposto con un errore applicativo
 *  - 'agent' per errori interni dell'agente
 */
export async function callPassepartout<T = unknown>(
    op: PassepartoutOp,
    params: Record<string, unknown> = {},
    timeoutMs = 20_000,
): Promise<T> {
    const socket = agentSocket;
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

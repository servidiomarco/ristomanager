// Outbox transazionale: eventi di dominio scritti nella stessa transazione
// del dato, consegnati da un dispatcher con retry.
//
// Il problema che chiude: prima, la route faceva COMMIT e poi broadcastava
// via Socket.IO in un try/catch muto — se il processo moriva (o il broadcast
// falliva) fra i due passi, il dato era salvato ma nessuno schermo lo sapeva.
// Ora l'evento È parte della transazione: o si scrive tutto (dato + evento),
// o niente. La consegna arriva dopo, e se non arriva si ritenta.
//
// Percorso normale: la route chiama kick() subito dopo il COMMIT, quindi la
// latenza resta quella di prima (millisecondi). Il giro periodico è la rete
// di sicurezza per il processo morto nel momento sbagliato — ed è lo STESSO
// codice del percorso normale, non un ramo d'emergenza mai esercitato.
//
// Consegna at-least-once: un crash fra handler e marcatura può far emettere
// due volte. Va bene per costruzione: i listener client upsertano in modo
// idempotente (vedi il commento storico in server.ts sui reservation sync).
//
// L'id seriale della tabella è un ordine totale per stream: questo modulo è
// il primo mattone del protocollo di replica del nodo di sala
// (docs/brainstorming-installazione-ibrida.md nel repo marketing, sez. 7).
import pool, { runAsPlatform } from '../db.js';
import { requireRegisteredEvent } from './eventRegistry.js';

type OutboxHandler = (tenantId: number, payload: any) => Promise<void>;

/** Contesto opzionale dell'envelope (sez. 7 del protocollo): chi e cosa ha
 *  prodotto l'evento. Tutto per riferimento, mai anagrafiche. */
export interface OutboxEventContext {
    /** La Idempotency-Key del comando client che ha prodotto l'evento. */
    commandId?: string | null;
    /** event_id dell'evento (anche dell'altro stream) che ha causato questo. */
    causationId?: string | null;
    /** Riferimenti dell'autore: { user_id, role, channel } — MAI nome/email. */
    actor?: Record<string, string | number | null> | null;
}

const SWEEP_MS = 3000;
/** Oltre questa soglia si smette di ritentare: una riga avvelenata non deve
 *  bloccare la coda per sempre. Resta nel database, non consegnata, con i
 *  tentativi contati — visibile a un audit, non persa in silenzio. */
const MAX_ATTEMPTS = 20;
const BATCH = 50;

const handlers = new Map<string, OutboxHandler>();
let timer: ReturnType<typeof setInterval> | null = null;
let draining = false;

/** Scrive l'evento DENTRO la transazione del chiamante. Il payload porta
 *  riferimenti (order_id, non nomi): la regola PII dell'event log.
 *
 *  Il tipo DEVE stare nel registro (eventRegistry): un tipo non dichiarato
 *  esplode qui — in CI, non in produzione con una riga che nessun handler
 *  consegnerà. schema_ver viene dal registro, mai dal chiamante. */
export const outboxEnqueueInTx = async (
    client: { query: (sql: string, params?: any[]) => Promise<any> },
    tenantId: number,
    event: string,
    aggregate: string,
    payload: Record<string, any> | null,
    context: OutboxEventContext = {},
): Promise<void> => {
    const spec = requireRegisteredEvent(event);
    await client.query(
        `INSERT INTO outbox_events (tenant_id, event, aggregate, payload, schema_ver, command_id, causation_id, actor)
         VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7, $8::jsonb)`,
        [
            tenantId,
            event,
            aggregate,
            payload ? JSON.stringify(payload) : null,
            spec.schema_ver,
            context.commandId ?? null,
            context.causationId ?? null,
            context.actor ? JSON.stringify(context.actor) : null,
        ]
    );
};

/** Transazione con evento outbox dentro: la forma minima di «evento e
 *  mutazione insieme» per i moduli fuori da server.ts (che ha il gemello
 *  runWithOutboxTx). Il chiamante può fare outboxKick() dopo, o lasciare
 *  la consegna al giro periodico (3s). */
export const withOutboxTx = async <T>(fn: (client: { query: (sql: string, params?: any[]) => Promise<any> }) => Promise<T>): Promise<T> => {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const out = await fn(client);
        await client.query('COMMIT');
        return out;
    } catch (err) {
        await client.query('ROLLBACK').catch(() => { /* noop */ });
        throw err;
    } finally {
        client.release();
    }
};

export const outboxRegister = (event: string, handler: OutboxHandler): void => {
    handlers.set(event, handler);
};

/** Un giro di consegna. FOR UPDATE SKIP LOCKED: due giri concorrenti (kick
 *  sovrapposto al timer, o due repliche un domani) non si pestano i piedi.
 *  Gira come lavoro di piattaforma dichiarato: la coda attraversa i tenant,
 *  e ogni handler riceve il tenant_id della riga per scoparsi da solo. */
const sweep = async (): Promise<void> => runAsPlatform(async () => {
    if (draining) return;
    draining = true;
    try {
        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            const batch = await client.query(
                `SELECT id, tenant_id, event, payload FROM outbox_events
                 WHERE delivered_at IS NULL AND attempts < $1
                 ORDER BY id
                 LIMIT $2
                 FOR UPDATE SKIP LOCKED`,
                [MAX_ATTEMPTS, BATCH]
            );
            for (const row of batch.rows) {
                const handler = handlers.get(row.event);
                try {
                    if (handler) await handler(Number(row.tenant_id), row.payload);
                    await client.query(
                        `UPDATE outbox_events SET delivered_at = CURRENT_TIMESTAMP WHERE id = $1`,
                        [row.id]
                    );
                } catch (err: any) {
                    await client.query(
                        `UPDATE outbox_events SET attempts = attempts + 1 WHERE id = $1`,
                        [row.id]
                    );
                    console.error(`[outbox] consegna fallita (evento ${row.event} #${row.id}):`, err?.message ?? err);
                }
            }
            await client.query('COMMIT');
        } catch (err) {
            await client.query('ROLLBACK').catch(() => {});
            throw err;
        } finally {
            client.release();
        }
    } catch (err: any) {
        console.error('[outbox] giro di consegna fallito:', err?.message ?? err);
    } finally {
        draining = false;
    }
});

/** Da chiamare subito dopo il COMMIT: consegna adesso, senza aspettare il
 *  timer. Fire-and-forget deliberato — la risposta HTTP non deve aspettare
 *  il broadcast, e se questo giro salta c'è il prossimo. */
export const outboxKick = (): void => {
    void sweep();
};

export const startOutboxDispatcher = (): void => {
    if (timer) return;
    timer = setInterval(() => void sweep(), SWEEP_MS);
    // Il processo non deve restare vivo per colpa del timer.
    if (typeof timer.unref === 'function') timer.unref();
    // Un giro subito all'avvio: consegna ciò che un crash aveva lasciato
    // indietro, prima che arrivi il primo evento nuovo.
    void sweep();
};

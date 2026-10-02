// Ritenta un passo di avvio quando Postgres lo ferma per una contesa di lock
// passeggera.
//
// Al deploy il container nuovo fa DDL (createSchema congelato, migration,
// re-assert di CHECK e policy) mentre il vecchio serve ancora traffico. Le
// ALTER TABLE prendono AccessExclusiveLock una tabella dopo l'altra dentro la
// stessa transazione; una query del container vecchio che tiene già una
// delle tabelle e aspetta la successiva chiude il cerchio, e Postgres uccide
// una delle due. Il 02/10/2026 (PR #809) è toccato a createSchema: deadlock
// fra customers e reservations, /ready rimasto 503 per tutta la finestra
// dell'healthcheck, deploy scartato — e il primo rilancio è passato liscio.
// Il passo è idempotente e il suo errore fa ROLLBACK: ritentare dopo una
// pausa è esattamente quello che faceva a mano il rilancio.
//
// Nessun import: lo usano db.ts e server.ts, e i test lo caricano dal
// sorgente senza tirarsi dietro il pool.

/** 40P01 deadlock_detected, 55P03 lock_not_available (lock_timeout),
 *  40001 serialization_failure. Tutti «riprova e passa»; nient'altro lo è. */
const TRANSIENT_LOCK_CODES = new Set(['40P01', '55P03', '40001']);

export const isTransientLockError = (err: unknown): boolean =>
    TRANSIENT_LOCK_CODES.has(String((err as { code?: unknown } | null)?.code ?? ''));

export interface LockRetryOptions {
    /** Tentativi totali, il primo compreso. */
    attempts?: number;
    /** Pausa base: cresce col tentativo, più un jitter fino a un'altra base,
     *  così due container che si scontrano non ritentano in sincrono. */
    baseDelayMs?: number;
    log?: (message: string) => void;
}

export async function retryOnLockContention<T>(
    label: string,
    fn: () => Promise<T>,
    { attempts = 5, baseDelayMs = 1000, log = console.warn }: LockRetryOptions = {},
): Promise<T> {
    for (let attempt = 1; ; attempt++) {
        try {
            return await fn();
        } catch (err) {
            if (!isTransientLockError(err) || attempt >= attempts) throw err;
            const delay = baseDelayMs * attempt + Math.floor(Math.random() * baseDelayMs);
            log(`[boot] ${label}: contesa di lock (${(err as { code?: string }).code}), ritento fra ${delay} ms — tentativo ${attempt + 1}/${attempts}`);
            await new Promise(resolve => setTimeout(resolve, delay));
        }
    }
}

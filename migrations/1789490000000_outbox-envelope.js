/* L'envelope pieno dell'event log (tappa 4 ibrido, fase 1 — sez. 7 del
 * brainstorming nel repo marketing): l'outbox delle comande diventa il log
 * di replica del nodo di sala, e ogni evento guadagna i campi che il
 * protocollo richiede.
 *
 * - event_id:     identità globale dell'evento, per l'idempotenza della
 *                 replica (l'inbox del consumatore deduplica su questo).
 * - schema_ver:   versione del payload — nodo e cloud potranno girare ore
 *                 su versioni diverse, il consumatore deve sapere cosa legge.
 * - command_id:   il comando client che l'ha prodotto (la Idempotency-Key
 *                 già in uso sulle comande: TEXT, non uuid — il formato
 *                 esiste da prima del log e non si cambia in corsa).
 * - causation_id: l'evento (anche dell'altro stream) che ha causato questo.
 * - actor:        chi l'ha prodotto — SOLO riferimenti (user_id, ruolo,
 *                 canale), mai anagrafiche: la regola PII dell'event log.
 *
 * Tutte le colonne nuove sono nullable o con default: le righe storiche
 * restano valide e i call site esistenti continuano a funzionare.
 */
export const up = (pgm) => {
    pgm.sql(`
        ALTER TABLE outbox_events
            ADD COLUMN IF NOT EXISTS event_id     UUID NOT NULL DEFAULT gen_random_uuid(),
            ADD COLUMN IF NOT EXISTS schema_ver   SMALLINT NOT NULL DEFAULT 1,
            ADD COLUMN IF NOT EXISTS command_id   TEXT,
            ADD COLUMN IF NOT EXISTS causation_id UUID,
            ADD COLUMN IF NOT EXISTS actor        JSONB;
    `);
    // Unicità dell'identità globale: è la chiave dell'idempotenza at-least-once.
    pgm.sql(`
        CREATE UNIQUE INDEX IF NOT EXISTS outbox_events_event_id
            ON outbox_events (event_id);
    `);
};

export const down = (pgm) => {
    pgm.sql(`DROP INDEX IF EXISTS outbox_events_event_id;`);
    pgm.sql(`
        ALTER TABLE outbox_events
            DROP COLUMN IF EXISTS event_id,
            DROP COLUMN IF EXISTS schema_ver,
            DROP COLUMN IF EXISTS command_id,
            DROP COLUMN IF EXISTS causation_id,
            DROP COLUMN IF EXISTS actor;
    `);
};

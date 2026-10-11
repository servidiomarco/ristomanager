/**
 * WhatsApp, Fase 5: «arriviamo con 15 minuti di ritardo».
 *
 * Al Frantoio i clienti lo scrivono su WhatsApp («Circa 15 minuti di
 * ritardo», «Stiamo arrivando»), ma l'avviso restava in chat: in sala la
 * Reception metteva la prenotazione fra le «in ritardo» solo guardando
 * l'orologio, e il tavolo rischiava di andare a chi aspettava.
 *
 * - guest_eta_at: l'ora a cui l'ospite dice che arriverà.
 * - guest_eta_noted_at: quando l'ha detto (per «avvisato alle 20:47»).
 *
 * Stessa famiglia di guest_confirmed_at / guest_cancelled_at: quello che
 * l'ospite ha detto lui, non quello che ha deciso lo staff.
 *
 * @type {import('node-pg-migrate').ColumnDefinitions | undefined}
 */
export const shorthands = undefined;

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 */
export const up = (pgm) => {
    pgm.sql(`
        ALTER TABLE reservations
            ADD COLUMN IF NOT EXISTS guest_eta_at       TIMESTAMPTZ,
            ADD COLUMN IF NOT EXISTS guest_eta_noted_at TIMESTAMPTZ;
    `);
};

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 */
export const down = (pgm) => {
    pgm.sql(`
        ALTER TABLE reservations
            DROP COLUMN IF EXISTS guest_eta_at,
            DROP COLUMN IF EXISTS guest_eta_noted_at;
    `);
};

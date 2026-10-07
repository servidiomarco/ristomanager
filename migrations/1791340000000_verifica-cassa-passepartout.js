/**
 * Verifica guidata della cassa Passepartout (piano «plug and play», punto 2).
 *
 * Attivare l'integrazione presso un ristorante voleva dire controllare a
 * mano, con script lanciati dal PC: la cassa risponde? con che versione? il
 * tipo di pagamento dedicato esiste? i tavoli sono abbinati? Ora la sezione
 * lo fa da sé (POST /passepartout/diagnosi) e tiene l'ultimo esito.
 *
 * - esterno_elettronico_confermato: che il tipo di pagamento dedicato figuri
 *   come pagamento ELETTRONICO sul registratore la cassa non lo dice via Web
 *   Service (al Frantoio è in categoria «Varie1»): lo conferma il ristorante,
 *   dopo averlo visto su uno scontrino. Le FAQ dell'Agenzia sul collegamento
 *   POS-RT chiedono forma e importo dei pagamenti sul documento.
 * - diagnosi / diagnosi_at: l'ultima verifica, così la scheda la mostra
 *   senza rifarla a ogni apertura.
 * - prova_prenotazione_at / _esito: l'ultima prova di scrittura (una
 *   prenotazione di prova nel planning, subito annullata).
 *
 * @type {import('node-pg-migrate').ColumnDefinitions | undefined}
 */
export const shorthands = undefined;

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 */
export const up = (pgm) => {
    pgm.sql(`
        ALTER TABLE passepartout_config
            ADD COLUMN IF NOT EXISTS esterno_elettronico_confermato BOOLEAN NOT NULL DEFAULT false,
            ADD COLUMN IF NOT EXISTS diagnosi JSONB,
            ADD COLUMN IF NOT EXISTS diagnosi_at TIMESTAMPTZ,
            ADD COLUMN IF NOT EXISTS prova_prenotazione_at TIMESTAMPTZ,
            ADD COLUMN IF NOT EXISTS prova_prenotazione_esito TEXT;
    `);
};

export const down = (pgm) => {
    pgm.sql(`
        ALTER TABLE passepartout_config
            DROP COLUMN IF EXISTS esterno_elettronico_confermato,
            DROP COLUMN IF EXISTS diagnosi,
            DROP COLUMN IF EXISTS diagnosi_at,
            DROP COLUMN IF EXISTS prova_prenotazione_at,
            DROP COLUMN IF EXISTS prova_prenotazione_esito;
    `);
};

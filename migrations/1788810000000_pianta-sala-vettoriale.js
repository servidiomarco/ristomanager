/**
 * Pianta di sala vettoriale (rooms.plan + coordinate reali dei tavoli).
 *
 * rooms.plan è un blob JSONB (RoomPlan in types.ts): dimensioni reali della
 * sala in cm, perimetro opzionale e gli elementi fissi (bancone, colonne,
 * porte…) con l'ordine dell'array come z-order. NULL = nessuna planimetria
 * = comportamento storico, così il deploy non cambia nulla per le sale
 * esistenti finché il titolare non disegna la prima pianta. Un blob e non
 * una tabella: <50 elementi per sala, salvataggio atomico con Save
 * esplicito, e room:updated trasporta già la riga intera — niente eventi
 * socket nuovi. La concorrenza la gestisce plan.rev (guardia in PATCH
 * /rooms/:id), non la granularità per riga.
 *
 * tables.x_cm/y_cm sono il CENTRO del tavolo in cm-sala, accanto ai
 * legacy x/y in px (top-left del glifo) che restano autorevoli per le
 * sale senza pianta: il box del glifo cambia taglia quando entrano le
 * misure reali, quindi solo un'àncora al centro tiene fermo il tavolo.
 * INTEGER e non NUMERIC: il centimetro intero basta (lo snap è a 10 cm)
 * e pg serializza NUMERIC come stringa nel JSON — db.ts non ha un parser
 * per l'OID 1700 e aggiungerlo ora cambierebbe i tipi di ogni importo in
 * app. Nessun backfill: NULL = non ancora piazzato sulla pianta, la
 * conversione una-tantum px→cm la fa il client al primo salvataggio.
 *
 * Niente RLS qui: rooms e tables hanno già tenant_id e la policy
 * tenant_isolation; le colonne nuove la ereditano.
 *
 * @type {import('node-pg-migrate').ColumnDefinitions | undefined}
 */
export const shorthands = undefined;

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 */
export const up = (pgm) => {
    pgm.sql(`ALTER TABLE rooms ADD COLUMN IF NOT EXISTS plan JSONB;`);
    pgm.sql(`ALTER TABLE tables ADD COLUMN IF NOT EXISTS x_cm INTEGER;`);
    pgm.sql(`ALTER TABLE tables ADD COLUMN IF NOT EXISTS y_cm INTEGER;`);
};

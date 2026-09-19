/* Valuta e paese del ristorante.
 *
 * `timezone` c'era già dalla migration dei tenant (default Europe/Rome) ma
 * non la leggeva nessuno; queste due colonne completano la terna che serve a
 * un ristorante fuori dall'Italia. Nessun comportamento cambia con questa
 * migration: i default riproducono esattamente l'Italia di oggi, e i lettori
 * arrivano nelle tappe successive.
 *
 * country_code è il fatto radice: da lì si derivano in codice il prefisso
 * telefonico e l'ammissibilità del modulo fiscale (italiano). Non si duplica
 * il prefisso in una colonna: due fonti per lo stesso fatto divergono.
 *
 * Il CHECK sulla valuta tiene solo monete a due decimali, perché tutti gli
 * importi sono interi in centesimi (*_cents): una valuta a zero decimali
 * (JPY) o a tre (KWD) passerebbe il vincolo di tipo e sbaglierebbe i conti.
 */
export const up = (pgm) => {
    pgm.sql(`
        ALTER TABLE tenants
            ADD COLUMN IF NOT EXISTS currency CHAR(3) NOT NULL DEFAULT 'EUR',
            ADD COLUMN IF NOT EXISTS country_code CHAR(2) NOT NULL DEFAULT 'IT';
    `);
    pgm.sql(`
        DO $$
        BEGIN
            IF NOT EXISTS (
                SELECT 1 FROM pg_constraint WHERE conname = 'tenants_currency_check'
            ) THEN
                ALTER TABLE tenants
                    ADD CONSTRAINT tenants_currency_check
                    CHECK (currency IN ('EUR', 'GBP', 'CHF', 'USD', 'AED'));
            END IF;
        END $$;
    `);
};

export const down = (pgm) => {
    pgm.sql(`ALTER TABLE tenants DROP CONSTRAINT IF EXISTS tenants_currency_check;`);
    pgm.sql(`ALTER TABLE tenants DROP COLUMN IF EXISTS country_code;`);
    pgm.sql(`ALTER TABLE tenants DROP COLUMN IF EXISTS currency;`);
};

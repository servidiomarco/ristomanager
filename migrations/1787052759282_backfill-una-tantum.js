/**
 * Prima migration del repo: sposta fuori da createSchema() i tre backfill
 * una-tantum che giravano a ogni boot come full-table scan. Qui girano una
 * volta sola e restano registrati in pgmigrations.
 *
 * Sul database di produzione questi UPDATE/DELETE sono già stati applicati
 * dai boot precedenti: le WHERE li rendono no-op. Su un database vuoto non
 * c'è niente da riscrivere. In entrambi i casi la migration serve solo a
 * marcare il punto in cui la storia dello schema passa a node-pg-migrate.
 *
 * @type {import('node-pg-migrate').ColumnDefinitions | undefined}
 */
export const shorthands = undefined;

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 */
export const up = (pgm) => {
    // Rubrica: gli auto-importati senza telefono non sono richiamabili,
    // quindi non appartengono alla rubrica. I clienti creati a mano
    // (auto_imported = FALSE) non si toccano.
    pgm.sql(`
        DELETE FROM customers
         WHERE auto_imported = TRUE
           AND phone IS NULL;
    `);

    // Normalizzazione dei nomi esistenti in Title Case. INITCAP tratta
    // apostrofi, trattini e spazi come separatori di parola: "MARIO ROSSI",
    // "mario rossi" e "d'angelo" finiscono tutti su "Mario Rossi" /
    // "D'Angelo". I nomi nuovi arrivano già normalizzati dall'applicazione.
    pgm.sql(`
        UPDATE customers
           SET name = INITCAP(name)
         WHERE name <> INITCAP(name);
    `);

    // Comande precedenti all'introduzione di service_date/shift: derivati
    // da opened_at con la regola del giorno di servizio (comincia alle
    // 05:00 Europe/Rome — una cena che finisce all'una appartiene ancora
    // al giorno prima).
    pgm.sql(`
        UPDATE orders SET
            service_date = (
                CASE WHEN EXTRACT(hour FROM (opened_at AT TIME ZONE 'Europe/Rome')) < 5
                     THEN ((opened_at AT TIME ZONE 'Europe/Rome') - INTERVAL '1 day')::date
                     ELSE (opened_at AT TIME ZONE 'Europe/Rome')::date
                END
            ),
            shift = (
                CASE WHEN EXTRACT(hour FROM (opened_at AT TIME ZONE 'Europe/Rome')) BETWEEN 5 AND 16
                     THEN 'LUNCH' ELSE 'DINNER'
                END
            )
        WHERE service_date IS NULL OR shift IS NULL;
    `);

    // Conti precedenti all'introduzione di service_date/shift: dal servizio
    // della prima comanda agganciata, altrimenti derivati da opened_at con
    // la stessa regola delle comande.
    pgm.sql(`
        UPDATE table_bills b SET
            service_date = COALESCE(
                (SELECT o.service_date FROM orders o WHERE o.table_bill_id = b.id ORDER BY o.id LIMIT 1),
                CASE WHEN EXTRACT(hour FROM (b.opened_at AT TIME ZONE 'Europe/Rome')) < 5
                     THEN ((b.opened_at AT TIME ZONE 'Europe/Rome')::date - 1)
                     ELSE (b.opened_at AT TIME ZONE 'Europe/Rome')::date END),
            shift = COALESCE(
                (SELECT o.shift FROM orders o WHERE o.table_bill_id = b.id ORDER BY o.id LIMIT 1),
                CASE WHEN EXTRACT(hour FROM (b.opened_at AT TIME ZONE 'Europe/Rome')) BETWEEN 5 AND 16
                     THEN 'LUNCH' ELSE 'DINNER' END)
        WHERE b.service_date IS NULL OR b.shift IS NULL;
    `);
};

/**
 * Backfill di dati storici: non c'è uno stato precedente da ripristinare.
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 */
export const down = () => {};

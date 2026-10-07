/**
 * HACCP — sensori: letture affidabili e batteria (dopo la Fase 4).
 *
 * - haccp_sensor_readings: una misura per sensore e istante. I gateway
 *   ritentano e i Milesight TS30x ritrasmettono lo storico dopo un buco di
 *   rete: senza il vincolo la stessa lettura entrava due volte.
 * - haccp_sensor_readings in sola aggiunta, come haccp_changes: la lettura
 *   grezza è la prova che il registro si è scritto da solo, e non si
 *   riscrive. DELETE resta libero per il cascade del sensore.
 * - haccp_sensors.battery_alerted_at: l'avviso di batteria scarica parte una
 *   volta, e si riarma a batteria cambiata.
 *
 * @type {import('node-pg-migrate').ColumnDefinitions | undefined}
 */
export const shorthands = undefined;

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 */
export const up = (pgm) => {
    pgm.sql(`
        DELETE FROM haccp_sensor_readings a
         USING haccp_sensor_readings b
         WHERE a.sensor_id = b.sensor_id AND a.measured_at = b.measured_at AND a.id > b.id;
    `);
    pgm.sql(`CREATE UNIQUE INDEX IF NOT EXISTS haccp_sensor_readings_once ON haccp_sensor_readings (sensor_id, measured_at);`);

    pgm.sql(`
        CREATE OR REPLACE FUNCTION haccp_sensor_readings_append_only() RETURNS trigger AS $$
        BEGIN
            RAISE EXCEPTION 'haccp_sensor_readings è in sola aggiunta: una lettura del sensore non si riscrive';
        END;
        $$ LANGUAGE plpgsql;
    `);
    pgm.sql(`DROP TRIGGER IF EXISTS haccp_sensor_readings_no_update ON haccp_sensor_readings;`);
    pgm.sql(`CREATE TRIGGER haccp_sensor_readings_no_update BEFORE UPDATE ON haccp_sensor_readings
             FOR EACH ROW EXECUTE FUNCTION haccp_sensor_readings_append_only();`);

    pgm.sql(`ALTER TABLE haccp_sensors ADD COLUMN IF NOT EXISTS battery_alerted_at TIMESTAMPTZ;`);
};

export const down = (pgm) => {
    pgm.sql(`ALTER TABLE haccp_sensors DROP COLUMN IF EXISTS battery_alerted_at;`);
    pgm.sql(`DROP TRIGGER IF EXISTS haccp_sensor_readings_no_update ON haccp_sensor_readings;`);
    pgm.sql(`DROP FUNCTION IF EXISTS haccp_sensor_readings_append_only();`);
    pgm.sql(`DROP INDEX IF EXISTS haccp_sensor_readings_once;`);
};

/**
 * Varianti dalla cassa + menu digitale multilingua.
 *
 * - `modifier_groups.external_ref` ("pp:varianti:<chiave del set>") lega un
 *   gruppo varianti al SET di varianti che il gestionale attacca a un
 *   articolo o a una categoria: il sync fa upsert per set e ricollega i
 *   piatti; i gruppi creati a mano (external_ref NULL) non vengono toccati.
 * - `dishes.translations` è il testo multilingua del menu digitale
 *   ({"en":{"name","description"},...}). È territorio del CRM: la cassa non
 *   ha testi in lingua (DescrizioneInLingua vuota, verificato 27/08) e il
 *   sync non lo tocca mai.
 *
 * @type {import('node-pg-migrate').ColumnDefinitions | undefined}
 */
export const shorthands = undefined;

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 */
export const up = (pgm) => {
    pgm.sql(`ALTER TABLE modifier_groups ADD COLUMN IF NOT EXISTS external_ref TEXT;`);
    pgm.sql(`CREATE UNIQUE INDEX IF NOT EXISTS idx_modifier_groups_tenant_external_ref
             ON modifier_groups(tenant_id, external_ref) WHERE external_ref IS NOT NULL;`);
    pgm.sql(`ALTER TABLE dishes ADD COLUMN IF NOT EXISTS translations JSONB;`);
};

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 */
export const down = (pgm) => {
    pgm.sql(`DROP INDEX IF EXISTS idx_modifier_groups_tenant_external_ref;`);
    pgm.sql(`ALTER TABLE modifier_groups DROP COLUMN IF EXISTS external_ref;`);
    pgm.sql(`ALTER TABLE dishes DROP COLUMN IF EXISTS translations;`);
};

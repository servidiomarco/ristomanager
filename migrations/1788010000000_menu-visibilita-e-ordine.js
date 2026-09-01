/**
 * Visibilità e ordinamento del menu decisi dal CRM.
 *
 * - `crm_enabled`: interruttore del ristoratore, distinto da `is_active` che
 *   appartiene alla cassa (il sync Passepartout lo sovrascrive a ogni import).
 *   Un piatto è proponibile solo se entrambi sono veri.
 * - `sort_order`: posizione del piatto dentro la sua categoria. NULL = mai
 *   ordinato a mano, va in coda in ordine alfabetico.
 *
 * L'ordine e l'accensione delle CATEGORIE non hanno tabella: le categorie
 * sono stringhe libere sui piatti, le preferenze vivono nel blob
 * `menu_category_prefs` di app_settings (stesso schema delle traduzioni).
 */
export const up = (pgm) => {
    pgm.sql(`ALTER TABLE dishes ADD COLUMN IF NOT EXISTS crm_enabled BOOLEAN NOT NULL DEFAULT TRUE;`);
    pgm.sql(`ALTER TABLE dishes ADD COLUMN IF NOT EXISTS sort_order INTEGER;`);
};

export const down = (pgm) => {
    pgm.sql(`ALTER TABLE dishes DROP COLUMN IF EXISTS crm_enabled;`);
    pgm.sql(`ALTER TABLE dishes DROP COLUMN IF EXISTS sort_order;`);
};

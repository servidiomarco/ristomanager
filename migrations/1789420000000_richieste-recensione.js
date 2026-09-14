/**
 * Gestione recensioni Google — fondamenta (Fase A del piano recensioni).
 *
 * - `review_request_*` su reservations: il registro della richiesta di
 *   recensione post-visita, specchio della famiglia `confirmation_*`.
 *   `status` NULL = prenotazione mai valutata dallo sweep; non-NULL = mai
 *   più rivalutare (sent | skipped_consent | skipped_no_contact |
 *   skipped_recent | failed) — è l'idempotenza del tick, un ospite non
 *   deve ricevere due richieste.
 *   L'indice parziale tiene lo sweep O(righe nuove), non O(storico).
 * - `google_place_id` su integration_settings (riga provider
 *   'google_business'): basta da solo per il link «scrivi una recensione»
 *   (https://search.google.com/local/writereview?placeid=…), che non
 *   richiede nessuna API. OAuth e sync arrivano in Fase B.
 * - feature 'reviews' in tenant_features: add-on commerciale, acceso qui
 *   per il Vecchio Frantoio (tenant 1). I tenant futuri la ereditano dal
 *   provisioning (copia la matrice del tenant 1) solo se venduta a mano.
 * - permessi reviews:view / reviews:manage a OWNER, GENERAL_MANAGER e
 *   MANAGER in tutti i tenant: la pagina è del coordinamento, non della
 *   sala. Restringibile dalla matrice ruoli come ogni altro permesso.
 *
 * @type {import('node-pg-migrate').ColumnDefinitions | undefined}
 */
export const shorthands = undefined;

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 */
export const up = (pgm) => {
    pgm.sql(`ALTER TABLE reservations ADD COLUMN IF NOT EXISTS review_request_status VARCHAR(20);`);
    pgm.sql(`ALTER TABLE reservations ADD COLUMN IF NOT EXISTS review_request_channel VARCHAR(20);`);
    pgm.sql(`ALTER TABLE reservations ADD COLUMN IF NOT EXISTS review_request_sent_at TIMESTAMPTZ;`);
    pgm.sql(`ALTER TABLE reservations ADD COLUMN IF NOT EXISTS review_request_error TEXT;`);
    pgm.sql(`CREATE INDEX IF NOT EXISTS idx_reservations_review_request_pending
             ON reservations (tenant_id, reservation_time)
             WHERE review_request_status IS NULL;`);

    pgm.sql(`ALTER TABLE integration_settings ADD COLUMN IF NOT EXISTS google_place_id TEXT;`);

    pgm.sql(`ALTER TABLE tenant_features DROP CONSTRAINT IF EXISTS tenant_features_feature_check;`);
    pgm.sql(`ALTER TABLE tenant_features ADD CONSTRAINT tenant_features_feature_check
             CHECK (feature IN ('voice', 'whatsapp', 'web_booking', 'pay_at_table', 'passepartout', 'reviews'));`);
    pgm.sql(`INSERT INTO tenant_features (tenant_id, feature, enabled)
             SELECT 1, 'reviews', true
             WHERE EXISTS (SELECT 1 FROM tenants WHERE id = 1)
             ON CONFLICT (tenant_id, feature) DO NOTHING;`);

    pgm.sql(`INSERT INTO role_permissions (tenant_id, role, permission)
             SELECT t.id, r.role, p.permission
             FROM tenants t
             CROSS JOIN (VALUES ('OWNER'), ('GENERAL_MANAGER'), ('MANAGER')) AS r(role)
             CROSS JOIN (VALUES ('reviews:view'), ('reviews:manage')) AS p(permission)
             ON CONFLICT DO NOTHING;`);
};

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 */
export const down = (pgm) => {
    pgm.sql(`DELETE FROM role_permissions WHERE permission IN ('reviews:view', 'reviews:manage');`);
    pgm.sql(`DELETE FROM tenant_features WHERE feature = 'reviews';`);
    pgm.sql(`ALTER TABLE tenant_features DROP CONSTRAINT IF EXISTS tenant_features_feature_check;`);
    pgm.sql(`ALTER TABLE tenant_features ADD CONSTRAINT tenant_features_feature_check
             CHECK (feature IN ('voice', 'whatsapp', 'web_booking', 'pay_at_table', 'passepartout'));`);
    pgm.sql(`ALTER TABLE integration_settings DROP COLUMN IF EXISTS google_place_id;`);
    pgm.sql(`DROP INDEX IF EXISTS idx_reservations_review_request_pending;`);
    pgm.sql(`ALTER TABLE reservations DROP COLUMN IF EXISTS review_request_status;`);
    pgm.sql(`ALTER TABLE reservations DROP COLUMN IF EXISTS review_request_channel;`);
    pgm.sql(`ALTER TABLE reservations DROP COLUMN IF EXISTS review_request_sent_at;`);
    pgm.sql(`ALTER TABLE reservations DROP COLUMN IF EXISTS review_request_error;`);
};

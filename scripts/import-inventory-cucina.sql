-- Import inventario CUCINA da "INVENTARIO - INVENTARIO CELLE SOPRA.csv".
-- Crea: 7 categorie, 3 celle (Cella 1/2/3), 52 prodotti, e popola lo stock.
-- Idempotente: rieseguibile senza errori. Aggiorna le quantità di stock con i
-- valori del CSV ad ogni run.
--
-- Esecuzione (dal repo root):
--   psql "$DATABASE_URL" -f scripts/import-inventory-cucina.sql
--
-- Note:
--   - "GNOCCHI" è presente sia in PRIMI sia in CELIACO. Per consentirlo, lo
--     script migra il vincolo UNIQUE su inventory_products da (area, name) a
--     (area, COALESCE(category_id, 0), name): stesso nome in categorie diverse
--     OK, ma unico all'interno della stessa categoria.
--   - Le quantità a 0 non vengono inserite in inventory_stock (default 0).
--   - SUCCO DI LIMONE: TOTALE=0 nel CSV ma C1=4. Si è seguita la cella.
--   - PANE GRATTUGGIATO: "0'" in C3 (typo); interpretato come 0.

BEGIN;

-- ============================================
-- MIGRAZIONE SCHEMA (idempotente)
-- ============================================
ALTER TABLE inventory_products
    DROP CONSTRAINT IF EXISTS inventory_products_area_name_key;

CREATE UNIQUE INDEX IF NOT EXISTS uniq_inventory_products_area_cat_name
    ON inventory_products (area, COALESCE(category_id, 0), name);

-- ============================================
-- CATEGORIE
-- ============================================
INSERT INTO inventory_categories (area, name, sort_order) VALUES
    ('CUCINA', 'ANTIPASTI', 0),
    ('CUCINA', 'PRIMI',     1),
    ('CUCINA', 'SECONDI',   2),
    ('CUCINA', 'CELIACO',   3),
    ('CUCINA', 'VERDURE',   4),
    ('CUCINA', 'VARIE',     5),
    ('CUCINA', 'DOLCI',     6)
ON CONFLICT (area, name) DO NOTHING;

-- ============================================
-- CELLE (location)
-- ============================================
INSERT INTO inventory_locations (area, name, sort_order) VALUES
    ('CUCINA', 'Cella 1', 0),
    ('CUCINA', 'Cella 2', 1),
    ('CUCINA', 'Cella 3', 2)
ON CONFLICT (area, name) DO NOTHING;

-- ============================================
-- PRODOTTI
-- ============================================
INSERT INTO inventory_products (area, name, unit, category_id) VALUES
    -- ANTIPASTI
    ('CUCINA', 'POLPETTE DI MELANZANE',     'buste',         (SELECT id FROM inventory_categories WHERE area='CUCINA' AND name='ANTIPASTI')),
    ('CUCINA', 'MEDAGLIONI DI PATATE',      'buste',         (SELECT id FROM inventory_categories WHERE area='CUCINA' AND name='ANTIPASTI')),
    ('CUCINA', 'POLENTA STICK',             'buste',         (SELECT id FROM inventory_categories WHERE area='CUCINA' AND name='ANTIPASTI')),
    ('CUCINA', 'COTOLETTE VITELLO',         'buste',         (SELECT id FROM inventory_categories WHERE area='CUCINA' AND name='ANTIPASTI')),
    ('CUCINA', 'COTOLETTE POLLO',           'buste',         (SELECT id FROM inventory_categories WHERE area='CUCINA' AND name='ANTIPASTI')),
    -- PRIMI
    ('CUCINA', 'GNOCCHI',                   'buste',         (SELECT id FROM inventory_categories WHERE area='CUCINA' AND name='PRIMI')),
    ('CUCINA', 'GNOCCO DI ZUCCA',           'buste',         (SELECT id FROM inventory_categories WHERE area='CUCINA' AND name='PRIMI')),
    ('CUCINA', 'RAGU ALLA BOLOGNESE',       'buste',         (SELECT id FROM inventory_categories WHERE area='CUCINA' AND name='PRIMI')),
    ('CUCINA', 'LASAGNE',                   'teglie',        (SELECT id FROM inventory_categories WHERE area='CUCINA' AND name='PRIMI')),
    ('CUCINA', 'PASTA AL FORNO',            'teglie',        (SELECT id FROM inventory_categories WHERE area='CUCINA' AND name='PRIMI')),
    ('CUCINA', 'SALSA ZINGARA',             'buste da 1kg',  (SELECT id FROM inventory_categories WHERE area='CUCINA' AND name='PRIMI')),
    ('CUCINA', 'ZINGARA BIANCA',            'buste da 1kg',  (SELECT id FROM inventory_categories WHERE area='CUCINA' AND name='PRIMI')),
    -- SECONDI
    ('CUCINA', 'REALE ANGUS',               NULL,            (SELECT id FROM inventory_categories WHERE area='CUCINA' AND name='SECONDI')),
    ('CUCINA', 'COSTINE AGNELLO TAGLIATE',  'cartoni',       (SELECT id FROM inventory_categories WHERE area='CUCINA' AND name='SECONDI')),
    ('CUCINA', 'LOMBATA AGNELLO',           NULL,            (SELECT id FROM inventory_categories WHERE area='CUCINA' AND name='SECONDI')),
    ('CUCINA', 'SALSICCE POLLO',            NULL,            (SELECT id FROM inventory_categories WHERE area='CUCINA' AND name='SECONDI')),
    ('CUCINA', 'STINCHI VITELLO',           NULL,            (SELECT id FROM inventory_categories WHERE area='CUCINA' AND name='SECONDI')),
    ('CUCINA', 'STINCHI MAIALE',            NULL,            (SELECT id FROM inventory_categories WHERE area='CUCINA' AND name='SECONDI')),
    ('CUCINA', 'SALSICCIA',                 NULL,            (SELECT id FROM inventory_categories WHERE area='CUCINA' AND name='SECONDI')),
    ('CUCINA', 'COSTINE MAIALE',            NULL,            (SELECT id FROM inventory_categories WHERE area='CUCINA' AND name='SECONDI')),
    ('CUCINA', 'CAPOCOLLO MAIALE',          NULL,            (SELECT id FROM inventory_categories WHERE area='CUCINA' AND name='SECONDI')),
    ('CUCINA', 'BRASATO',                   NULL,            (SELECT id FROM inventory_categories WHERE area='CUCINA' AND name='SECONDI')),
    ('CUCINA', 'FILETTO',                   'kg',            (SELECT id FROM inventory_categories WHERE area='CUCINA' AND name='SECONDI')),
    ('CUCINA', 'TESTA FILETTO',             'kg',            (SELECT id FROM inventory_categories WHERE area='CUCINA' AND name='SECONDI')),
    ('CUCINA', 'DOPPIETTE',                 NULL,            (SELECT id FROM inventory_categories WHERE area='CUCINA' AND name='SECONDI')),
    ('CUCINA', 'PETTO DI POLLO',            NULL,            (SELECT id FROM inventory_categories WHERE area='CUCINA' AND name='SECONDI')),
    ('CUCINA', 'PORCINI',                   NULL,            (SELECT id FROM inventory_categories WHERE area='CUCINA' AND name='SECONDI')),
    ('CUCINA', 'OVULI',                     NULL,            (SELECT id FROM inventory_categories WHERE area='CUCINA' AND name='SECONDI')),
    ('CUCINA', 'POLLO A PEZZI',             NULL,            (SELECT id FROM inventory_categories WHERE area='CUCINA' AND name='SECONDI')),
    -- CELIACO
    ('CUCINA', 'GNOCCHI',                   NULL,            (SELECT id FROM inventory_categories WHERE area='CUCINA' AND name='CELIACO')),
    ('CUCINA', 'POLPETTE',                  NULL,            (SELECT id FROM inventory_categories WHERE area='CUCINA' AND name='CELIACO')),
    ('CUCINA', 'MEDAGLIONI',                NULL,            (SELECT id FROM inventory_categories WHERE area='CUCINA' AND name='CELIACO')),
    -- VERDURE
    ('CUCINA', 'BROCCOLO MOLLO',            'buste',         (SELECT id FROM inventory_categories WHERE area='CUCINA' AND name='VERDURE')),
    ('CUCINA', 'BROCCOLO MARR',             'buste',         (SELECT id FROM inventory_categories WHERE area='CUCINA' AND name='VERDURE')),
    ('CUCINA', 'CICORIA NOSTRANA',          'buste',         (SELECT id FROM inventory_categories WHERE area='CUCINA' AND name='VERDURE')),
    ('CUCINA', 'CICORIA MARR',              'buste',         (SELECT id FROM inventory_categories WHERE area='CUCINA' AND name='VERDURE')),
    ('CUCINA', 'VERDURE PASTELLATE',        'cartoni',       (SELECT id FROM inventory_categories WHERE area='CUCINA' AND name='VERDURE')),
    ('CUCINA', 'OLIVE ALL''ASCOLANA',       'buste',         (SELECT id FROM inventory_categories WHERE area='CUCINA' AND name='VERDURE')),
    ('CUCINA', 'CIME DI RAPA',              'buste',         (SELECT id FROM inventory_categories WHERE area='CUCINA' AND name='VERDURE')),
    ('CUCINA', 'CAVOLFIORE',                'buste',         (SELECT id FROM inventory_categories WHERE area='CUCINA' AND name='VERDURE')),
    ('CUCINA', 'CECI',                      'buste',         (SELECT id FROM inventory_categories WHERE area='CUCINA' AND name='VERDURE')),
    ('CUCINA', 'PEPERONCINO FRESCO',        'buste',         (SELECT id FROM inventory_categories WHERE area='CUCINA' AND name='VERDURE')),
    -- VARIE
    ('CUCINA', 'PANE AMMOLLATO',            'buste',         (SELECT id FROM inventory_categories WHERE area='CUCINA' AND name='VARIE')),
    ('CUCINA', 'PANE GRATTUGGIATO',         'buste',         (SELECT id FROM inventory_categories WHERE area='CUCINA' AND name='VARIE')),
    ('CUCINA', 'FORMAGGIO PER PIZZA',       'buste',         (SELECT id FROM inventory_categories WHERE area='CUCINA' AND name='VARIE')),
    ('CUCINA', 'SUCCO DI LIMONE',           'litri',         (SELECT id FROM inventory_categories WHERE area='CUCINA' AND name='VARIE')),
    ('CUCINA', 'PUNTILLAS',                 'buste',         (SELECT id FROM inventory_categories WHERE area='CUCINA' AND name='VARIE')),
    -- DOLCI
    ('CUCINA', 'TARTUFI EVENTI',            'PZ',            (SELECT id FROM inventory_categories WHERE area='CUCINA' AND name='DOLCI')),
    ('CUCINA', 'TIRAMISU',                  NULL,            (SELECT id FROM inventory_categories WHERE area='CUCINA' AND name='DOLCI')),
    ('CUCINA', 'TIRAMISU PISTACCHIO',       NULL,            (SELECT id FROM inventory_categories WHERE area='CUCINA' AND name='DOLCI')),
    ('CUCINA', 'SORBETTO LIMONE',           NULL,            (SELECT id FROM inventory_categories WHERE area='CUCINA' AND name='DOLCI')),
    ('CUCINA', 'SORBETTO CEDRO',            NULL,            (SELECT id FROM inventory_categories WHERE area='CUCINA' AND name='DOLCI'))
ON CONFLICT (area, (COALESCE(category_id, 0)), name) DO UPDATE
    SET unit = EXCLUDED.unit;

-- ============================================
-- STOCK (solo quantità non-zero — il default è 0)
-- I lookup di GNOCCHI sono qualificati per categoria perché esiste sia in
-- PRIMI sia in CELIACO.
-- ============================================
INSERT INTO inventory_stock (product_id, location_id, quantity) VALUES
    -- ANTIPASTI
    ((SELECT id FROM inventory_products WHERE area='CUCINA' AND name='POLPETTE DI MELANZANE'),    (SELECT id FROM inventory_locations WHERE area='CUCINA' AND name='Cella 2'), 23),
    ((SELECT id FROM inventory_products WHERE area='CUCINA' AND name='POLPETTE DI MELANZANE'),    (SELECT id FROM inventory_locations WHERE area='CUCINA' AND name='Cella 3'), 35),
    ((SELECT id FROM inventory_products WHERE area='CUCINA' AND name='MEDAGLIONI DI PATATE'),     (SELECT id FROM inventory_locations WHERE area='CUCINA' AND name='Cella 2'), 39),
    ((SELECT id FROM inventory_products WHERE area='CUCINA' AND name='POLENTA STICK'),            (SELECT id FROM inventory_locations WHERE area='CUCINA' AND name='Cella 2'), 14),
    ((SELECT id FROM inventory_products WHERE area='CUCINA' AND name='COTOLETTE VITELLO'),        (SELECT id FROM inventory_locations WHERE area='CUCINA' AND name='Cella 2'),  9),
    ((SELECT id FROM inventory_products WHERE area='CUCINA' AND name='COTOLETTE POLLO'),          (SELECT id FROM inventory_locations WHERE area='CUCINA' AND name='Cella 2'),  6),
    -- PRIMI
    ((SELECT p.id FROM inventory_products p JOIN inventory_categories c ON c.id = p.category_id WHERE p.area='CUCINA' AND p.name='GNOCCHI' AND c.name='PRIMI'),
                                                                                                  (SELECT id FROM inventory_locations WHERE area='CUCINA' AND name='Cella 2'), 73),
    ((SELECT id FROM inventory_products WHERE area='CUCINA' AND name='GNOCCO DI ZUCCA'),          (SELECT id FROM inventory_locations WHERE area='CUCINA' AND name='Cella 3'),  4),
    ((SELECT id FROM inventory_products WHERE area='CUCINA' AND name='RAGU ALLA BOLOGNESE'),      (SELECT id FROM inventory_locations WHERE area='CUCINA' AND name='Cella 1'),  6),
    ((SELECT id FROM inventory_products WHERE area='CUCINA' AND name='LASAGNE'),                  (SELECT id FROM inventory_locations WHERE area='CUCINA' AND name='Cella 2'),  1),
    -- SECONDI
    ((SELECT id FROM inventory_products WHERE area='CUCINA' AND name='REALE ANGUS'),              (SELECT id FROM inventory_locations WHERE area='CUCINA' AND name='Cella 1'),  3),
    ((SELECT id FROM inventory_products WHERE area='CUCINA' AND name='COSTINE AGNELLO TAGLIATE'), (SELECT id FROM inventory_locations WHERE area='CUCINA' AND name='Cella 1'),  2.5),
    ((SELECT id FROM inventory_products WHERE area='CUCINA' AND name='LOMBATA AGNELLO'),          (SELECT id FROM inventory_locations WHERE area='CUCINA' AND name='Cella 1'),  4),
    ((SELECT id FROM inventory_products WHERE area='CUCINA' AND name='SALSICCE POLLO'),           (SELECT id FROM inventory_locations WHERE area='CUCINA' AND name='Cella 1'),  2),
    ((SELECT id FROM inventory_products WHERE area='CUCINA' AND name='STINCHI VITELLO'),          (SELECT id FROM inventory_locations WHERE area='CUCINA' AND name='Cella 1'), 11),
    ((SELECT id FROM inventory_products WHERE area='CUCINA' AND name='STINCHI MAIALE'),           (SELECT id FROM inventory_locations WHERE area='CUCINA' AND name='Cella 1'),  3),
    ((SELECT id FROM inventory_products WHERE area='CUCINA' AND name='SALSICCIA'),                (SELECT id FROM inventory_locations WHERE area='CUCINA' AND name='Cella 1'),  2),
    ((SELECT id FROM inventory_products WHERE area='CUCINA' AND name='COSTINE MAIALE'),           (SELECT id FROM inventory_locations WHERE area='CUCINA' AND name='Cella 1'),  3),
    ((SELECT id FROM inventory_products WHERE area='CUCINA' AND name='CAPOCOLLO MAIALE'),         (SELECT id FROM inventory_locations WHERE area='CUCINA' AND name='Cella 1'),  1),
    ((SELECT id FROM inventory_products WHERE area='CUCINA' AND name='BRASATO'),                  (SELECT id FROM inventory_locations WHERE area='CUCINA' AND name='Cella 1'),  1),
    ((SELECT id FROM inventory_products WHERE area='CUCINA' AND name='FILETTO'),                  (SELECT id FROM inventory_locations WHERE area='CUCINA' AND name='Cella 1'), 755),
    ((SELECT id FROM inventory_products WHERE area='CUCINA' AND name='TESTA FILETTO'),            (SELECT id FROM inventory_locations WHERE area='CUCINA' AND name='Cella 1'), 160),
    ((SELECT id FROM inventory_products WHERE area='CUCINA' AND name='DOPPIETTE'),                (SELECT id FROM inventory_locations WHERE area='CUCINA' AND name='Cella 2'),  7),
    ((SELECT id FROM inventory_products WHERE area='CUCINA' AND name='PETTO DI POLLO'),           (SELECT id FROM inventory_locations WHERE area='CUCINA' AND name='Cella 2'), 10),
    ((SELECT id FROM inventory_products WHERE area='CUCINA' AND name='PORCINI'),                  (SELECT id FROM inventory_locations WHERE area='CUCINA' AND name='Cella 3'),  2),
    ((SELECT id FROM inventory_products WHERE area='CUCINA' AND name='OVULI'),                    (SELECT id FROM inventory_locations WHERE area='CUCINA' AND name='Cella 3'),  1),
    ((SELECT id FROM inventory_products WHERE area='CUCINA' AND name='POLLO A PEZZI'),            (SELECT id FROM inventory_locations WHERE area='CUCINA' AND name='Cella 1'),  4),
    -- CELIACO
    ((SELECT p.id FROM inventory_products p JOIN inventory_categories c ON c.id = p.category_id WHERE p.area='CUCINA' AND p.name='GNOCCHI' AND c.name='CELIACO'),
                                                                                                  (SELECT id FROM inventory_locations WHERE area='CUCINA' AND name='Cella 1'),  3),
    ((SELECT id FROM inventory_products WHERE area='CUCINA' AND name='MEDAGLIONI'),               (SELECT id FROM inventory_locations WHERE area='CUCINA' AND name='Cella 2'),  7),
    -- VERDURE
    ((SELECT id FROM inventory_products WHERE area='CUCINA' AND name='BROCCOLO MOLLO'),           (SELECT id FROM inventory_locations WHERE area='CUCINA' AND name='Cella 1'), 29),
    ((SELECT id FROM inventory_products WHERE area='CUCINA' AND name='BROCCOLO MOLLO'),           (SELECT id FROM inventory_locations WHERE area='CUCINA' AND name='Cella 3'), 133),
    ((SELECT id FROM inventory_products WHERE area='CUCINA' AND name='BROCCOLO MARR'),            (SELECT id FROM inventory_locations WHERE area='CUCINA' AND name='Cella 3'),  2),
    ((SELECT id FROM inventory_products WHERE area='CUCINA' AND name='CICORIA NOSTRANA'),         (SELECT id FROM inventory_locations WHERE area='CUCINA' AND name='Cella 3'), 73),
    ((SELECT id FROM inventory_products WHERE area='CUCINA' AND name='CICORIA MARR'),             (SELECT id FROM inventory_locations WHERE area='CUCINA' AND name='Cella 3'),  3),
    ((SELECT id FROM inventory_products WHERE area='CUCINA' AND name='VERDURE PASTELLATE'),       (SELECT id FROM inventory_locations WHERE area='CUCINA' AND name='Cella 2'),  4),
    ((SELECT id FROM inventory_products WHERE area='CUCINA' AND name='OLIVE ALL''ASCOLANA'),      (SELECT id FROM inventory_locations WHERE area='CUCINA' AND name='Cella 1'),  1),
    ((SELECT id FROM inventory_products WHERE area='CUCINA' AND name='CAVOLFIORE'),               (SELECT id FROM inventory_locations WHERE area='CUCINA' AND name='Cella 3'),  3),
    ((SELECT id FROM inventory_products WHERE area='CUCINA' AND name='CECI'),                     (SELECT id FROM inventory_locations WHERE area='CUCINA' AND name='Cella 3'),  4),
    ((SELECT id FROM inventory_products WHERE area='CUCINA' AND name='PEPERONCINO FRESCO'),       (SELECT id FROM inventory_locations WHERE area='CUCINA' AND name='Cella 3'),  3),
    -- VARIE
    ((SELECT id FROM inventory_products WHERE area='CUCINA' AND name='PANE AMMOLLATO'),           (SELECT id FROM inventory_locations WHERE area='CUCINA' AND name='Cella 3'),  2),
    ((SELECT id FROM inventory_products WHERE area='CUCINA' AND name='PANE GRATTUGGIATO'),        (SELECT id FROM inventory_locations WHERE area='CUCINA' AND name='Cella 2'),  9),
    ((SELECT id FROM inventory_products WHERE area='CUCINA' AND name='FORMAGGIO PER PIZZA'),      (SELECT id FROM inventory_locations WHERE area='CUCINA' AND name='Cella 2'),  2),
    ((SELECT id FROM inventory_products WHERE area='CUCINA' AND name='SUCCO DI LIMONE'),          (SELECT id FROM inventory_locations WHERE area='CUCINA' AND name='Cella 1'),  4),
    ((SELECT id FROM inventory_products WHERE area='CUCINA' AND name='PUNTILLAS'),                (SELECT id FROM inventory_locations WHERE area='CUCINA' AND name='Cella 1'),  2),
    -- DOLCI
    ((SELECT id FROM inventory_products WHERE area='CUCINA' AND name='TARTUFI EVENTI'),           (SELECT id FROM inventory_locations WHERE area='CUCINA' AND name='Cella 3'), 40)
ON CONFLICT (product_id, location_id) DO UPDATE
    SET quantity   = EXCLUDED.quantity,
        updated_at = CURRENT_TIMESTAMP;

COMMIT;

-- Verifica rapida (non in transazione):
-- SELECT c.name AS categoria, p.name AS prodotto, p.unit, l.name AS cella, s.quantity
-- FROM inventory_products p
-- LEFT JOIN inventory_categories c ON c.id = p.category_id
-- LEFT JOIN inventory_stock s      ON s.product_id = p.id
-- LEFT JOIN inventory_locations l  ON l.id = s.location_id
-- WHERE p.area = 'CUCINA'
-- ORDER BY c.sort_order, p.name, l.sort_order;

-- Import inventario CUCINA da "INVENTARIO - INVENTARIO CELLE SOPRA.csv".
-- Crea: 7 categorie, 3 celle (Cella 1/2/3), 52 prodotti, e popola lo stock.
-- Idempotente: rieseguibile senza errori. Aggiorna le quantità di stock con i
-- valori del CSV ad ogni run.
--
-- Esecuzione (dal repo root):
--   psql "$DATABASE_URL" -f scripts/import-inventory-cucina.sql
--
-- Note:
--   - "Gnocchi" è presente sia in Primi sia in Celiaco. Per consentirlo, lo
--     script migra il vincolo UNIQUE su inventory_products da (area, name) a
--     (area, COALESCE(category_id, 0), name): stesso nome in categorie diverse
--     OK, ma unico all'interno della stessa categoria.
--   - Le quantità a 0 non vengono inserite in inventory_stock (default 0).
--   - Succo di limone: TOTALE=0 nel CSV ma C1=4. Si è seguita la cella.
--   - Pane grattuggiato: "0'" in C3 (typo); interpretato come 0.

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
    ('CUCINA', 'Antipasti', 0),
    ('CUCINA', 'Primi',     1),
    ('CUCINA', 'Secondi',   2),
    ('CUCINA', 'Celiaco',   3),
    ('CUCINA', 'Verdure',   4),
    ('CUCINA', 'Varie',     5),
    ('CUCINA', 'Dolci',     6)
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
    -- Antipasti
    ('CUCINA', 'Polpette di melanzane',     'buste',         (SELECT id FROM inventory_categories WHERE area='CUCINA' AND name='Antipasti')),
    ('CUCINA', 'Medaglioni di patate',      'buste',         (SELECT id FROM inventory_categories WHERE area='CUCINA' AND name='Antipasti')),
    ('CUCINA', 'Polenta stick',             'buste',         (SELECT id FROM inventory_categories WHERE area='CUCINA' AND name='Antipasti')),
    ('CUCINA', 'Cotolette vitello',         'buste',         (SELECT id FROM inventory_categories WHERE area='CUCINA' AND name='Antipasti')),
    ('CUCINA', 'Cotolette pollo',           'buste',         (SELECT id FROM inventory_categories WHERE area='CUCINA' AND name='Antipasti')),
    -- Primi
    ('CUCINA', 'Gnocchi',                   'buste',         (SELECT id FROM inventory_categories WHERE area='CUCINA' AND name='Primi')),
    ('CUCINA', 'Gnocco di zucca',           'buste',         (SELECT id FROM inventory_categories WHERE area='CUCINA' AND name='Primi')),
    ('CUCINA', 'Ragu alla bolognese',       'buste',         (SELECT id FROM inventory_categories WHERE area='CUCINA' AND name='Primi')),
    ('CUCINA', 'Lasagne',                   'teglie',        (SELECT id FROM inventory_categories WHERE area='CUCINA' AND name='Primi')),
    ('CUCINA', 'Pasta al forno',            'teglie',        (SELECT id FROM inventory_categories WHERE area='CUCINA' AND name='Primi')),
    ('CUCINA', 'Salsa zingara',             'buste da 1kg',  (SELECT id FROM inventory_categories WHERE area='CUCINA' AND name='Primi')),
    ('CUCINA', 'Zingara bianca',            'buste da 1kg',  (SELECT id FROM inventory_categories WHERE area='CUCINA' AND name='Primi')),
    -- Secondi
    ('CUCINA', 'Reale angus',               NULL,            (SELECT id FROM inventory_categories WHERE area='CUCINA' AND name='Secondi')),
    ('CUCINA', 'Costine agnello tagliate',  'cartoni',       (SELECT id FROM inventory_categories WHERE area='CUCINA' AND name='Secondi')),
    ('CUCINA', 'Lombata agnello',           NULL,            (SELECT id FROM inventory_categories WHERE area='CUCINA' AND name='Secondi')),
    ('CUCINA', 'Salsicce pollo',            NULL,            (SELECT id FROM inventory_categories WHERE area='CUCINA' AND name='Secondi')),
    ('CUCINA', 'Stinchi vitello',           NULL,            (SELECT id FROM inventory_categories WHERE area='CUCINA' AND name='Secondi')),
    ('CUCINA', 'Stinchi maiale',            NULL,            (SELECT id FROM inventory_categories WHERE area='CUCINA' AND name='Secondi')),
    ('CUCINA', 'Salsiccia',                 NULL,            (SELECT id FROM inventory_categories WHERE area='CUCINA' AND name='Secondi')),
    ('CUCINA', 'Costine maiale',            NULL,            (SELECT id FROM inventory_categories WHERE area='CUCINA' AND name='Secondi')),
    ('CUCINA', 'Capocollo maiale',          NULL,            (SELECT id FROM inventory_categories WHERE area='CUCINA' AND name='Secondi')),
    ('CUCINA', 'Brasato',                   NULL,            (SELECT id FROM inventory_categories WHERE area='CUCINA' AND name='Secondi')),
    ('CUCINA', 'Filetto',                   'kg',            (SELECT id FROM inventory_categories WHERE area='CUCINA' AND name='Secondi')),
    ('CUCINA', 'Testa filetto',             'kg',            (SELECT id FROM inventory_categories WHERE area='CUCINA' AND name='Secondi')),
    ('CUCINA', 'Doppiette',                 NULL,            (SELECT id FROM inventory_categories WHERE area='CUCINA' AND name='Secondi')),
    ('CUCINA', 'Petto di pollo',            NULL,            (SELECT id FROM inventory_categories WHERE area='CUCINA' AND name='Secondi')),
    ('CUCINA', 'Porcini',                   NULL,            (SELECT id FROM inventory_categories WHERE area='CUCINA' AND name='Secondi')),
    ('CUCINA', 'Ovuli',                     NULL,            (SELECT id FROM inventory_categories WHERE area='CUCINA' AND name='Secondi')),
    ('CUCINA', 'Pollo a pezzi',             NULL,            (SELECT id FROM inventory_categories WHERE area='CUCINA' AND name='Secondi')),
    -- Celiaco
    ('CUCINA', 'Gnocchi',                   NULL,            (SELECT id FROM inventory_categories WHERE area='CUCINA' AND name='Celiaco')),
    ('CUCINA', 'Polpette',                  NULL,            (SELECT id FROM inventory_categories WHERE area='CUCINA' AND name='Celiaco')),
    ('CUCINA', 'Medaglioni',                NULL,            (SELECT id FROM inventory_categories WHERE area='CUCINA' AND name='Celiaco')),
    -- Verdure
    ('CUCINA', 'Broccolo mollo',            'buste',         (SELECT id FROM inventory_categories WHERE area='CUCINA' AND name='Verdure')),
    ('CUCINA', 'Broccolo marr',             'buste',         (SELECT id FROM inventory_categories WHERE area='CUCINA' AND name='Verdure')),
    ('CUCINA', 'Cicoria nostrana',          'buste',         (SELECT id FROM inventory_categories WHERE area='CUCINA' AND name='Verdure')),
    ('CUCINA', 'Cicoria marr',              'buste',         (SELECT id FROM inventory_categories WHERE area='CUCINA' AND name='Verdure')),
    ('CUCINA', 'Verdure pastellate',        'cartoni',       (SELECT id FROM inventory_categories WHERE area='CUCINA' AND name='Verdure')),
    ('CUCINA', 'Olive all''ascolana',       'buste',         (SELECT id FROM inventory_categories WHERE area='CUCINA' AND name='Verdure')),
    ('CUCINA', 'Cime di rapa',              'buste',         (SELECT id FROM inventory_categories WHERE area='CUCINA' AND name='Verdure')),
    ('CUCINA', 'Cavolfiore',                'buste',         (SELECT id FROM inventory_categories WHERE area='CUCINA' AND name='Verdure')),
    ('CUCINA', 'Ceci',                      'buste',         (SELECT id FROM inventory_categories WHERE area='CUCINA' AND name='Verdure')),
    ('CUCINA', 'Peperoncino fresco',        'buste',         (SELECT id FROM inventory_categories WHERE area='CUCINA' AND name='Verdure')),
    -- Varie
    ('CUCINA', 'Pane ammollato',            'buste',         (SELECT id FROM inventory_categories WHERE area='CUCINA' AND name='Varie')),
    ('CUCINA', 'Pane grattuggiato',         'buste',         (SELECT id FROM inventory_categories WHERE area='CUCINA' AND name='Varie')),
    ('CUCINA', 'Formaggio per pizza',       'buste',         (SELECT id FROM inventory_categories WHERE area='CUCINA' AND name='Varie')),
    ('CUCINA', 'Succo di limone',           'litri',         (SELECT id FROM inventory_categories WHERE area='CUCINA' AND name='Varie')),
    ('CUCINA', 'Puntillas',                 'buste',         (SELECT id FROM inventory_categories WHERE area='CUCINA' AND name='Varie')),
    -- Dolci
    ('CUCINA', 'Tartufi eventi',            'PZ',            (SELECT id FROM inventory_categories WHERE area='CUCINA' AND name='Dolci')),
    ('CUCINA', 'Tiramisu',                  NULL,            (SELECT id FROM inventory_categories WHERE area='CUCINA' AND name='Dolci')),
    ('CUCINA', 'Tiramisu pistacchio',       NULL,            (SELECT id FROM inventory_categories WHERE area='CUCINA' AND name='Dolci')),
    ('CUCINA', 'Sorbetto limone',           NULL,            (SELECT id FROM inventory_categories WHERE area='CUCINA' AND name='Dolci')),
    ('CUCINA', 'Sorbetto cedro',            NULL,            (SELECT id FROM inventory_categories WHERE area='CUCINA' AND name='Dolci'))
ON CONFLICT (area, (COALESCE(category_id, 0)), name) DO UPDATE
    SET unit = EXCLUDED.unit;

-- ============================================
-- STOCK (solo quantità non-zero — il default è 0)
-- I lookup di Gnocchi sono qualificati per categoria perché esiste sia in
-- Primi sia in Celiaco.
-- ============================================
INSERT INTO inventory_stock (product_id, location_id, quantity) VALUES
    -- Antipasti
    ((SELECT id FROM inventory_products WHERE area='CUCINA' AND name='Polpette di melanzane'),    (SELECT id FROM inventory_locations WHERE area='CUCINA' AND name='Cella 2'), 23),
    ((SELECT id FROM inventory_products WHERE area='CUCINA' AND name='Polpette di melanzane'),    (SELECT id FROM inventory_locations WHERE area='CUCINA' AND name='Cella 3'), 35),
    ((SELECT id FROM inventory_products WHERE area='CUCINA' AND name='Medaglioni di patate'),     (SELECT id FROM inventory_locations WHERE area='CUCINA' AND name='Cella 2'), 39),
    ((SELECT id FROM inventory_products WHERE area='CUCINA' AND name='Polenta stick'),            (SELECT id FROM inventory_locations WHERE area='CUCINA' AND name='Cella 2'), 14),
    ((SELECT id FROM inventory_products WHERE area='CUCINA' AND name='Cotolette vitello'),        (SELECT id FROM inventory_locations WHERE area='CUCINA' AND name='Cella 2'),  9),
    ((SELECT id FROM inventory_products WHERE area='CUCINA' AND name='Cotolette pollo'),          (SELECT id FROM inventory_locations WHERE area='CUCINA' AND name='Cella 2'),  6),
    -- Primi
    ((SELECT p.id FROM inventory_products p JOIN inventory_categories c ON c.id = p.category_id WHERE p.area='CUCINA' AND p.name='Gnocchi' AND c.name='Primi'),
                                                                                                  (SELECT id FROM inventory_locations WHERE area='CUCINA' AND name='Cella 2'), 73),
    ((SELECT id FROM inventory_products WHERE area='CUCINA' AND name='Gnocco di zucca'),          (SELECT id FROM inventory_locations WHERE area='CUCINA' AND name='Cella 3'),  4),
    ((SELECT id FROM inventory_products WHERE area='CUCINA' AND name='Ragu alla bolognese'),      (SELECT id FROM inventory_locations WHERE area='CUCINA' AND name='Cella 1'),  6),
    ((SELECT id FROM inventory_products WHERE area='CUCINA' AND name='Lasagne'),                  (SELECT id FROM inventory_locations WHERE area='CUCINA' AND name='Cella 2'),  1),
    -- Secondi
    ((SELECT id FROM inventory_products WHERE area='CUCINA' AND name='Reale angus'),              (SELECT id FROM inventory_locations WHERE area='CUCINA' AND name='Cella 1'),  3),
    ((SELECT id FROM inventory_products WHERE area='CUCINA' AND name='Costine agnello tagliate'), (SELECT id FROM inventory_locations WHERE area='CUCINA' AND name='Cella 1'),  2.5),
    ((SELECT id FROM inventory_products WHERE area='CUCINA' AND name='Lombata agnello'),          (SELECT id FROM inventory_locations WHERE area='CUCINA' AND name='Cella 1'),  4),
    ((SELECT id FROM inventory_products WHERE area='CUCINA' AND name='Salsicce pollo'),           (SELECT id FROM inventory_locations WHERE area='CUCINA' AND name='Cella 1'),  2),
    ((SELECT id FROM inventory_products WHERE area='CUCINA' AND name='Stinchi vitello'),          (SELECT id FROM inventory_locations WHERE area='CUCINA' AND name='Cella 1'), 11),
    ((SELECT id FROM inventory_products WHERE area='CUCINA' AND name='Stinchi maiale'),           (SELECT id FROM inventory_locations WHERE area='CUCINA' AND name='Cella 1'),  3),
    ((SELECT id FROM inventory_products WHERE area='CUCINA' AND name='Salsiccia'),                (SELECT id FROM inventory_locations WHERE area='CUCINA' AND name='Cella 1'),  2),
    ((SELECT id FROM inventory_products WHERE area='CUCINA' AND name='Costine maiale'),           (SELECT id FROM inventory_locations WHERE area='CUCINA' AND name='Cella 1'),  3),
    ((SELECT id FROM inventory_products WHERE area='CUCINA' AND name='Capocollo maiale'),         (SELECT id FROM inventory_locations WHERE area='CUCINA' AND name='Cella 1'),  1),
    ((SELECT id FROM inventory_products WHERE area='CUCINA' AND name='Brasato'),                  (SELECT id FROM inventory_locations WHERE area='CUCINA' AND name='Cella 1'),  1),
    ((SELECT id FROM inventory_products WHERE area='CUCINA' AND name='Filetto'),                  (SELECT id FROM inventory_locations WHERE area='CUCINA' AND name='Cella 1'), 755),
    ((SELECT id FROM inventory_products WHERE area='CUCINA' AND name='Testa filetto'),            (SELECT id FROM inventory_locations WHERE area='CUCINA' AND name='Cella 1'), 160),
    ((SELECT id FROM inventory_products WHERE area='CUCINA' AND name='Doppiette'),                (SELECT id FROM inventory_locations WHERE area='CUCINA' AND name='Cella 2'),  7),
    ((SELECT id FROM inventory_products WHERE area='CUCINA' AND name='Petto di pollo'),           (SELECT id FROM inventory_locations WHERE area='CUCINA' AND name='Cella 2'), 10),
    ((SELECT id FROM inventory_products WHERE area='CUCINA' AND name='Porcini'),                  (SELECT id FROM inventory_locations WHERE area='CUCINA' AND name='Cella 3'),  2),
    ((SELECT id FROM inventory_products WHERE area='CUCINA' AND name='Ovuli'),                    (SELECT id FROM inventory_locations WHERE area='CUCINA' AND name='Cella 3'),  1),
    ((SELECT id FROM inventory_products WHERE area='CUCINA' AND name='Pollo a pezzi'),            (SELECT id FROM inventory_locations WHERE area='CUCINA' AND name='Cella 1'),  4),
    -- Celiaco
    ((SELECT p.id FROM inventory_products p JOIN inventory_categories c ON c.id = p.category_id WHERE p.area='CUCINA' AND p.name='Gnocchi' AND c.name='Celiaco'),
                                                                                                  (SELECT id FROM inventory_locations WHERE area='CUCINA' AND name='Cella 1'),  3),
    ((SELECT id FROM inventory_products WHERE area='CUCINA' AND name='Medaglioni'),               (SELECT id FROM inventory_locations WHERE area='CUCINA' AND name='Cella 2'),  7),
    -- Verdure
    ((SELECT id FROM inventory_products WHERE area='CUCINA' AND name='Broccolo mollo'),           (SELECT id FROM inventory_locations WHERE area='CUCINA' AND name='Cella 1'), 29),
    ((SELECT id FROM inventory_products WHERE area='CUCINA' AND name='Broccolo mollo'),           (SELECT id FROM inventory_locations WHERE area='CUCINA' AND name='Cella 3'), 133),
    ((SELECT id FROM inventory_products WHERE area='CUCINA' AND name='Broccolo marr'),            (SELECT id FROM inventory_locations WHERE area='CUCINA' AND name='Cella 3'),  2),
    ((SELECT id FROM inventory_products WHERE area='CUCINA' AND name='Cicoria nostrana'),         (SELECT id FROM inventory_locations WHERE area='CUCINA' AND name='Cella 3'), 73),
    ((SELECT id FROM inventory_products WHERE area='CUCINA' AND name='Cicoria marr'),             (SELECT id FROM inventory_locations WHERE area='CUCINA' AND name='Cella 3'),  3),
    ((SELECT id FROM inventory_products WHERE area='CUCINA' AND name='Verdure pastellate'),       (SELECT id FROM inventory_locations WHERE area='CUCINA' AND name='Cella 2'),  4),
    ((SELECT id FROM inventory_products WHERE area='CUCINA' AND name='Olive all''ascolana'),      (SELECT id FROM inventory_locations WHERE area='CUCINA' AND name='Cella 1'),  1),
    ((SELECT id FROM inventory_products WHERE area='CUCINA' AND name='Cavolfiore'),               (SELECT id FROM inventory_locations WHERE area='CUCINA' AND name='Cella 3'),  3),
    ((SELECT id FROM inventory_products WHERE area='CUCINA' AND name='Ceci'),                     (SELECT id FROM inventory_locations WHERE area='CUCINA' AND name='Cella 3'),  4),
    ((SELECT id FROM inventory_products WHERE area='CUCINA' AND name='Peperoncino fresco'),       (SELECT id FROM inventory_locations WHERE area='CUCINA' AND name='Cella 3'),  3),
    -- Varie
    ((SELECT id FROM inventory_products WHERE area='CUCINA' AND name='Pane ammollato'),           (SELECT id FROM inventory_locations WHERE area='CUCINA' AND name='Cella 3'),  2),
    ((SELECT id FROM inventory_products WHERE area='CUCINA' AND name='Pane grattuggiato'),        (SELECT id FROM inventory_locations WHERE area='CUCINA' AND name='Cella 2'),  9),
    ((SELECT id FROM inventory_products WHERE area='CUCINA' AND name='Formaggio per pizza'),      (SELECT id FROM inventory_locations WHERE area='CUCINA' AND name='Cella 2'),  2),
    ((SELECT id FROM inventory_products WHERE area='CUCINA' AND name='Succo di limone'),          (SELECT id FROM inventory_locations WHERE area='CUCINA' AND name='Cella 1'),  4),
    ((SELECT id FROM inventory_products WHERE area='CUCINA' AND name='Puntillas'),                (SELECT id FROM inventory_locations WHERE area='CUCINA' AND name='Cella 1'),  2),
    -- Dolci
    ((SELECT id FROM inventory_products WHERE area='CUCINA' AND name='Tartufi eventi'),           (SELECT id FROM inventory_locations WHERE area='CUCINA' AND name='Cella 3'), 40)
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

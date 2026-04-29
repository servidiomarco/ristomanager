-- Script per popolare sale e tavoli del ristorante
-- Eseguire con: psql $DATABASE_URL -f scripts/seed-tables.sql

-- 1. Cancella tutti i tavoli esistenti
DELETE FROM tables;

-- 2. Cancella tutte le sale esistenti
DELETE FROM rooms;

-- 3. Crea le 6 sale
INSERT INTO rooms (name) VALUES
  ('Veranda'),
  ('Fiume'),
  ('Fuori'),
  ('Tettoia'),
  ('Macine'),
  ('Porticato');

-- 4. Crea i tavoli per ogni sala

-- VERANDA (30 tavoli)
INSERT INTO tables (name, shape, seats, min_seats, max_seats, x, y, room_id, status) VALUES
  ('23', 'rectangle', 3, 2, 3, 0, 0, (SELECT id FROM rooms WHERE name = 'Veranda'), 'AVAILABLE'),
  ('24', 'rectangle', 3, 2, 3, 100, 0, (SELECT id FROM rooms WHERE name = 'Veranda'), 'AVAILABLE'),
  ('25', 'rectangle', 3, 2, 3, 200, 0, (SELECT id FROM rooms WHERE name = 'Veranda'), 'AVAILABLE'),
  ('26', 'rectangle', 8, 4, 8, 300, 0, (SELECT id FROM rooms WHERE name = 'Veranda'), 'AVAILABLE'),
  ('27', 'rectangle', 5, 4, 5, 400, 0, (SELECT id FROM rooms WHERE name = 'Veranda'), 'AVAILABLE'),
  ('28', 'rectangle', 8, 4, 8, 0, 100, (SELECT id FROM rooms WHERE name = 'Veranda'), 'AVAILABLE'),
  ('29', 'rectangle', 3, 2, 3, 100, 100, (SELECT id FROM rooms WHERE name = 'Veranda'), 'AVAILABLE'),
  ('30', 'rectangle', 8, 6, 8, 200, 100, (SELECT id FROM rooms WHERE name = 'Veranda'), 'AVAILABLE'),
  ('30 Bis', 'rectangle', 3, 2, 3, 300, 100, (SELECT id FROM rooms WHERE name = 'Veranda'), 'AVAILABLE'),
  ('31', 'rectangle', 6, 4, 6, 400, 100, (SELECT id FROM rooms WHERE name = 'Veranda'), 'AVAILABLE'),
  ('32', 'rectangle', 6, 4, 6, 0, 200, (SELECT id FROM rooms WHERE name = 'Veranda'), 'AVAILABLE'),
  ('32 Bis', 'rectangle', 3, 2, 3, 100, 200, (SELECT id FROM rooms WHERE name = 'Veranda'), 'AVAILABLE'),
  ('33', 'rectangle', 3, 2, 3, 200, 200, (SELECT id FROM rooms WHERE name = 'Veranda'), 'AVAILABLE'),
  ('33 Bis', 'rectangle', 3, 2, 3, 300, 200, (SELECT id FROM rooms WHERE name = 'Veranda'), 'AVAILABLE'),
  ('34', 'rectangle', 3, 2, 3, 400, 200, (SELECT id FROM rooms WHERE name = 'Veranda'), 'AVAILABLE'),
  ('35', 'rectangle', 5, 3, 5, 0, 300, (SELECT id FROM rooms WHERE name = 'Veranda'), 'AVAILABLE'),
  ('36', 'rectangle', 6, 4, 6, 100, 300, (SELECT id FROM rooms WHERE name = 'Veranda'), 'AVAILABLE'),
  ('37', 'rectangle', 2, 2, 2, 200, 300, (SELECT id FROM rooms WHERE name = 'Veranda'), 'AVAILABLE'),
  ('38', 'rectangle', 3, 2, 3, 300, 300, (SELECT id FROM rooms WHERE name = 'Veranda'), 'AVAILABLE'),
  ('39', 'rectangle', 3, 2, 3, 400, 300, (SELECT id FROM rooms WHERE name = 'Veranda'), 'AVAILABLE'),
  ('40', 'rectangle', 6, 4, 6, 0, 400, (SELECT id FROM rooms WHERE name = 'Veranda'), 'AVAILABLE'),
  ('50', 'rectangle', 3, 2, 3, 100, 400, (SELECT id FROM rooms WHERE name = 'Veranda'), 'AVAILABLE'),
  ('54', 'rectangle', 5, 3, 5, 200, 400, (SELECT id FROM rooms WHERE name = 'Veranda'), 'AVAILABLE'),
  ('52', 'rectangle', 5, 3, 5, 300, 400, (SELECT id FROM rooms WHERE name = 'Veranda'), 'AVAILABLE'),
  ('51', 'rectangle', 6, 4, 6, 400, 400, (SELECT id FROM rooms WHERE name = 'Veranda'), 'AVAILABLE'),
  ('53', 'rectangle', 8, 4, 8, 0, 500, (SELECT id FROM rooms WHERE name = 'Veranda'), 'AVAILABLE'),
  ('55', 'rectangle', 3, 2, 3, 100, 500, (SELECT id FROM rooms WHERE name = 'Veranda'), 'AVAILABLE'),
  ('56', 'rectangle', 10, 4, 10, 200, 500, (SELECT id FROM rooms WHERE name = 'Veranda'), 'AVAILABLE'),
  ('57', 'rectangle', 4, 2, 4, 300, 500, (SELECT id FROM rooms WHERE name = 'Veranda'), 'AVAILABLE'),
  ('58', 'rectangle', 4, 2, 4, 400, 500, (SELECT id FROM rooms WHERE name = 'Veranda'), 'AVAILABLE');

-- FIUME (13 tavoli)
INSERT INTO tables (name, shape, seats, min_seats, max_seats, x, y, room_id, status) VALUES
  ('100', 'rectangle', 5, 2, 5, 0, 0, (SELECT id FROM rooms WHERE name = 'Fiume'), 'AVAILABLE'),
  ('101', 'rectangle', 8, 4, 8, 100, 0, (SELECT id FROM rooms WHERE name = 'Fiume'), 'AVAILABLE'),
  ('102', 'rectangle', 3, 2, 3, 200, 0, (SELECT id FROM rooms WHERE name = 'Fiume'), 'AVAILABLE'),
  ('103', 'rectangle', 3, 2, 3, 300, 0, (SELECT id FROM rooms WHERE name = 'Fiume'), 'AVAILABLE'),
  ('104', 'rectangle', 5, 4, 5, 0, 100, (SELECT id FROM rooms WHERE name = 'Fiume'), 'AVAILABLE'),
  ('105', 'rectangle', 5, 4, 5, 100, 100, (SELECT id FROM rooms WHERE name = 'Fiume'), 'AVAILABLE'),
  ('106', 'rectangle', 4, 2, 4, 200, 100, (SELECT id FROM rooms WHERE name = 'Fiume'), 'AVAILABLE'),
  ('107', 'rectangle', 10, 6, 10, 300, 100, (SELECT id FROM rooms WHERE name = 'Fiume'), 'AVAILABLE'),
  ('108', 'rectangle', 6, 4, 6, 0, 200, (SELECT id FROM rooms WHERE name = 'Fiume'), 'AVAILABLE'),
  ('109', 'rectangle', 6, 4, 6, 100, 200, (SELECT id FROM rooms WHERE name = 'Fiume'), 'AVAILABLE'),
  ('110', 'rectangle', 6, 2, 6, 200, 200, (SELECT id FROM rooms WHERE name = 'Fiume'), 'AVAILABLE'),
  ('111', 'rectangle', 6, 2, 6, 300, 200, (SELECT id FROM rooms WHERE name = 'Fiume'), 'AVAILABLE'),
  ('112', 'rectangle', 4, 2, 4, 0, 300, (SELECT id FROM rooms WHERE name = 'Fiume'), 'AVAILABLE');

-- FUORI (24 tavoli)
INSERT INTO tables (name, shape, seats, min_seats, max_seats, x, y, room_id, status) VALUES
  ('0', 'rectangle', 6, 2, 6, 0, 0, (SELECT id FROM rooms WHERE name = 'Fuori'), 'AVAILABLE'),
  ('1', 'rectangle', 8, 4, 8, 100, 0, (SELECT id FROM rooms WHERE name = 'Fuori'), 'AVAILABLE'),
  ('2', 'rectangle', 8, 4, 8, 200, 0, (SELECT id FROM rooms WHERE name = 'Fuori'), 'AVAILABLE'),
  ('3', 'rectangle', 6, 2, 6, 300, 0, (SELECT id FROM rooms WHERE name = 'Fuori'), 'AVAILABLE'),
  ('3 Bis', 'rectangle', 3, 2, 3, 400, 0, (SELECT id FROM rooms WHERE name = 'Fuori'), 'AVAILABLE'),
  ('4', 'rectangle', 3, 2, 3, 0, 100, (SELECT id FROM rooms WHERE name = 'Fuori'), 'AVAILABLE'),
  ('5', 'rectangle', 10, 4, 10, 100, 100, (SELECT id FROM rooms WHERE name = 'Fuori'), 'AVAILABLE'),
  ('6', 'rectangle', 6, 4, 6, 200, 100, (SELECT id FROM rooms WHERE name = 'Fuori'), 'AVAILABLE'),
  ('7', 'rectangle', 6, 2, 6, 300, 100, (SELECT id FROM rooms WHERE name = 'Fuori'), 'AVAILABLE'),
  ('8', 'rectangle', 6, 4, 6, 400, 100, (SELECT id FROM rooms WHERE name = 'Fuori'), 'AVAILABLE'),
  ('9', 'rectangle', 6, 2, 6, 0, 200, (SELECT id FROM rooms WHERE name = 'Fuori'), 'AVAILABLE'),
  ('10', 'rectangle', 2, 2, 2, 100, 200, (SELECT id FROM rooms WHERE name = 'Fuori'), 'AVAILABLE'),
  ('11', 'rectangle', 6, 2, 6, 200, 200, (SELECT id FROM rooms WHERE name = 'Fuori'), 'AVAILABLE'),
  ('12', 'rectangle', 6, 4, 6, 300, 200, (SELECT id FROM rooms WHERE name = 'Fuori'), 'AVAILABLE'),
  ('13', 'rectangle', 6, 2, 6, 400, 200, (SELECT id FROM rooms WHERE name = 'Fuori'), 'AVAILABLE'),
  ('14', 'rectangle', 6, 4, 6, 0, 300, (SELECT id FROM rooms WHERE name = 'Fuori'), 'AVAILABLE'),
  ('15', 'rectangle', 6, 4, 6, 100, 300, (SELECT id FROM rooms WHERE name = 'Fuori'), 'AVAILABLE'),
  ('16', 'rectangle', 6, 4, 6, 200, 300, (SELECT id FROM rooms WHERE name = 'Fuori'), 'AVAILABLE'),
  ('17', 'rectangle', 6, 2, 6, 300, 300, (SELECT id FROM rooms WHERE name = 'Fuori'), 'AVAILABLE'),
  ('18', 'rectangle', 6, 2, 6, 400, 300, (SELECT id FROM rooms WHERE name = 'Fuori'), 'AVAILABLE'),
  ('20', 'rectangle', 6, 4, 6, 0, 400, (SELECT id FROM rooms WHERE name = 'Fuori'), 'AVAILABLE'),
  ('21', 'rectangle', 6, 2, 6, 100, 400, (SELECT id FROM rooms WHERE name = 'Fuori'), 'AVAILABLE'),
  ('22', 'rectangle', 6, 2, 6, 200, 400, (SELECT id FROM rooms WHERE name = 'Fuori'), 'AVAILABLE'),
  ('23', 'rectangle', 6, 2, 6, 300, 400, (SELECT id FROM rooms WHERE name = 'Fuori'), 'AVAILABLE');

-- TETTOIA (19 tavoli)
INSERT INTO tables (name, shape, seats, min_seats, max_seats, x, y, room_id, status) VALUES
  ('60', 'rectangle', 12, 10, 12, 0, 0, (SELECT id FROM rooms WHERE name = 'Tettoia'), 'AVAILABLE'),
  ('61', 'rectangle', 4, 2, 4, 100, 0, (SELECT id FROM rooms WHERE name = 'Tettoia'), 'AVAILABLE'),
  ('62', 'rectangle', 4, 2, 4, 200, 0, (SELECT id FROM rooms WHERE name = 'Tettoia'), 'AVAILABLE'),
  ('63', 'rectangle', 4, 2, 4, 300, 0, (SELECT id FROM rooms WHERE name = 'Tettoia'), 'AVAILABLE'),
  ('64', 'rectangle', 14, 10, 14, 0, 100, (SELECT id FROM rooms WHERE name = 'Tettoia'), 'AVAILABLE'),
  ('65', 'rectangle', 6, 4, 6, 100, 100, (SELECT id FROM rooms WHERE name = 'Tettoia'), 'AVAILABLE'),
  ('66', 'rectangle', 6, 4, 6, 200, 100, (SELECT id FROM rooms WHERE name = 'Tettoia'), 'AVAILABLE'),
  ('67', 'rectangle', 3, 2, 3, 300, 100, (SELECT id FROM rooms WHERE name = 'Tettoia'), 'AVAILABLE'),
  ('68', 'rectangle', 6, 4, 6, 0, 200, (SELECT id FROM rooms WHERE name = 'Tettoia'), 'AVAILABLE'),
  ('69', 'rectangle', 6, 4, 6, 100, 200, (SELECT id FROM rooms WHERE name = 'Tettoia'), 'AVAILABLE'),
  ('70', 'rectangle', 16, 10, 16, 200, 200, (SELECT id FROM rooms WHERE name = 'Tettoia'), 'AVAILABLE'),
  ('71', 'rectangle', 3, 2, 3, 300, 200, (SELECT id FROM rooms WHERE name = 'Tettoia'), 'AVAILABLE'),
  ('72', 'rectangle', 4, 2, 4, 0, 300, (SELECT id FROM rooms WHERE name = 'Tettoia'), 'AVAILABLE'),
  ('73', 'rectangle', 4, 2, 4, 100, 300, (SELECT id FROM rooms WHERE name = 'Tettoia'), 'AVAILABLE'),
  ('74', 'rectangle', 10, 6, 10, 200, 300, (SELECT id FROM rooms WHERE name = 'Tettoia'), 'AVAILABLE'),
  ('77', 'rectangle', 6, 4, 6, 300, 300, (SELECT id FROM rooms WHERE name = 'Tettoia'), 'AVAILABLE'),
  ('78', 'rectangle', 6, 4, 6, 0, 400, (SELECT id FROM rooms WHERE name = 'Tettoia'), 'AVAILABLE'),
  ('79', 'rectangle', 6, 4, 6, 100, 400, (SELECT id FROM rooms WHERE name = 'Tettoia'), 'AVAILABLE'),
  ('80', 'rectangle', 3, 2, 3, 200, 400, (SELECT id FROM rooms WHERE name = 'Tettoia'), 'AVAILABLE');

-- MACINE (9 tavoli)
INSERT INTO tables (name, shape, seats, min_seats, max_seats, x, y, room_id, status) VALUES
  ('41', 'rectangle', 3, 2, 3, 0, 0, (SELECT id FROM rooms WHERE name = 'Macine'), 'AVAILABLE'),
  ('42', 'rectangle', 8, 4, 8, 100, 0, (SELECT id FROM rooms WHERE name = 'Macine'), 'AVAILABLE'),
  ('43', 'rectangle', 6, 3, 6, 200, 0, (SELECT id FROM rooms WHERE name = 'Macine'), 'AVAILABLE'),
  ('44', 'rectangle', 4, 4, 4, 0, 100, (SELECT id FROM rooms WHERE name = 'Macine'), 'AVAILABLE'),
  ('45', 'rectangle', 3, 2, 3, 100, 100, (SELECT id FROM rooms WHERE name = 'Macine'), 'AVAILABLE'),
  ('46', 'rectangle', 3, 2, 3, 200, 100, (SELECT id FROM rooms WHERE name = 'Macine'), 'AVAILABLE'),
  ('47', 'rectangle', 12, 4, 12, 0, 200, (SELECT id FROM rooms WHERE name = 'Macine'), 'AVAILABLE'),
  ('48', 'rectangle', 3, 2, 3, 100, 200, (SELECT id FROM rooms WHERE name = 'Macine'), 'AVAILABLE'),
  ('49', 'rectangle', 3, 2, 3, 200, 200, (SELECT id FROM rooms WHERE name = 'Macine'), 'AVAILABLE');

-- PORTICATO (7 tavoli)
INSERT INTO tables (name, shape, seats, min_seats, max_seats, x, y, room_id, status) VALUES
  ('200', 'rectangle', 3, 2, 3, 0, 0, (SELECT id FROM rooms WHERE name = 'Porticato'), 'AVAILABLE'),
  ('201', 'rectangle', 3, 2, 3, 100, 0, (SELECT id FROM rooms WHERE name = 'Porticato'), 'AVAILABLE'),
  ('202', 'rectangle', 2, 2, 2, 200, 0, (SELECT id FROM rooms WHERE name = 'Porticato'), 'AVAILABLE'),
  ('203', 'rectangle', 2, 2, 2, 0, 100, (SELECT id FROM rooms WHERE name = 'Porticato'), 'AVAILABLE'),
  ('204', 'rectangle', 2, 2, 2, 100, 100, (SELECT id FROM rooms WHERE name = 'Porticato'), 'AVAILABLE'),
  ('205', 'rectangle', 2, 2, 2, 200, 100, (SELECT id FROM rooms WHERE name = 'Porticato'), 'AVAILABLE'),
  ('206', 'rectangle', 2, 2, 2, 0, 200, (SELECT id FROM rooms WHERE name = 'Porticato'), 'AVAILABLE');

-- Verifica finale
SELECT r.name as sala, COUNT(t.id) as tavoli FROM rooms r LEFT JOIN tables t ON t.room_id = r.id GROUP BY r.name ORDER BY r.name;

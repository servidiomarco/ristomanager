#!/usr/bin/env bash
#
# Avvia l'ambiente di collaudo del modulo comande: database, dati di prova,
# backend e frontend. Pensato per essere lanciato e basta.
#
#   ./scripts/dev-comande.sh
#
# Variabili opzionali:
#   DATABASE_URL   stringa di connessione (default: postgresql://localhost/ristocomande)
#   API_PORT       porta del backend  (default 4599)
#   WEB_PORT       porta del frontend (default 5199)
#   RESET=1        svuota comande e dati di prova prima di ripartire
#
set -euo pipefail
cd "$(dirname "$0")/.."

DATABASE_URL="${DATABASE_URL:-postgresql://localhost/ristocomande}"
API_PORT="${API_PORT:-4599}"
WEB_PORT="${WEB_PORT:-5199}"
JWT_SECRET="${JWT_SECRET:-dev-collaudo-secret}"
LOGIN_EMAIL="${LOGIN_EMAIL:-collaudo@ristomanager.local}"
LOGIN_PASSWORD="${LOGIN_PASSWORD:-Comande2026!}"

say() { printf '\n\033[1;36m▸ %s\033[0m\n' "$1"; }
die() { printf '\n\033[1;31m✗ %s\033[0m\n' "$1" >&2; exit 1; }

command -v psql >/dev/null || die "psql non trovato. Installa PostgreSQL (macOS: brew install postgresql@16, poi brew services start postgresql@16)."
command -v node >/dev/null || die "node non trovato."

# --- database ---------------------------------------------------------------
# L'URL si parsifica con node, non con espansioni di shell: un parametro come
# ?host=/percorso/con/slash manderebbe fuori strada ${VAR##*/}.
DB_NAME=$(node -e "process.stdout.write(new URL(process.argv[1]).pathname.replace(/^\//,''))" "$DATABASE_URL")
DB_HOST=$(node -e "process.stdout.write(new URL(process.argv[1]).hostname)" "$DATABASE_URL")
ADMIN_URL=$(node -e "const u=new URL(process.argv[1]); u.pathname='/postgres'; process.stdout.write(u.toString())" "$DATABASE_URL")

# Questo script semina dati di prova e con RESET=1 cancella le comande: non
# deve poterlo fare per sbaglio su un database remoto.
case "$DB_HOST" in
    localhost|127.0.0.1|::1|"") ;;
    *)
        printf '\n\033[1;33m⚠ DATABASE_URL punta a un host remoto: %s\033[0m\n' "$DB_HOST"
        printf '  Questo script inserisce dati di prova. Continuare? [scrivi: si] '
        read -r reply
        [ "$reply" = "si" ] || die "Annullato."
        ;;
esac

say "Database"
if ! psql "$DATABASE_URL" -c 'SELECT 1' >/dev/null 2>&1; then
    echo "  creo il database '$DB_NAME'…"
    psql "$ADMIN_URL" -q -c "CREATE DATABASE \"$DB_NAME\"" 2>/dev/null \
        || die "Non riesco a creare '$DB_NAME'. Il server PostgreSQL è avviato? Prova: psql \"$ADMIN_URL\" -c 'select 1'"
fi
echo "  ok: $DB_NAME"

# --- dipendenze -------------------------------------------------------------
if [ ! -d node_modules ]; then
    say "Dipendenze (npm install)"
    npm install --no-audit --no-fund
fi

# --- schema -----------------------------------------------------------------
# createSchema è idempotente: crea ciò che manca e lascia stare il resto.
say "Schema"
cat > .dev-schema.mjs <<'EOF'
import { createSchema } from './db.ts';
await createSchema();
process.exit(0);
EOF
DATABASE_URL="$DATABASE_URL" npx tsx .dev-schema.mjs
rm -f .dev-schema.mjs

# --- dati di prova ----------------------------------------------------------
say "Dati di prova"
if [ "${RESET:-0}" = "1" ]; then
    psql "$DATABASE_URL" -q -c "DELETE FROM order_items; DELETE FROM orders;"
    echo "  comande azzerate"
fi

PASSWORD_HASH=$(node -e "process.stdout.write(require('bcryptjs').hashSync(process.argv[1], 10))" "$LOGIN_PASSWORD")

psql "$DATABASE_URL" -q -v ON_ERROR_STOP=1 \
     -v email="'$LOGIN_EMAIL'" -v hash="'$PASSWORD_HASH'" <<'SQL'
-- Utente di collaudo (OWNER: vede tutto)
-- tenant_id esplicito ovunque: dal drop del DEFAULT 1 (#202) gli INSERT
-- senza tenant muoiono di NOT NULL, e questo seed era rimasto indietro.
INSERT INTO users (tenant_id, email, password_hash, full_name, role, is_active)
VALUES (1, :email, :hash, 'Collaudo Comande', 'OWNER', true)
ON CONFLICT (email) DO UPDATE SET password_hash = EXCLUDED.password_hash, is_active = true;

-- Sala e tavoli
INSERT INTO rooms (tenant_id, id, name, width, height) VALUES (1, 1, 'Sala', 900, 700)
ON CONFLICT (id) DO NOTHING;
INSERT INTO tables (tenant_id, id, name, shape, seats, x, y, room_id, status) VALUES
    (1, 11, '11', 'SQUARE',    2,  60,  60, 1, 'FREE'),
    (1, 12, '12', 'RECTANGLE', 4, 220,  60, 1, 'FREE'),
    (1, 13, '13', 'CIRCLE',    6, 380,  60, 1, 'FREE')
ON CONFLICT (id) DO NOTHING;
SELECT setval('tables_id_seq', GREATEST((SELECT MAX(id) FROM tables), 1));
SELECT setval('rooms_id_seq',  GREATEST((SELECT MAX(id) FROM rooms), 1));

-- Piatti in tre categorie
INSERT INTO dishes (tenant_id, name, price, category) VALUES
    (1, 'Tagliere di salumi', 14.00, 'Antipasti'),
    (1, 'Bruschette',          8.00, 'Antipasti'),
    (1, 'Cacio e pepe',       12.50, 'Primi'),
    (1, 'Amatriciana',        13.00, 'Primi'),
    (1, 'Tagliata di manzo',  22.90, 'Secondi'),
    (1, 'Costata',            28.00, 'Secondi')
ON CONFLICT DO NOTHING;

-- Partite e tempi: senza prep_minutes lo scaglionamento non ha dati e
-- tutte le partite partono insieme.
UPDATE dishes SET station_id = (SELECT id FROM stations WHERE name = 'Antipasti'), prep_minutes = 3
 WHERE category = 'Antipasti' AND station_id IS NULL;
UPDATE dishes SET station_id = (SELECT id FROM stations WHERE name = 'Primi'), prep_minutes = 8
 WHERE category = 'Primi' AND station_id IS NULL;
UPDATE dishes SET station_id = (SELECT id FROM stations WHERE name = 'Griglia'), prep_minutes = 14
 WHERE category = 'Secondi' AND station_id IS NULL;

-- Prezzi nel listino di default per i piatti che non ce l'hanno
INSERT INTO dish_prices (tenant_id, dish_id, price_list_id, price_cents)
SELECT 1, d.id, (SELECT id FROM menu_price_lists WHERE is_default), ROUND(d.price * 100)::int
FROM dishes d
ON CONFLICT (dish_id, price_list_id) DO NOTHING;

-- Varianti sulla carne: un gruppo obbligatorio (cottura) e uno libero
INSERT INTO modifier_groups (tenant_id, name, min_select, max_select, sort_order)
SELECT 1, 'Cottura', 1, 1, 1
WHERE NOT EXISTS (SELECT 1 FROM modifier_groups WHERE name = 'Cottura');
INSERT INTO modifier_groups (tenant_id, name, min_select, max_select, sort_order)
SELECT 1, 'Aggiunte', 0, 3, 2
WHERE NOT EXISTS (SELECT 1 FROM modifier_groups WHERE name = 'Aggiunte');

INSERT INTO modifiers (tenant_id, group_id, name, price_delta_cents, sort_order)
SELECT 1, g.id, v.name, v.delta, v.ord
FROM modifier_groups g
JOIN (VALUES ('Al sangue', 0, 1), ('Media', 0, 2), ('Ben cotta', 0, 3)) AS v(name, delta, ord) ON TRUE
WHERE g.name = 'Cottura'
  AND NOT EXISTS (SELECT 1 FROM modifiers m WHERE m.group_id = g.id AND m.name = v.name);

INSERT INTO modifiers (tenant_id, group_id, name, price_delta_cents, sort_order)
SELECT 1, g.id, v.name, v.delta, v.ord
FROM modifier_groups g
JOIN (VALUES ('Con burrata', 250, 1), ('Senza sale', 0, 2)) AS v(name, delta, ord) ON TRUE
WHERE g.name = 'Aggiunte'
  AND NOT EXISTS (SELECT 1 FROM modifiers m WHERE m.group_id = g.id AND m.name = v.name);

INSERT INTO dish_modifier_groups (tenant_id, dish_id, group_id)
SELECT 1, d.id, g.id FROM dishes d, modifier_groups g
WHERE d.category = 'Secondi' AND g.name IN ('Cottura', 'Aggiunte')
ON CONFLICT DO NOTHING;

-- Una prenotazione su un tavolo, per vedere nome e allergeni in testata
INSERT INTO reservations (tenant_id, customer_name, reservation_time, shift, guests, table_id, payment_status, reservation_status, arrival_status)
SELECT 1, 'Famiglia Rossi', CURRENT_DATE + TIME '20:30', 'DINNER', 4, 12, 'PENDING', 'CONFIRMED', 'ARRIVED'
WHERE NOT EXISTS (SELECT 1 FROM reservations WHERE customer_name = 'Famiglia Rossi' AND table_id = 12);

-- Modulo acceso, prima uscita che parte da sola
UPDATE app_settings SET value = true       WHERE key = 'table_orders_enabled';
UPDATE app_settings SET text_value = 'AUTO_FIRST' WHERE key = 'course_fire_mode';
SQL

# Gli allergeni arrivano dal CRM: li mettiamo sulla prenotazione di prova.
psql "$DATABASE_URL" -q -c \
  "UPDATE reservations SET notes = 'Un ospite celiaco' WHERE customer_name = 'Famiglia Rossi';" 2>/dev/null || true

echo "  tavoli 11/12/13, 6 piatti su 3 partite, varianti sulla carne, prenotazione al 12"

# --- avvio ------------------------------------------------------------------
cleanup() { echo; say "Chiusura"; kill 0 2>/dev/null || true; }
trap cleanup EXIT INT TERM

say "Avvio backend (porta $API_PORT)"
DATABASE_URL="$DATABASE_URL" JWT_SECRET="$JWT_SECRET" PORT="$API_PORT" npx tsx server.ts 2>&1 | sed 's/^/[api] /' &

for i in $(seq 1 60); do
    if curl -fsS "http://localhost:$API_PORT/health" >/dev/null 2>&1; then break; fi
    sleep 1
done
curl -fsS "http://localhost:$API_PORT/health" >/dev/null 2>&1 || die "Il backend non risponde. Guarda le righe [api] qui sopra."

say "Avvio frontend (porta $WEB_PORT)"
VITE_API_URL="http://localhost:$API_PORT" npx vite --port "$WEB_PORT" --host 2>&1 | sed 's/^/[web] /' &

sleep 3
cat <<BANNER

┌────────────────────────────────────────────────────────────┐
  Ambiente di collaudo pronto.

  Apri            http://localhost:$WEB_PORT
  Accedi con      $LOGIN_EMAIL
                  $LOGIN_PASSWORD
  Poi vai su      Servizio → Comande

  Backend         http://localhost:$API_PORT
  Ctrl-C per fermare tutto.
└────────────────────────────────────────────────────────────┘

BANNER

wait

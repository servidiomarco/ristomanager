#!/usr/bin/env bash
# Ambiente di collaudo locale del gestionale sala: backend + frontend + agente
# di stampa, in un colpo solo. Ctrl-C spegne tutto.
#
# Uso:
#   ./scripts/test-locale.sh
#
# Prerequisiti (una tantum):
#   - Postgres locale attivo, con il database di test già creato e migrato
#     (createdb ristomanager_orderpad_test + primo avvio del server:
#     su DB vuoto serve prima il branch claude/fix-createschema-db-vuoto).
#   - npm install già fatto.
#
# Override via env (tutti opzionali):
#   TEST_DB       nome database          (default ristomanager_orderpad_test)
#   PORT_API      porta backend          (default 3005)
#   PORT_WEB      porta vite             (default 5173)
#   PRINTERS      mappa stampanti        (default: preconti+antipasti+bar collaudate il 30/07)
#   PRINT_TOKEN   token agente<->backend (default collaudo-print-2026)
set -euo pipefail

TEST_DB="${TEST_DB:-ristomanager_orderpad_test}"
PORT_API="${PORT_API:-3005}"
PORT_WEB="${PORT_WEB:-5173}"
PRINT_TOKEN="${PRINT_TOKEN:-collaudo-print-2026}"
PRINTERS="${PRINTERS:-preconti=192.168.1.50:9100,antipasti=192.168.1.30:9100,bar=192.168.1.200:9100}"

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
LOG_DIR="${TMPDIR:-/tmp}/ristomanager-test-locale"
mkdir -p "$LOG_DIR"

say()  { printf '\033[1;36m▸ %s\033[0m\n' "$*"; }
fail() { printf '\033[1;31m✗ %s\033[0m\n' "$*" >&2; exit 1; }

# --- prerequisiti -----------------------------------------------------------
command -v psql >/dev/null || fail "psql non trovato"
[ -d "$REPO_DIR/node_modules" ] || fail "node_modules assente: lancia prima 'npm install'"
psql -d "$TEST_DB" -tAc 'SELECT 1' >/dev/null 2>&1 \
  || fail "database '$TEST_DB' non raggiungibile (Postgres attivo? DB creato e migrato?)"
TABLES=$(psql -d "$TEST_DB" -tAc "SELECT count(*) FROM information_schema.tables WHERE table_schema='public'")
[ "$TABLES" -gt 0 ] || fail "il database '$TEST_DB' è vuoto: crea lo schema col branch claude/fix-createschema-db-vuoto"

IP=$(ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null || echo 127.0.0.1)

# --- eventuali istanze precedenti -------------------------------------------
for port in "$PORT_API" "$PORT_WEB"; do
  PIDS=$(lsof -ti tcp:"$port" -sTCP:LISTEN 2>/dev/null || true)
  if [ -n "$PIDS" ]; then
    say "chiudo l'istanza precedente sulla porta $port"
    kill $PIDS 2>/dev/null || true
  fi
done
pkill -f 'scripts/print-agent.mjs' 2>/dev/null || true
sleep 1

# --- avvio ------------------------------------------------------------------
PIDS_STARTED=()
cleanup() {
  echo
  say "spengo tutto…"
  kill "${PIDS_STARTED[@]}" 2>/dev/null || true
  wait 2>/dev/null || true
  say "fatto. I log restano in $LOG_DIR"
}
trap cleanup EXIT INT TERM

say "backend :$PORT_API (db $TEST_DB) — log: $LOG_DIR/backend.log"
( cd "$REPO_DIR" && \
  DATABASE_URL="postgresql://$(whoami)@localhost:5432/$TEST_DB" \
  JWT_SECRET=testsecret JWT_REFRESH_SECRET=testrefresh \
  PRINT_AGENT_TOKEN="$PRINT_TOKEN" PORT="$PORT_API" \
  npm run start:server ) > "$LOG_DIR/backend.log" 2>&1 &
PIDS_STARTED+=($!)

for _ in $(seq 1 60); do
  grep -q 'Database schema initialized' "$LOG_DIR/backend.log" 2>/dev/null && break
  sleep 2
done
grep -q 'Database schema initialized' "$LOG_DIR/backend.log" \
  || fail "il backend non è partito: guarda $LOG_DIR/backend.log"

say "frontend :$PORT_WEB (API su http://$IP:$PORT_API) — log: $LOG_DIR/vite.log"
( cd "$REPO_DIR" && VITE_API_URL="http://$IP:$PORT_API" npx vite --port "$PORT_WEB" --host ) \
  > "$LOG_DIR/vite.log" 2>&1 &
PIDS_STARTED+=($!)

say "agente di stampa [$PRINTERS] — log: $LOG_DIR/agent.log"
( cd "$REPO_DIR" && \
  API_URL="http://localhost:$PORT_API" PRINT_AGENT_TOKEN="$PRINT_TOKEN" PRINTERS="$PRINTERS" \
  node scripts/print-agent.mjs ) > "$LOG_DIR/agent.log" 2>&1 &
PIDS_STARTED+=($!)

sleep 3

echo
printf '\033[1;32m✓ ambiente di collaudo attivo\033[0m\n'
echo   "  Dal Mac:       http://localhost:$PORT_WEB"
echo   "  Dal telefono:  http://$IP:$PORT_WEB   (stessa rete WiFi!)"
echo   "  Login:         collaudo@test.local / frantoio"
echo   "  Stampanti:     $PRINTERS"
echo
echo   "  QR per il telefono:"
node -e "require('qrcode').toString('http://$IP:$PORT_WEB',{type:'terminal',small:true},(e,s)=>console.log(s))" 2>/dev/null || true
echo   "  Ctrl-C per spegnere tutto."
echo

# resta in attesa finché non arriva Ctrl-C
wait

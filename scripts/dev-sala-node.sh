#!/usr/bin/env bash
# Collaudo locale del nodo di sala (tappa 3: relay + cache di lettura).
#
# Si appoggia allo stack comande esistente: prima, in un altro terminale,
#   ./scripts/dev-comande.sh
# poi questo script:
#   1. legge (o semina) tenants.sala_node_token nel DB locale;
#   2. avvia il nodo in HTTP su :8090 puntato all'API locale;
#   3. stampa la checklist di collaudo (relay, cache hit, stale, resync).
#
# Il frontend si punta al nodo a mano solo per il fumo (curl): il routing
# client vero arriva con la PR 3.

set -euo pipefail
cd "$(dirname "$0")/.."

DB_URL="${DB_URL:-postgresql://localhost/ristocomande}"
API_PORT="${API_PORT:-4599}"
NODE_PORT="${NODE_PORT:-8090}"

# Stessa guardia degli altri script: mai contro un DB remoto.
DB_HOST=$(node -e "try{console.log(new URL(process.argv[1]).hostname)}catch{console.log('')}" "$DB_URL")
if [[ -n "$DB_HOST" && "$DB_HOST" != "localhost" && "$DB_HOST" != "127.0.0.1" ]]; then
    echo "DB_URL punta a '$DB_HOST', non a localhost: mi fermo." >&2
    exit 1
fi

if ! curl -sf "http://localhost:${API_PORT}/health" >/dev/null; then
    echo "Nessuna API su :${API_PORT}. Avvia prima ./scripts/dev-comande.sh (o esporta API_PORT)." >&2
    exit 1
fi

# La colonna arriva dalla migration nodo-di-sala; se il seed del tenant 1 non
# l'ha popolata (DB nato prima), la si genera qui.
# head -1: con -Atc psql stampa anche il command tag ("UPDATE 1") dopo la
# riga del RETURNING, e finirebbe dentro il token.
TOKEN=$(psql "$DB_URL" -Atc "UPDATE tenants SET sala_node_token = COALESCE(sala_node_token, encode(gen_random_bytes(24), 'hex')) WHERE id = 1 RETURNING sala_node_token;" | head -1)
if [[ -z "$TOKEN" ]]; then
    echo "Impossibile leggere/seminare sala_node_token (migration non applicata?)." >&2
    exit 1
fi

echo ""
echo "Nodo di sala in HTTP su :${NODE_PORT} → API http://localhost:${API_PORT}"
echo ""
echo "Checklist di collaudo (in un altro terminale):"
echo "  TOKEN_JWT=\$(curl -s http://localhost:${API_PORT}/auth/login -H 'Content-Type: application/json' \\"
echo "     -d '{\"email\":\"collaudo@ristomanager.local\",\"password\":\"Comande2026!\"}' | jq -r .accessToken)"
echo "  1. healthz:    curl -s http://localhost:${NODE_PORT}/healthz | jq        # cloud_link: true"
echo "  2. proxy:      curl -si http://localhost:${NODE_PORT}/menu/catalogue -H \"Authorization: Bearer \$TOKEN_JWT\" | grep -i x-sala-node   # → proxy"
echo "  3. stale:      ferma l'API (Ctrl-C su dev-comande), ripeti il curl     # → stale + X-Sala-Node-Age"
echo "  4. resync:     riavvia dev-comande.sh e guarda il log del nodo         # → 'cache svuotata, sala:resync inviato'"
echo "  5. relay:      con un client socket.io su :${NODE_PORT} (auth: \$TOKEN_JWT), crea una comanda via API e osserva order:created"
echo ""

SALA_NODE_TOKEN="$TOKEN" \
CLOUD_URL="http://localhost:${API_PORT}" \
PORT="$NODE_PORT" \
exec node --loader ts-node/esm sala-node/index.ts

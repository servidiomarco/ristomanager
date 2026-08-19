#!/usr/bin/env bash
#
# Crea il ruolo applicativo NON-superuser per la produzione (checklist
# pre-tenant-2). I superuser bypassano la Row-Level Security anche con
# FORCE: finché l'app si connette come postgres, le policy della Fase B4
# sono decorative — il boot lo segnala con un warning.
#
#   DATABASE_URL=postgresql://postgres:...@host/db ./scripts/create-app-role.sh
#
# Stampa la nuova connection string da mettere in DATABASE_URL su Railway.
# Idempotente: se il ruolo esiste aggiorna solo grant e password.
set -euo pipefail

[ -n "${DATABASE_URL:-}" ] || { echo "✗ DATABASE_URL mancante (deve puntare alla PRODUZIONE)"; exit 1; }
command -v psql >/dev/null || { echo "✗ psql non trovato"; exit 1; }

ROLE="${APP_ROLE:-app_ristomanager}"
PASSWORD="${APP_ROLE_PASSWORD:-$(openssl rand -hex 24)}"

psql "$DATABASE_URL" -v ON_ERROR_STOP=1 <<SQL
DO \$\$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${ROLE}') THEN
        CREATE ROLE ${ROLE} LOGIN;
    END IF;
END \$\$;
ALTER ROLE ${ROLE} LOGIN PASSWORD '${PASSWORD}' NOSUPERUSER NOCREATEDB NOCREATEROLE;
GRANT USAGE ON SCHEMA public TO ${ROLE};
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${ROLE};
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${ROLE};
-- Le tabelle/sequence future (migrations) devono nascere già concesse:
-- senza questi default il primo deploy con una tabella nuova darebbe
-- "permission denied" al ruolo applicativo.
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${ROLE};
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO ${ROLE};
SQL

# createSchema/migrations girano al boot con la STESSA connessione dell'app:
# devono poter creare tabelle. CREATE sul database, non sullo schema di
# terzi: il ruolo resta non-superuser e non-owner, quindi la RLS si applica.
DBNAME=$(node -e "process.stdout.write(new URL(process.argv[1]).pathname.slice(1))" "$DATABASE_URL")
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -c "GRANT CREATE ON SCHEMA public TO ${ROLE}; GRANT CREATE, CONNECT, TEMP ON DATABASE \"${DBNAME}\" TO ${ROLE};"

NEWURL=$(node -e "const u=new URL(process.argv[1]); u.username='${ROLE}'; u.password='${PASSWORD}'; process.stdout.write(u.toString())" "$DATABASE_URL")
echo
echo "✓ Ruolo ${ROLE} pronto. Metti su Railway:"
echo "  DATABASE_URL=${NEWURL}"
echo
echo "Al riavvio il warning '⚠️ Connessione da SUPERUSER' deve sparire dai log."

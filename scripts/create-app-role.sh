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
# terzi: il ruolo resta non-superuser, quindi la RLS si applica.
DBNAME=$(node -e "process.stdout.write(new URL(process.argv[1]).pathname.slice(1))" "$DATABASE_URL")
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -c "GRANT CREATE ON SCHEMA public TO ${ROLE}; GRANT CREATE, CONNECT, TEMP ON DATABASE \"${DBNAME}\" TO ${ROLE};"

# OWNERSHIP degli oggetti ESISTENTI. I soli grant non bastano su un database
# già popolato: createSchema fa ALTER TABLE ... ADD COLUMN a OGNI boot e
# ricrea funzioni con CREATE OR REPLACE — entrambe richiedono la ownership,
# non i privilegi. Su un DB vergine il problema non si vede (è il ruolo a
# creare tutto); su produzione, senza questo blocco, il primo boot col ruolo
# nuovo muore di "must be owner of table". La RLS non si indebolisce: le
# policy della B4 sono con FORCE proprio perché il disegno prevede l'app
# come owner (vedi commento in cima alla migration row-level-security).
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 <<SQL
DO \$\$
DECLARE r RECORD;
BEGIN
    FOR r IN SELECT tablename FROM pg_tables WHERE schemaname = 'public' LOOP
        EXECUTE format('ALTER TABLE public.%I OWNER TO ${ROLE}', r.tablename);
    END LOOP;
    FOR r IN SELECT sequencename FROM pg_sequences WHERE schemaname = 'public' LOOP
        EXECUTE format('ALTER SEQUENCE public.%I OWNER TO ${ROLE}', r.sequencename);
    END LOOP;
    FOR r IN
        SELECT p.proname, pg_get_function_identity_arguments(p.oid) AS args
          FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public'
    LOOP
        EXECUTE format('ALTER FUNCTION public.%I(%s) OWNER TO ${ROLE}', r.proname, r.args);
    END LOOP;
END \$\$;
SQL

NEWURL=$(node -e "const u=new URL(process.argv[1]); u.username='${ROLE}'; u.password='${PASSWORD}'; process.stdout.write(u.toString())" "$DATABASE_URL")
echo
echo "✓ Ruolo ${ROLE} pronto. Metti su Railway:"
echo "  DATABASE_URL=${NEWURL}"
echo
echo "Al riavvio il warning '⚠️ Connessione da SUPERUSER' deve sparire dai log."

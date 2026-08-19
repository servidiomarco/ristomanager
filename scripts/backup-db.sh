#!/usr/bin/env bash
# Fase D4 — Backup del database (pg_dump formato custom + gzip + rotazione).
#
# A DIFFERENZA degli altri script in scripts/ (dev-comande.sh, test-locale.sh),
# la guardia sull'host è INVERTITA: quelli droppano e riseminano, quindi
# rifiutano tutto ciò che non è localhost; questo legge soltanto, e il suo
# scopo È puntare alla produzione (Railway). L'unico requisito è che
# DATABASE_URL sia impostata esplicitamente — nessun default, così un run a
# vuoto fallisce rumorosamente invece di scaricare il database sbagliato.
#
# Uso:   DATABASE_URL='postgresql://...' ./scripts/backup-db.sh
# Cron:  da schedulare FUORI dal repo (launchd/cron in locale o Railway cron).
#
# Formato custom (-Fc): ripristinabile selettivamente con pg_restore, anche
# tabella per tabella — un dump plain SQL costringerebbe a un restore tutto-o-
# niente. gzip sopra il -Fc per uniformità di rotazione (.dump.gz).
set -euo pipefail

if [ -z "${DATABASE_URL:-}" ]; then
    echo "Errore: DATABASE_URL non impostata." >&2
    echo "Uso: DATABASE_URL='postgresql://...' $0" >&2
    exit 1
fi

# La cartella backups/ vive nella root del repo (è già in .gitignore).
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BACKUP_DIR="$REPO_ROOT/backups"
mkdir -p "$BACKUP_DIR"

STAMP="$(date +%Y%m%d-%H%M%S)"
DUMP_FILE="$BACKUP_DIR/railway-full-$STAMP.dump"

echo "Dump in corso → $DUMP_FILE"
pg_dump --format=custom --no-owner --file="$DUMP_FILE" "$DATABASE_URL"

gzip "$DUMP_FILE"
echo "Compresso → $DUMP_FILE.gz"

# Rotazione: si tengono gli ultimi 14 dump (due settimane a un backup al
# giorno), i più vecchi vengono eliminati. ls -1t ordina dal più recente.
KEEP=14
ls -1t "$BACKUP_DIR"/railway-full-*.dump.gz 2>/dev/null | tail -n +"$((KEEP + 1))" | while read -r old; do
    echo "Rotazione: elimino $old"
    rm -f "$old"
done

echo "Backup completato: $(ls -1t "$BACKUP_DIR"/railway-full-*.dump.gz | head -1)"

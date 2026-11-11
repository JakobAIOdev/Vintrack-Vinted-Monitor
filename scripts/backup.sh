#!/usr/bin/env sh
# Writes a PostgreSQL dump of the running instance outside the checkout.
set -eu

ROOT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
cd "$ROOT_DIR"
BACKUP_DIR="${VINTRACK_BACKUP_DIR:-$ROOT_DIR/../vintrack-backups}"

umask 077
mkdir -p "$BACKUP_DIR"
BACKUP_DIR="$(CDPATH= cd -- "$BACKUP_DIR" && pwd)"
dump_file="$BACKUP_DIR/vintrack-$(date +%Y%m%d-%H%M%S).dump"

if ! docker compose exec -T postgres pg_dump -U vinuser -d vintrack -Fc > "$dump_file.partial"; then
    rm -f "$dump_file.partial"
    echo "Backup failed. Is the database running (docker compose ps postgres)?" >&2
    exit 1
fi
if [ ! -s "$dump_file.partial" ]; then
    rm -f "$dump_file.partial"
    echo "Backup failed: the dump is empty." >&2
    exit 1
fi
mv "$dump_file.partial" "$dump_file"

echo "Database backup written to $dump_file"
echo "Keep a copy off this server, together with .env:"
echo "linked Vinted sessions can only be read with the original VINTED_SESSION_ENCRYPTION_KEY."

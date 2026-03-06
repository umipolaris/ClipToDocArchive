#!/usr/bin/env sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
INFRA_DIR=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)
COMPOSE="$SCRIPT_DIR/compose.sh"

BACKUP_DIR=${BACKUP_DIR:-"$INFRA_DIR/data/backup/db"}
RETENTION_DAYS=${BACKUP_RETENTION_DAYS:-30}
TS=$(date +%Y%m%d_%H%M%S)

mkdir -p "$BACKUP_DIR"

DB_NAME=${POSTGRES_DB:-archive}
OUT_FILE="$BACKUP_DIR/archive_${DB_NAME}_${TS}.dump"
TMP_FILE="${OUT_FILE}.tmp"
META_FILE="${OUT_FILE}.meta"

"$COMPOSE" exec -T postgres sh -lc \
  'PGPASSWORD="$POSTGRES_PASSWORD" pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc --no-owner --no-privileges' \
  > "$TMP_FILE"

mv "$TMP_FILE" "$OUT_FILE"

compute_sha256() {
  target=$1
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$target" | awk "{print \$1}"
    return
  fi
  if command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$target" | awk "{print \$1}"
    return
  fi
  if command -v openssl >/dev/null 2>&1; then
    openssl dgst -sha256 "$target" | awk "{print \$NF}"
    return
  fi
  if command -v python3 >/dev/null 2>&1; then
    python3 - "$target" <<'PY'
import hashlib
import pathlib
import sys
path = pathlib.Path(sys.argv[1])
print(hashlib.sha256(path.read_bytes()).hexdigest())
PY
    return
  fi
  echo "no sha256 tool found (need sha256sum/shasum/openssl/python3)" >&2
  return 1
}

SHA256=$(compute_sha256 "$OUT_FILE")

{
  echo "timestamp=$TS"
  echo "db_name=$DB_NAME"
  echo "file=$(basename "$OUT_FILE")"
  echo "sha256=$SHA256"
  echo "app_profile=${APP_PROFILE:-dev}"
} > "$META_FILE"

if [ "$RETENTION_DAYS" -gt 0 ] 2>/dev/null; then
  find "$BACKUP_DIR" -type f \( -name "*.dump" -o -name "*.dump.meta" \) -mtime +"$RETENTION_DAYS" -delete
fi

echo "db backup done"
echo "  file: $OUT_FILE"
echo "  meta: $META_FILE"
echo "  sha256: $SHA256"

#!/usr/bin/env sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
INFRA_DIR=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)

if [ -d /backup ]; then
  BACKUP_BASE=${BACKUP_BASE:-/backup}
else
  BACKUP_BASE=${BACKUP_BASE:-"$INFRA_DIR/data/backup"}
fi

RETENTION_DAYS=${BACKUP_RETENTION_DAYS:-30}
TS=$(date +%Y%m%d_%H%M%S)
OUT_DIR="$BACKUP_BASE/config"
mkdir -p "$OUT_DIR"

if [ -d /config ]; then
  CONFIG_ROOT=/config
else
  CONFIG_ROOT="$INFRA_DIR"
fi

set --
if [ -d "$CONFIG_ROOT/env" ]; then
  set -- "$@" env
fi
if [ -d "$CONFIG_ROOT/monitoring" ]; then
  set -- "$@" monitoring
fi
if [ -f "$CONFIG_ROOT/docker-compose.yml" ]; then
  set -- "$@" docker-compose.yml
fi

if [ "$#" -eq 0 ]; then
  echo "no config sources found under $CONFIG_ROOT"
  exit 1
fi

OUT_FILE="$OUT_DIR/config_${TS}.tar.gz"
TMP_FILE="${OUT_FILE}.tmp"
META_FILE="${OUT_FILE}.meta"

tar -czf "$TMP_FILE" -C "$CONFIG_ROOT" "$@"
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
  echo "type=config"
  echo "config_root=$CONFIG_ROOT"
  echo "items=$*"
  echo "file=$(basename "$OUT_FILE")"
  echo "sha256=$SHA256"
  echo "app_profile=${APP_PROFILE:-dev}"
} > "$META_FILE"

if [ "$RETENTION_DAYS" -gt 0 ] 2>/dev/null; then
  find "$OUT_DIR" -type f \( -name "*.tar.gz" -o -name "*.tar.gz.meta" \) -mtime +"$RETENTION_DAYS" -delete
fi

echo "config backup done"
echo "  file: $OUT_FILE"
echo "  meta: $META_FILE"
echo "  sha256: $SHA256"

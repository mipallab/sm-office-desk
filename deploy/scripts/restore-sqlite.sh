#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
DEPLOY_DIR="$(cd -- "${SCRIPT_DIR}/.." && pwd)"
COMPOSE_FILE="${DEPLOY_DIR}/docker-compose.yml"
ENV_FILE="${DEPLOY_DIR}/.env.production"
BACKUP_FILE=""
AUTO_YES=0
DRY_RUN=0

usage() {
  cat <<'EOF'
Usage: restore-sqlite.sh --file <backup.db.gz|backup.db> [OPTIONS]

Safely restores a SQLite backup into the `sm_office_data` volume:
  1. Verifies `.sha256` checksum (if `<file>.sha256` exists).
  2. Stages & validates the candidate DB via `PRAGMA integrity_check;` BEFORE touching live data.
  3. Stops the `api` container cleanly so no writer holds the WAL.
  4. Snapshots existing live `/data/office.db*` files onto the host.
  5. Atomically replaces `/data/office.db`, removes stale `-wal`/`-shm` files, and sets `1000:1000` ownership.
  6. Restarts `api` and polls `/api/health` until healthy.

Options:
  --file PATH         Path to `.db.gz` or `.db` backup file (or pass as positional arg)
  --env-file PATH     Path to production env file (default: deploy/.env.production)
  --dry-run           Verify checksum and SQLite integrity only; do not stop api or modify live data
  -y, --yes           Skip interactive confirmation prompt
  -h, --help          Show this help message and exit
EOF
}

load_env_file() {
  local file="$1"
  [[ -f "$file" ]] || return 0
  while IFS= read -r line || [[ -n "$line" ]]; do
    line="${line%$'\r'}"
    [[ "$line" =~ ^[[:space:]]*(#|$) ]] && continue
    if [[ "$line" =~ ^[[:space:]]*([A-Za-z_][A-Za-z0-9_]*)=(.*)$ ]]; then
      local key="${BASH_REMATCH[1]}"
      local val="${BASH_REMATCH[2]}"
      if [[ "$val" =~ ^\"(.*)\"$ ]]; then
        val="${BASH_REMATCH[1]}"
      elif [[ "$val" =~ ^\'(.*)\'$ ]]; then
        val="${BASH_REMATCH[1]}"
      else
        val="${val%% #*}"
        val="${val%"${val##*[![:space:]]}"}"
      fi
      if [[ -z "${!key+x}" ]]; then
        export "$key=$val"
      fi
    fi
  done < "$file"
}

trim() {
  local v="$1"
  v="${v#"${v%%[![:space:]]*}"}"
  v="${v%"${v##*[![:space:]]}"}"
  printf '%s' "$v"
}

compose_cmd() {
  if [[ -f "$ENV_FILE" ]]; then
    docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" "$@"
  else
    docker compose -f "$COMPOSE_FILE" "$@"
  fi
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --file)
      [[ $# -ge 2 ]] || { echo "ERROR: --file requires a path" >&2; exit 1; }
      BACKUP_FILE="$2"
      shift 2
      ;;
    --env-file)
      [[ $# -ge 2 ]] || { echo "ERROR: --env-file requires a path" >&2; exit 1; }
      ENV_FILE="$2"
      shift 2
      ;;
    --dry-run)
      DRY_RUN=1
      shift
      ;;
    -y|--yes)
      AUTO_YES=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    -*)
      echo "ERROR: Unknown option: $1" >&2
      usage >&2
      exit 1
      ;;
    *)
      if [[ -z "$BACKUP_FILE" ]]; then
        BACKUP_FILE="$1"
        shift
      else
        echo "ERROR: Unexpected argument: $1" >&2
        usage >&2
        exit 1
      fi
      ;;
  esac
done

if [[ -z "$BACKUP_FILE" ]]; then
  echo "ERROR: Missing backup file path." >&2
  usage >&2
  exit 1
fi

if [[ ! -f "$BACKUP_FILE" || ! -s "$BACKUP_FILE" ]]; then
  echo "ERROR: Backup file does not exist or is empty: $BACKUP_FILE" >&2
  exit 1
fi

load_env_file "$ENV_FILE"
SQLITE_PATH="$(trim "${SQLITE_PATH:-/data/office.db}")"
BACKUP_DIR="$(trim "${BACKUP_DIR:-/var/backups/sm-office-desk}")"

for req in sha256sum gzip; do
  command -v "$req" >/dev/null 2>&1 || { echo "ERROR: Required tool '$req' not found." >&2; exit 1; }
done

# 1. Verify .sha256 sidecar if present
CHECKSUM_FILE="${BACKUP_FILE}.sha256"
if [[ -f "$CHECKSUM_FILE" ]]; then
  echo "[1/6] Verifying SHA-256 checksum ($CHECKSUM_FILE)..."
  EXPECTED_SHA="$(awk '{print $1}' "$CHECKSUM_FILE" | head -n 1 | tr -d '\r')"
  ACTUAL_SHA="$(sha256sum "$BACKUP_FILE" | awk '{print $1}')"
  if [[ -z "$EXPECTED_SHA" || "$EXPECTED_SHA" != "$ACTUAL_SHA" ]]; then
    echo "ERROR: SHA-256 checksum mismatch for $BACKUP_FILE (expected=$EXPECTED_SHA actual=$ACTUAL_SHA)" >&2
    exit 1
  fi
  echo "      SHA-256 OK ($ACTUAL_SHA)"
else
  echo "[1/6] No .sha256 sidecar found; skipping checksum verification."
fi

# 2. Stage & validate SQLite integrity BEFORE touching live data
STAGED_DB="$(mktemp /tmp/sm_office_restore_XXXXXX.db)"
cleanup() {
  rm -f "$STAGED_DB"
}
trap cleanup EXIT
chmod 600 "$STAGED_DB"

echo "[2/6] Staging candidate database and running PRAGMA integrity_check..."
if [[ "$BACKUP_FILE" == *.gz ]]; then
  gzip -t "$BACKUP_FILE"
  gzip -dc "$BACKUP_FILE" > "$STAGED_DB"
else
  cp "$BACKUP_FILE" "$STAGED_DB"
fi

if [[ ! -s "$STAGED_DB" ]]; then
  echo "ERROR: Decompressed database is empty." >&2
  exit 1
fi

if command -v sqlite3 >/dev/null 2>&1; then
  INTEGRITY_RES="$(sqlite3 "$STAGED_DB" "PRAGMA integrity_check;" | tr -d '\r' | xargs)"
  TABLE_CHECK="$(sqlite3 "$STAGED_DB" "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name IN ('app_settings','users');" | tr -d '\r' | xargs)"
else
  command -v docker >/dev/null 2>&1 || { echo "ERROR: Neither sqlite3 nor docker is available to validate DB." >&2; exit 1; }
  CHECK_OUT="$(compose_cmd run --rm -i --no-deps --entrypoint sh api -c '
    tmp="$(mktemp /tmp/restore_check_XXXXXX.db)"
    trap "rm -f \"$tmp\"" EXIT
    cat > "$tmp"
    sqlite3 "$tmp" "PRAGMA integrity_check;"
    sqlite3 "$tmp" "SELECT COUNT(*) FROM sqlite_master WHERE type='\''table'\'' AND name IN ('\''app_settings'\'','\''users'\'');"
  ' < "$STAGED_DB" | tr -d '\r')"
  INTEGRITY_RES="$(printf '%s\n' "$CHECK_OUT" | sed -n '1p' | xargs)"
  TABLE_CHECK="$(printf '%s\n' "$CHECK_OUT" | sed -n '2p' | xargs)"
fi

if [[ "$INTEGRITY_RES" != "ok" ]]; then
  echo "ERROR: Candidate database failed PRAGMA integrity_check: $INTEGRITY_RES" >&2
  exit 1
fi

if [[ "$TABLE_CHECK" != "2" ]]; then
  echo "ERROR: Candidate database is missing expected SM Office Desk schema tables (found $TABLE_CHECK/2)." >&2
  exit 1
fi
echo "      Staged DB verified: integrity=ok, core schema present."

if [[ "$DRY_RUN" -eq 1 ]]; then
  echo "[dry-run] Candidate backup passed checksum, decompression, integrity_check, and schema verification."
  echo "[dry-run] Live container and /data volume were NOT modified."
  exit 0
fi

command -v docker >/dev/null 2>&1 || { echo "ERROR: docker CLI is required for live restore." >&2; exit 1; }

if [[ "$AUTO_YES" -ne 1 ]]; then
  if [[ ! -t 0 ]]; then
    echo "ERROR: Non-interactive shell requires --yes to proceed with live database replacement." >&2
    exit 1
  fi
  echo "WARNING: This will stop 'api', replace live database '$SQLITE_PATH' in volume 'sm_office_data', and restart 'api'."
  read -r -p "Type RESTORE to continue: " CONFIRM
  if [[ "$CONFIRM" != "RESTORE" ]]; then
    echo "Aborted by user."
    exit 1
  fi
fi

# 3. Stop api cleanly so WAL/SHM handles close
echo "[3/6] Stopping 'api' container gracefully..."
compose_cmd stop api

# 4. Snapshot existing DB/WAL/SHM on host before overwriting
UTC_STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
PRE_RESTORE_DIR="${BACKUP_DIR}/pre_restore_${UTC_STAMP}"
mkdir -p "$PRE_RESTORE_DIR"
echo "[4/6] Snapshotting existing live SQLite files (if present) to $PRE_RESTORE_DIR..."
compose_cmd run --rm -T --no-deps --user 0:0 --entrypoint sh api -c "
  db=\"$SQLITE_PATH\"
  dir=\$(dirname \"\$db\")
  base=\$(basename \"\$db\")
  if [ -e \"\$db\" ] || [ -e \"\${db}-wal\" ] || [ -e \"\${db}-shm\" ]; then
    tar -C \"\$dir\" -cf - \$(for f in \"\$base\" \"\${base}-wal\" \"\${base}-shm\"; do [ -e \"\$dir/\$f\" ] && printf '%s ' \"\$f\"; done)
  fi
" > "${PRE_RESTORE_DIR}/existing_db_bundle.tar" || true

if [[ -s "${PRE_RESTORE_DIR}/existing_db_bundle.tar" ]]; then
  gzip -9 -f "${PRE_RESTORE_DIR}/existing_db_bundle.tar"
  chmod 600 "${PRE_RESTORE_DIR}/existing_db_bundle.tar.gz"
  echo "      Saved pre-restore snapshot: ${PRE_RESTORE_DIR}/existing_db_bundle.tar.gz"
else
  rm -f "${PRE_RESTORE_DIR}/existing_db_bundle.tar"
  rmdir "$PRE_RESTORE_DIR" 2>/dev/null || true
  echo "      No existing live database files found; proceeding."
fi

# 5. Replace /data/office.db atomically, delete stale WAL/SHM, enforce 1000:1000 ownership
echo "[5/6] Writing restored database and removing stale WAL/SHM..."
compose_cmd run --rm -i --no-deps --user 0:0 --entrypoint sh api -c "
  set -e
  db=\"$SQLITE_PATH\"
  dir=\$(dirname \"\$db\")
  mkdir -p \"\$dir\"
  tmp=\"\${db}.restore_tmp\"
  cat > \"\$tmp\"
  rm -f \"\${db}-wal\" \"\${db}-shm\"
  mv -f \"\$tmp\" \"\$db\"
  chown 1000:1000 \"\$dir\" \"\$db\"
  chmod 640 \"\$db\"
  res=\$(sqlite3 \"\$db\" 'PRAGMA integrity_check;' | tr -d '\r' | xargs)
  [ \"\$res\" = 'ok' ]
" < "$STAGED_DB"

# 6. Restart api and poll /api/health
echo "[6/6] Starting 'api' container and polling /api/health..."
compose_cmd up -d api

DEADLINE=$(( $(date +%s) + 45 ))
while true; do
  if compose_cmd exec -T api curl -fsS "http://127.0.0.1:3000/api/health" >/dev/null 2>&1; then
    echo "Restore complete and /api/health is healthy!"
    exit 0
  fi
  if [[ $(date +%s) -ge "$DEADLINE" ]]; then
    echo "ERROR: 'api' failed to pass /api/health within 45s after restore. Check 'docker compose logs api'." >&2
    exit 1
  fi
  sleep 2
done

#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
DEPLOY_DIR="$(cd -- "${SCRIPT_DIR}/.." && pwd)"
COMPOSE_FILE="${DEPLOY_DIR}/docker-compose.yml"
ENV_FILE="${DEPLOY_DIR}/.env.production"
DRY_RUN=0
CLI_BACKUP_DIR=""

usage() {
  cat <<'EOF'
Usage: backup-sqlite.sh [OPTIONS]

Performs a safe, live online SQLite WAL backup using `sqlite3 ... ".backup ..."`
inside the running `api` container, verifies `PRAGMA integrity_check;`, compresses
with `gzip -9`, writes a `.sha256` checksum, rotates local backups, and optionally
uploads to a SEPARATE Cloudflare R2 backup bucket (`BACKUP_R2_BUCKET_NAME`).

Options:
  --env-file PATH     Path to production env file (default: deploy/.env.production)
  --backup-dir PATH   Override BACKUP_DIR from env file (default: /var/backups/sm-office-desk)
  --dry-run           Validate configuration, R2 bucket separation guard, and print plan
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
    --env-file)
      [[ $# -ge 2 ]] || { echo "ERROR: --env-file requires a path" >&2; exit 1; }
      ENV_FILE="$2"
      shift 2
      ;;
    --backup-dir)
      [[ $# -ge 2 ]] || { echo "ERROR: --backup-dir requires a path" >&2; exit 1; }
      CLI_BACKUP_DIR="$2"
      shift 2
      ;;
    --dry-run)
      DRY_RUN=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "ERROR: Unknown option: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
done

load_env_file "$ENV_FILE"

SQLITE_PATH="$(trim "${SQLITE_PATH:-/data/office.db}")"
BACKUP_DIR="$(trim "${CLI_BACKUP_DIR:-${BACKUP_DIR:-/var/backups/sm-office-desk}}")"
BACKUP_RETENTION_DAYS="$(trim "${BACKUP_RETENTION_DAYS:-14}")"
STORAGE_DRIVER="$(trim "${STORAGE_DRIVER:-r2}")"
R2_BUCKET_NAME="$(trim "${R2_BUCKET_NAME:-}")"
R2_ACCOUNT_ID="$(trim "${R2_ACCOUNT_ID:-}")"
BACKUP_R2_BUCKET_NAME="$(trim "${BACKUP_R2_BUCKET_NAME:-}")"
BACKUP_R2_ENDPOINT="$(trim "${BACKUP_R2_ENDPOINT:-}")"
BACKUP_R2_ACCESS_KEY_ID="$(trim "${BACKUP_R2_ACCESS_KEY_ID:-}")"
BACKUP_R2_SECRET_ACCESS_KEY="$(trim "${BACKUP_R2_SECRET_ACCESS_KEY:-}")"

EFFECTIVE_R2_BUCKET="$R2_BUCKET_NAME"
if [[ "$STORAGE_DRIVER" == "r2" && -z "$EFFECTIVE_R2_BUCKET" ]]; then
  # Matches apps/server/src/config.ts default R2_BUCKET_NAME when omitted
  EFFECTIVE_R2_BUCKET="sm-office-desk-screenshots"
fi

if [[ -z "$BACKUP_R2_ENDPOINT" && -n "$R2_ACCOUNT_ID" ]]; then
  BACKUP_R2_ENDPOINT="https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com"
fi

if ! [[ "$BACKUP_RETENTION_DAYS" =~ ^[1-9][0-9]*$ ]]; then
  echo "ERROR: BACKUP_RETENTION_DAYS must be a positive integer (got: '$BACKUP_RETENTION_DAYS')" >&2
  exit 1
fi

# CRITICAL SAFETY GUARD:
# `cleanupOrphanFiles` in apps/server/src/jobs/maintenance.ts deletes objects >24h old
# in R2_BUCKET_NAME that are not referenced in `screenshots.storage_key`.
if [[ -n "$BACKUP_R2_BUCKET_NAME" && -n "$EFFECTIVE_R2_BUCKET" && "$BACKUP_R2_BUCKET_NAME" == "$EFFECTIVE_R2_BUCKET" ]]; then
  echo "ERROR: Refusing backup! BACKUP_R2_BUCKET_NAME ('$BACKUP_R2_BUCKET_NAME') MUST NOT equal screenshot bucket '$EFFECTIVE_R2_BUCKET' (R2_BUCKET_NAME)." >&2
  echo "       Weekly cleanupOrphanFiles deletes objects >24h old in R2_BUCKET_NAME not present in screenshots.storage_key." >&2
  exit 1
fi

UPLOAD_TOOL=""
if [[ -n "$BACKUP_R2_BUCKET_NAME" ]]; then
  if [[ -z "$BACKUP_R2_ENDPOINT" || -z "$BACKUP_R2_ACCESS_KEY_ID" || -z "$BACKUP_R2_SECRET_ACCESS_KEY" ]]; then
    echo "ERROR: Off-site R2 backup requires BACKUP_R2_ENDPOINT, BACKUP_R2_ACCESS_KEY_ID, and BACKUP_R2_SECRET_ACCESS_KEY." >&2
    exit 1
  fi
  if command -v aws >/dev/null 2>&1; then
    UPLOAD_TOOL="aws"
  elif command -v rclone >/dev/null 2>&1; then
    UPLOAD_TOOL="rclone"
  elif [[ "$DRY_RUN" -eq 0 ]]; then
    echo "ERROR: BACKUP_R2_BUCKET_NAME is set, but neither 'aws' nor 'rclone' CLI is installed." >&2
    exit 1
  else
    UPLOAD_TOOL="missing (install awscli or rclone)"
  fi
fi

UTC_STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
BASENAME_GZ="office_${UTC_STAMP}.db.gz"
FINAL_GZ="${BACKUP_DIR}/${BASENAME_GZ}"

if [[ "$DRY_RUN" -eq 1 ]]; then
  echo "[dry-run] Env file:            $ENV_FILE ($( [[ -f "$ENV_FILE" ]] && echo present || echo missing ))"
  echo "[dry-run] Compose file:        $COMPOSE_FILE"
  echo "[dry-run] Container SQLite DB: $SQLITE_PATH"
  echo "[dry-run] Host backup dir:     $BACKUP_DIR"
  echo "[dry-run] Planned archive:     $FINAL_GZ (+ .sha256)"
  echo "[dry-run] Retention days:      $BACKUP_RETENTION_DAYS"
  if [[ -n "$BACKUP_R2_BUCKET_NAME" ]]; then
    echo "[dry-run] Off-site R2 bucket:  $BACKUP_R2_BUCKET_NAME (distinct from screenshot bucket '${EFFECTIVE_R2_BUCKET}')"
    echo "[dry-run] Off-site endpoint:   $BACKUP_R2_ENDPOINT"
    echo "[dry-run] Upload CLI tool:     $UPLOAD_TOOL"
  else
    echo "[dry-run] Off-site R2 bucket:  disabled (BACKUP_R2_BUCKET_NAME unset)"
  fi
  exit 0
fi

for req in docker gzip sha256sum; do
  command -v "$req" >/dev/null 2>&1 || { echo "ERROR: Required tool '$req' not found." >&2; exit 1; }
done

mkdir -p "$BACKUP_DIR"

CONTAINER_TMP="/tmp/office_backup_${UTC_STAMP}_$$.db"
LOCAL_TMP_DB="$(mktemp "${BACKUP_DIR}/.office_${UTC_STAMP}_XXXXXX.db")"
LOCAL_TMP_GZ="${FINAL_GZ}.tmp"
CONTAINER_TOUCHED=0

cleanup() {
  rm -f "$LOCAL_TMP_DB" "$LOCAL_TMP_GZ"
  if [[ "$CONTAINER_TOUCHED" -eq 1 ]]; then
    compose_cmd exec -T api rm -f "$CONTAINER_TMP" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

if ! compose_cmd ps --status running --services | grep -qx "api"; then
  echo "ERROR: 'api' container is not running. Start stack before running live backup." >&2
  exit 1
fi

echo "[$(date -u +%FT%TZ)] Starting online SQLite WAL backup from $SQLITE_PATH..."
CONTAINER_TOUCHED=1
compose_cmd exec -T api sqlite3 "$SQLITE_PATH" ".backup '$CONTAINER_TMP'"

INTEGRITY_RESULT="$(compose_cmd exec -T api sqlite3 "$CONTAINER_TMP" "PRAGMA integrity_check;" | tr -d '\r' | xargs)"
if [[ "$INTEGRITY_RESULT" != "ok" ]]; then
  echo "ERROR: Backup PRAGMA integrity_check failed inside container: $INTEGRITY_RESULT" >&2
  exit 1
fi

CONTAINER_SHA="$(compose_cmd exec -T api sha256sum "$CONTAINER_TMP" | awk '{print $1}' | tr -d '\r')"
compose_cmd exec -T api cat "$CONTAINER_TMP" > "$LOCAL_TMP_DB"
compose_cmd exec -T api rm -f "$CONTAINER_TMP"
CONTAINER_TOUCHED=0

HOST_SHA="$(sha256sum "$LOCAL_TMP_DB" | awk '{print $1}')"
if [[ -z "$CONTAINER_SHA" || "$CONTAINER_SHA" != "$HOST_SHA" ]]; then
  echo "ERROR: Transfer checksum mismatch (container=$CONTAINER_SHA host=$HOST_SHA)" >&2
  exit 1
fi

gzip -9 -c "$LOCAL_TMP_DB" > "$LOCAL_TMP_GZ"
gzip -t "$LOCAL_TMP_GZ"
mv -f "$LOCAL_TMP_GZ" "$FINAL_GZ"
rm -f "$LOCAL_TMP_DB"

(
  cd "$BACKUP_DIR"
  sha256sum "$BASENAME_GZ" > "${BASENAME_GZ}.sha256"
)
chmod 600 "$FINAL_GZ" "${FINAL_GZ}.sha256"

# Rotate local archives older than BACKUP_RETENTION_DAYS
find "$BACKUP_DIR" -maxdepth 1 -type f \
  \( -name 'office_*.db.gz' -o -name 'office_*.db.gz.sha256' \) \
  -mtime "+${BACKUP_RETENTION_DAYS}" -delete

echo "[$(date -u +%FT%TZ)] Local backup verified and saved: $FINAL_GZ"

if [[ -n "$BACKUP_R2_BUCKET_NAME" ]]; then
  echo "[$(date -u +%FT%TZ)] Uploading backup to separate private bucket '$BACKUP_R2_BUCKET_NAME' via $UPLOAD_TOOL..."
  if [[ "$UPLOAD_TOOL" == "aws" ]]; then
    AWS_ACCESS_KEY_ID="$BACKUP_R2_ACCESS_KEY_ID" \
    AWS_SECRET_ACCESS_KEY="$BACKUP_R2_SECRET_ACCESS_KEY" \
    AWS_DEFAULT_REGION="auto" \
      aws s3 cp "$FINAL_GZ" "s3://${BACKUP_R2_BUCKET_NAME}/sqlite/${BASENAME_GZ}" \
        --endpoint-url "$BACKUP_R2_ENDPOINT" \
        --only-show-errors
    AWS_ACCESS_KEY_ID="$BACKUP_R2_ACCESS_KEY_ID" \
    AWS_SECRET_ACCESS_KEY="$BACKUP_R2_SECRET_ACCESS_KEY" \
    AWS_DEFAULT_REGION="auto" \
      aws s3 cp "${FINAL_GZ}.sha256" "s3://${BACKUP_R2_BUCKET_NAME}/sqlite/${BASENAME_GZ}.sha256" \
        --endpoint-url "$BACKUP_R2_ENDPOINT" \
        --only-show-errors
  elif [[ "$UPLOAD_TOOL" == "rclone" ]]; then
    RCLONE_CONFIG_R2BACKUP_TYPE="s3" \
    RCLONE_CONFIG_R2BACKUP_PROVIDER="Cloudflare" \
    RCLONE_CONFIG_R2BACKUP_ACCESS_KEY_ID="$BACKUP_R2_ACCESS_KEY_ID" \
    RCLONE_CONFIG_R2BACKUP_SECRET_ACCESS_KEY="$BACKUP_R2_SECRET_ACCESS_KEY" \
    RCLONE_CONFIG_R2BACKUP_ENDPOINT="$BACKUP_R2_ENDPOINT" \
    RCLONE_CONFIG_R2BACKUP_ACL="private" \
      rclone copyto "$FINAL_GZ" "r2backup:${BACKUP_R2_BUCKET_NAME}/sqlite/${BASENAME_GZ}"
    RCLONE_CONFIG_R2BACKUP_TYPE="s3" \
    RCLONE_CONFIG_R2BACKUP_PROVIDER="Cloudflare" \
    RCLONE_CONFIG_R2BACKUP_ACCESS_KEY_ID="$BACKUP_R2_ACCESS_KEY_ID" \
    RCLONE_CONFIG_R2BACKUP_SECRET_ACCESS_KEY="$BACKUP_R2_SECRET_ACCESS_KEY" \
    RCLONE_CONFIG_R2BACKUP_ENDPOINT="$BACKUP_R2_ENDPOINT" \
    RCLONE_CONFIG_R2BACKUP_ACL="private" \
      rclone copyto "${FINAL_GZ}.sha256" "r2backup:${BACKUP_R2_BUCKET_NAME}/sqlite/${BASENAME_GZ}.sha256"
  fi
  echo "[$(date -u +%FT%TZ)] Off-site backup upload complete."
fi

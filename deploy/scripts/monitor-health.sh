#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
DEPLOY_DIR="$(cd -- "${SCRIPT_DIR}/.." && pwd)"
COMPOSE_FILE="${DEPLOY_DIR}/docker-compose.yml"
ENV_FILE="${DEPLOY_DIR}/.env.production"
CLI_URL=""
CLI_DISK_WARN=""
DRY_RUN=0
TEST_ALERT=0

usage() {
  cat <<'EOF'
Usage: monitor-health.sh [OPTIONS]

Checks SM Office Desk production stack health:
  1. Host root filesystem disk usage (< DISK_WARN_PERCENT, default 80%)
  2. Docker Compose `api` and `caddy` running & healthy status
  3. Internal `http://127.0.0.1:3000/api/health` (DB + storage driver check)
  4. External Caddy HTTPS `/api/health` check (when SITE_ADDRESS is a real domain or --url is set)
  5. SQLite DB / WAL / SHM file sizes inside `/data` (warns if WAL > 64 MiB)
  6. Optional JSON webhook notification via `ALERT_WEBHOOK_URL` on failure

Options:
  --env-file PATH     Path to production env file (default: deploy/.env.production)
  --url URL           Explicit external health endpoint URL to check
  --warn-disk PCT     Disk usage alert threshold percent (default: 80)
  --test-alert        Send a test notification to ALERT_WEBHOOK_URL and exit
  --dry-run           Show resolved check targets and host disk usage without failing on stopped containers
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

json_escape() {
  local s="$1"
  s="${s//\\/\\\\}"
  s="${s//\"/\\\"}"
  s="${s//$'\n'/\\n}"
  s="${s//$'\r'/}"
  printf '%s' "$s"
}

send_webhook_alert() {
  local message="$1"
  [[ -n "$ALERT_WEBHOOK_URL" ]] || return 0
  local escaped
  escaped="$(json_escape "$message")"
  local payload
  payload="{\"text\":\"${escaped}\",\"content\":\"${escaped}\"}"
  curl -fsS -m 10 -H "Content-Type: application/json" -d "$payload" "$ALERT_WEBHOOK_URL" >/dev/null || \
    echo "WARNING: Failed to deliver alert to ALERT_WEBHOOK_URL" >&2
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --env-file)
      [[ $# -ge 2 ]] || { echo "ERROR: --env-file requires a path" >&2; exit 1; }
      ENV_FILE="$2"
      shift 2
      ;;
    --url)
      [[ $# -ge 2 ]] || { echo "ERROR: --url requires a URL" >&2; exit 1; }
      CLI_URL="$2"
      shift 2
      ;;
    --warn-disk)
      [[ $# -ge 2 ]] || { echo "ERROR: --warn-disk requires a percentage" >&2; exit 1; }
      CLI_DISK_WARN="$2"
      shift 2
      ;;
    --test-alert)
      TEST_ALERT=1
      shift
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

SITE_ADDRESS="$(trim "${SITE_ADDRESS:-localhost}")"
SQLITE_PATH="$(trim "${SQLITE_PATH:-/data/office.db}")"
DISK_WARN_PERCENT="$(trim "${CLI_DISK_WARN:-${DISK_WARN_PERCENT:-80}}")"
ALERT_WEBHOOK_URL="$(trim "${ALERT_WEBHOOK_URL:-}")"

if ! [[ "$DISK_WARN_PERCENT" =~ ^[1-9][0-9]*$ ]] || (( DISK_WARN_PERCENT > 99 )); then
  echo "ERROR: DISK_WARN_PERCENT must be 1..99 (got: '$DISK_WARN_PERCENT')" >&2
  exit 1
fi

EXTERNAL_URL="$CLI_URL"
if [[ -z "$EXTERNAL_URL" && -n "$SITE_ADDRESS" ]]; then
  trimmed_site="${SITE_ADDRESS%/}"
  if [[ "$trimmed_site" =~ ^https?:// ]]; then
    host_part="${trimmed_site#http://}"
    host_part="${host_part#https://}"
    host_part="${host_part%%/*}"
    if [[ "$host_part" != "localhost" && "$host_part" != localhost:* ]]; then
      EXTERNAL_URL="${trimmed_site}/api/health"
    fi
  elif [[ "$trimmed_site" != "localhost" && "$trimmed_site" != localhost:* && "$trimmed_site" != :* ]]; then
    EXTERNAL_URL="https://${trimmed_site}/api/health"
  fi
fi

if [[ "$TEST_ALERT" -eq 1 ]]; then
  if [[ -z "$ALERT_WEBHOOK_URL" ]]; then
    echo "ERROR: ALERT_WEBHOOK_URL is empty; nothing to test." >&2
    exit 1
  fi
  send_webhook_alert "[SM Office Desk] Test alert from $(hostname -f 2>/dev/null || hostname) at $(date -u +%FT%TZ)"
  echo "Test alert sent successfully."
  exit 0
fi

ROOT_DISK_PCT="$(df -P / | awk 'NR==2 {gsub("%","",$5); print $5}')"
ROOT_DISK_AVAIL="$(df -Ph / | awk 'NR==2 {print $4}')"

if [[ "$DRY_RUN" -eq 1 ]]; then
  echo "[dry-run] Env file:           $ENV_FILE ($( [[ -f "$ENV_FILE" ]] && echo present || echo missing ))"
  echo "[dry-run] Compose file:       $COMPOSE_FILE"
  echo "[dry-run] Host '/' usage:     ${ROOT_DISK_PCT}% (warn >= ${DISK_WARN_PERCENT}%, avail ${ROOT_DISK_AVAIL})"
  echo "[dry-run] Internal health:    api container -> http://127.0.0.1:3000/api/health"
  echo "[dry-run] External health:    ${EXTERNAL_URL:-skipped (SITE_ADDRESS=$SITE_ADDRESS)}"
  echo "[dry-run] SQLite WAL inspect: $SQLITE_PATH (+ -wal / -shm)"
  echo "[dry-run] Webhook alerting:   $( [[ -n "$ALERT_WEBHOOK_URL" ]] && echo configured || echo disabled )"
  exit 0
fi

FAILURES=()

# 1. Host disk check
if (( ROOT_DISK_PCT >= DISK_WARN_PERCENT )); then
  FAILURES+=("Host disk usage critical: ${ROOT_DISK_PCT}% >= ${DISK_WARN_PERCENT}% (avail: ${ROOT_DISK_AVAIL})")
fi

# 2. Container running checks
RUNNING_SERVICES=""
if command -v docker >/dev/null 2>&1; then
  RUNNING_SERVICES="$(compose_cmd ps --status running --services 2>/dev/null || true)"
else
  FAILURES+=("Docker CLI not found on host")
fi

API_RUNNING=0
CADDY_RUNNING=0
if printf '%s\n' "$RUNNING_SERVICES" | grep -qx "api"; then
  API_RUNNING=1
else
  FAILURES+=("Container 'api' is not running")
fi
if printf '%s\n' "$RUNNING_SERVICES" | grep -qx "caddy"; then
  CADDY_RUNNING=1
else
  FAILURES+=("Container 'caddy' is not running")
fi

# 3. Internal API healthcheck & SQLite WAL sizes
INTERNAL_HEALTH_JSON=""
DB_SIZES_REPORT="unavailable"
if [[ "$API_RUNNING" -eq 1 ]]; then
  if INTERNAL_HEALTH_JSON="$(compose_cmd exec -T api curl -fsS -m 5 http://127.0.0.1:3000/api/health 2>/dev/null)"; then
    if ! printf '%s' "$INTERNAL_HEALTH_JSON" | grep -Eq '"status"[[:space:]]*:[[:space:]]*"ok"'; then
      FAILURES+=("Internal /api/health returned unexpected payload: $INTERNAL_HEALTH_JSON")
    fi
  else
    FAILURES+=("Internal /api/health check failed inside 'api' container")
  fi

  DB_SIZES_OUT="$(compose_cmd exec -T api sh -c "
    for f in \"$SQLITE_PATH\" \"${SQLITE_PATH}-wal\" \"${SQLITE_PATH}-shm\"; do
      if [ -f \"\$f\" ]; then
        sz=\$(stat -c '%s' \"\$f\" 2>/dev/null || wc -c < \"\$f\")
        printf '%s=%s\n' \"\$(basename \"\$f\")\" \"\$sz\"
      else
        printf '%s=0\n' \"\$(basename \"\$f\")\"
      fi
    done
  " 2>/dev/null | tr -d '\r' || true)"

  if [[ -n "$DB_SIZES_OUT" ]]; then
    DB_SIZES_REPORT="$(printf '%s' "$DB_SIZES_OUT" | paste -sd ', ' -)"
    WAL_BYTES="$(printf '%s\n' "$DB_SIZES_OUT" | awk -F= '/-wal=/{print $2; exit}')"
    WAL_BYTES="${WAL_BYTES:-0}"
    if [[ "$WAL_BYTES" =~ ^[0-9]+$ ]] && (( WAL_BYTES > 67108864 )); then
      FAILURES+=("SQLite WAL file unusually large (${WAL_BYTES} bytes > 64 MiB); check daily wal_checkpoint")
    fi
  fi
fi

# 4. External HTTPS/HTTP health check
if [[ -n "$EXTERNAL_URL" ]]; then
  if ! EXT_RES="$(curl -fsS -m 10 "$EXTERNAL_URL" 2>/dev/null)"; then
    FAILURES+=("External health probe failed: $EXTERNAL_URL")
  elif ! printf '%s' "$EXT_RES" | grep -Eq '"status"[[:space:]]*:[[:space:]]*"ok"'; then
    FAILURES+=("External health endpoint unexpected body from $EXTERNAL_URL")
  fi
fi

HOST_LABEL="$(hostname -f 2>/dev/null || hostname)"
NOW_UTC="$(date -u +%FT%TZ)"

if [[ "${#FAILURES[@]}" -gt 0 ]]; then
  SUMMARY="ALERT [SM Office Desk | ${HOST_LABEL} | ${NOW_UTC}]: $(IFS='; '; echo "${FAILURES[*]}")"
  echo "$SUMMARY" >&2
  send_webhook_alert "$SUMMARY"
  exit 1
fi

echo "OK [SM Office Desk | ${HOST_LABEL} | ${NOW_UTC}] disk=${ROOT_DISK_PCT}% (avail ${ROOT_DISK_AVAIL}) | api=up | caddy=up | sqlite(${DB_SIZES_REPORT}) | health=${INTERNAL_HEALTH_JSON}"

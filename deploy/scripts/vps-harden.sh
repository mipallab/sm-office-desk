#!/usr/bin/env bash
set -euo pipefail

DRY_RUN=0
SWAP_SIZE="2G"
SSH_PORT="22"
INSTALL_DOCKER=0
DISABLE_SSH_PASSWORD_AUTH=0

usage() {
  cat <<'EOF'
Usage: vps-harden.sh [OPTIONS]

Idempotent Debian/Ubuntu baseline VPS hardening for SM Office Desk ($0-$6/mo, 1-2 GB RAM):
  - Creates a 1-2 GB swapfile (if missing) + tunes vm.swappiness=10
  - Configures UFW firewall (allow SSH, 80/tcp, 443/tcp, 443/udp; block port 3000 publicly)
  - Configures Fail2Ban sshd jail
  - Enables unattended security upgrades
  - Checks Docker & Docker Compose v2 (with install option/guidance)
  - Checks SSH key auth configuration

Options:
  --swap-size SIZE             Swapfile size if no swap exists (default: 2G; e.g. 1G or 2G)
  --ssh-port PORT              SSH TCP port for UFW & Fail2Ban (default: 22)
  --install-docker             Install Docker Engine + Compose v2 plugin via get.docker.com if missing
  --disable-ssh-password-auth  Disable SSH password login (only if authorized_keys exists)
  --dry-run                    Print planned actions without modifying the host
  -h, --help                   Show this help message and exit
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --swap-size)
      [[ $# -ge 2 ]] || { echo "ERROR: --swap-size requires a value" >&2; exit 1; }
      SWAP_SIZE="$2"
      shift 2
      ;;
    --ssh-port)
      [[ $# -ge 2 ]] || { echo "ERROR: --ssh-port requires a port number" >&2; exit 1; }
      SSH_PORT="$2"
      shift 2
      ;;
    --install-docker)
      INSTALL_DOCKER=1
      shift
      ;;
    --disable-ssh-password-auth)
      DISABLE_SSH_PASSWORD_AUTH=1
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

if ! [[ "$SWAP_SIZE" =~ ^[1-9][0-9]*[MG]$ ]]; then
  echo "ERROR: --swap-size must look like 1G, 2G, or 1024M (got: '$SWAP_SIZE')" >&2
  exit 1
fi

if ! [[ "$SSH_PORT" =~ ^[1-9][0-9]*$ ]] || (( SSH_PORT < 1 || SSH_PORT > 65535 )); then
  echo "ERROR: --ssh-port must be 1..65535 (got: '$SSH_PORT')" >&2
  exit 1
fi

if [[ "$DRY_RUN" -eq 1 ]]; then
  echo "[dry-run] Would validate Debian/Ubuntu apt-get environment and root privileges."
  echo "[dry-run] Would ensure swapfile ($SWAP_SIZE) at /swapfile if no active swap, and set vm.swappiness=10."
  echo "[dry-run] Would configure UFW: deny incoming, allow outgoing, allow ${SSH_PORT}/tcp, 80/tcp, 443/tcp, 443/udp."
  echo "[dry-run] Would configure Fail2Ban sshd jail at /etc/fail2ban/jail.d/sm-office-sshd.local."
  echo "[dry-run] Would enable unattended-upgrades via /etc/apt/apt.conf.d/20auto-upgrades."
  if [[ "$DISABLE_SSH_PASSWORD_AUTH" -eq 1 ]]; then
    echo "[dry-run] Would disable SSH PasswordAuthentication after verifying authorized_keys."
  else
    echo "[dry-run] Would inspect SSH PasswordAuthentication status and advise on key-only auth."
  fi
  if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
    echo "[dry-run] Docker & Docker Compose v2 already detected."
  elif [[ "$INSTALL_DOCKER" -eq 1 ]]; then
    echo "[dry-run] Would install Docker Engine + Docker Compose v2 plugin."
  else
    echo "[dry-run] Docker or Docker Compose v2 missing; would print installation commands."
  fi
  exit 0
fi

if [[ "$EUID" -ne 0 ]]; then
  echo "ERROR: vps-harden.sh must be run as root (e.g. sudo bash deploy/scripts/vps-harden.sh)." >&2
  exit 1
fi

if ! command -v apt-get >/dev/null 2>&1; then
  echo "ERROR: This script targets Debian/Ubuntu hosts with apt-get." >&2
  exit 1
fi

export DEBIAN_FRONTEND=noninteractive

echo "[1/6] Updating apt package index and installing ufw, fail2ban, unattended-upgrades..."
apt-get update -y
apt-get install -y --no-install-recommends \
  ufw fail2ban python3-systemd unattended-upgrades apt-listchanges ca-certificates curl gnupg

# 2. Swapfile (essential for 1 GB RAM VPS safety)
echo "[2/6] Checking swap & sysctl vm.swappiness=10..."
if [[ -z "$(swapon --show --noheadings)" ]]; then
  if [[ ! -f /swapfile ]]; then
    echo "      Creating ${SWAP_SIZE} /swapfile..."
    if ! fallocate -l "$SWAP_SIZE" /swapfile 2>/dev/null; then
      case "$SWAP_SIZE" in
        *G) count_mb=$(( ${SWAP_SIZE%G} * 1024 )) ;;
        *M) count_mb=${SWAP_SIZE%M} ;;
      esac
      dd if=/dev/zero of=/swapfile bs=1M count="$count_mb" status=progress
    fi
    chmod 600 /swapfile
    mkswap /swapfile
  else
    chmod 600 /swapfile
  fi
  swapon /swapfile
  if ! grep -qE '^[[:space:]]*/swapfile[[:space:]]' /etc/fstab; then
    printf '/swapfile none swap sw 0 0\n' >> /etc/fstab
  fi
else
  echo "      Active swap already configured."
fi

cat <<'EOF' > /etc/sysctl.d/99-sm-office.conf
vm.swappiness=10
vm.vfs_cache_pressure=50
EOF
sysctl -p /etc/sysctl.d/99-sm-office.conf >/dev/null

# 3. UFW Firewall
echo "[3/6] Configuring UFW firewall (SSH=${SSH_PORT}, HTTP=80, HTTPS=443)..."
ufw default deny incoming
ufw default allow outgoing
ufw allow "${SSH_PORT}/tcp" comment 'SSH'
ufw allow 80/tcp comment 'Caddy HTTP / ACME'
ufw allow 443/tcp comment 'Caddy HTTPS / WSS'
ufw allow 443/udp comment 'Caddy HTTP3'
ufw --force enable
ufw status verbose

# 4. Fail2Ban SSH Jail
echo "[4/6] Configuring Fail2Ban sshd jail..."
cat <<EOF > /etc/fail2ban/jail.d/sm-office-sshd.local
[sshd]
enabled = true
port = ${SSH_PORT}
backend = systemd
maxretry = 5
findtime = 10m
bantime = 1h
EOF
systemctl enable --now fail2ban
systemctl restart fail2ban

# 5. Unattended Security Upgrades
echo "[5/6] Enabling unattended security upgrades..."
cat <<'EOF' > /etc/apt/apt.conf.d/20auto-upgrades
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
APT::Periodic::AutocleanInterval "7";
EOF
systemctl enable --now unattended-upgrades >/dev/null 2>&1 || true

# 6. SSH Key-Only Check & Docker Check
echo "[6/6] Checking SSH password auth and Docker Engine + Compose v2..."
TARGET_USER="${SUDO_USER:-root}"
TARGET_HOME="$(getent passwd "$TARGET_USER" | cut -d: -f6 || echo /root)"
AUTH_KEYS="${TARGET_HOME}/.ssh/authorized_keys"

if [[ "$DISABLE_SSH_PASSWORD_AUTH" -eq 1 ]]; then
  if [[ -s "$AUTH_KEYS" ]]; then
    mkdir -p /etc/ssh/sshd_config.d
    cat <<'EOF' > /etc/ssh/sshd_config.d/99-sm-office-hardening.conf
PasswordAuthentication no
KbdInteractiveAuthentication no
PubkeyAuthentication yes
PermitRootLogin prohibit-password
EOF
    sshd -t
    systemctl reload ssh 2>/dev/null || systemctl reload sshd
    echo "      SSH PasswordAuthentication disabled (verified keys in $AUTH_KEYS)."
  else
    echo "WARNING: Refusing to disable SSH PasswordAuthentication because '$AUTH_KEYS' is missing or empty." >&2
  fi
else
  echo "      SSH advisory: verify SSH key login works, then re-run with --disable-ssh-password-auth"
  echo "      (or set 'PasswordAuthentication no' in /etc/ssh/sshd_config.d/99-sm-office-hardening.conf)."
fi

if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
  echo "      Docker ready: $(docker --version) | $(docker compose version)"
elif [[ "$INSTALL_DOCKER" -eq 1 ]]; then
  echo "      Installing Docker Engine + Docker Compose v2 via official convenience script..."
  curl -fsSL https://get.docker.com | sh
  systemctl enable --now docker
  if [[ -n "${SUDO_USER:-}" && "$SUDO_USER" != "root" ]]; then
    usermod -aG docker "$SUDO_USER" || true
    echo "      Added '$SUDO_USER' to 'docker' group (re-login to apply)."
  fi
else
  cat <<'EOF'
      Docker or Docker Compose v2 is NOT installed yet.
      Install via official repository or re-run with `--install-docker`:
        curl -fsSL https://get.docker.com | sudo sh
        sudo systemctl enable --now docker
EOF
fi

echo "VPS hardening complete."

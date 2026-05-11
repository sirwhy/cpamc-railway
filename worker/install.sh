#!/usr/bin/env bash
# Hermes Worker — bare-metal install script for an AWS EC2 GPU instance
# running Ubuntu 22.04. Idempotent: safe to re-run.
#
# Usage:
#     sudo bash worker/install.sh
#
# What it does:
#   1. Installs CUDA 12.1 NVIDIA driver (if not already present)
#   2. Installs system packages (python3.11, ffmpeg, etc.)
#   3. Creates the `hermes` user + /var/lib/hermes data dir
#   4. Creates a Python venv at /opt/hermes/venv with all ML deps
#   5. Installs systemd unit (hermes-worker.service)
#   6. Installs Caddy + Caddyfile (provides automatic HTTPS)
#
# After running this script you MUST:
#   - edit /etc/hermes/hermes.env (filled from .env.example)
#   - edit /etc/caddy/Caddyfile (set your domain)
#   - run: sudo systemctl reload caddy && sudo systemctl restart hermes-worker

set -euo pipefail

if [[ "${EUID}" -ne 0 ]]; then
    echo "Please run as root: sudo bash $0" >&2
    exit 1
fi

SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"

# ------------------------------------------------------------------
# 1. System packages
# ------------------------------------------------------------------
export DEBIAN_FRONTEND=noninteractive

apt-get update
apt-get install -y --no-install-recommends \
    software-properties-common ca-certificates curl gnupg lsb-release \
    build-essential git ffmpeg libsndfile1 sox libsox-fmt-all \
    python3.11 python3.11-venv python3.11-dev

# ------------------------------------------------------------------
# 2. NVIDIA driver (optional, skip if already loaded)
# ------------------------------------------------------------------
if ! command -v nvidia-smi >/dev/null 2>&1; then
    echo "[install.sh] nvidia-smi not found; installing 535 driver"
    ubuntu-drivers autoinstall || true
    echo "[install.sh] NOTE: reboot may be required for the driver to load."
fi

# ------------------------------------------------------------------
# 3. hermes user + data dir
# ------------------------------------------------------------------
if ! id hermes >/dev/null 2>&1; then
    useradd --system --create-home --home-dir /var/lib/hermes --shell /usr/sbin/nologin hermes
fi
mkdir -p /var/lib/hermes /etc/hermes /opt/hermes
chown -R hermes:hermes /var/lib/hermes

# ------------------------------------------------------------------
# 4. Python venv + ML deps
# ------------------------------------------------------------------
VENV=/opt/hermes/venv
if [[ ! -d "${VENV}" ]]; then
    python3.11 -m venv "${VENV}"
fi
"${VENV}/bin/pip" install --upgrade pip setuptools wheel

# Server deps
"${VENV}/bin/pip" install -r "${SCRIPT_DIR}/requirements.txt"

# Heavy ML stack pinned to CU121
"${VENV}/bin/pip" install --index-url https://download.pytorch.org/whl/cu121 \
    torch==2.4.1+cu121 torchaudio==2.4.1+cu121

"${VENV}/bin/pip" install \
    faster-whisper==1.0.3 \
    demucs==4.0.1 \
    basic-pitch==0.4.0 \
    TTS==0.22.0 \
    rvc-python==0.1.6

# App code
mkdir -p /opt/hermes/app
rsync -a --delete "${SCRIPT_DIR}/app/" /opt/hermes/app/
chown -R hermes:hermes /opt/hermes

# ------------------------------------------------------------------
# 5. systemd unit
# ------------------------------------------------------------------
install -m 0644 "${SCRIPT_DIR}/hermes-worker.service" /etc/systemd/system/hermes-worker.service

if [[ ! -f /etc/hermes/hermes.env ]]; then
    install -m 0640 -o root -g hermes "${SCRIPT_DIR}/.env.example" /etc/hermes/hermes.env
    echo "[install.sh] Wrote /etc/hermes/hermes.env — EDIT IT before starting the service."
fi

systemctl daemon-reload
systemctl enable hermes-worker.service

# ------------------------------------------------------------------
# 6. Caddy reverse proxy + automatic HTTPS
# ------------------------------------------------------------------
if ! command -v caddy >/dev/null 2>&1; then
    apt-get install -y debian-keyring debian-archive-keyring apt-transport-https
    curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
    curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | tee /etc/apt/sources.list.d/caddy-stable.list
    apt-get update
    apt-get install -y caddy
fi

if [[ ! -f /etc/caddy/Caddyfile.hermes.bak ]]; then
    cp -n /etc/caddy/Caddyfile /etc/caddy/Caddyfile.hermes.bak 2>/dev/null || true
fi
install -m 0644 "${SCRIPT_DIR}/Caddyfile" /etc/caddy/Caddyfile
echo "[install.sh] Installed /etc/caddy/Caddyfile — EDIT the domain placeholder before reloading."

echo
echo "================================================================"
echo " Hermes worker installed."
echo
echo " Next steps:"
echo "   1. Fill in /etc/hermes/hermes.env (token, OPENAI_API_KEY, …)"
echo "   2. Edit /etc/caddy/Caddyfile and set your hostname"
echo "   3. sudo systemctl reload caddy"
echo "   4. sudo systemctl start hermes-worker"
echo "   5. curl -fsS https://YOUR_HOST/healthz"
echo "================================================================"

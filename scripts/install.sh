#!/usr/bin/env bash
set -euo pipefail
APP_DIR=${APP_DIR:-/opt/raspi-tailnet-monitor}
CONF_DIR=${CONF_DIR:-/etc/raspi-tailnet-monitor}
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Resolve source directory: prefer the repo layout (../ relative to this script),
# then fall back to the current working directory.
if [ -f "$SCRIPT_DIR/../app.py" ]; then
  SRC_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
elif [ -f "app.py" ]; then
  SRC_DIR="$(pwd)"
else
  echo "error: app.py not found. Run from the project root or pass APP_DIR." >&2
  exit 1
fi

if ! command -v sudo >/dev/null 2>&1; then
  echo "error: sudo is required to install to $APP_DIR / $CONF_DIR" >&2
  exit 1
fi

sudo install -d -m 0755 "$APP_DIR" "$APP_DIR/static"
sudo install -m 0644 "$SRC_DIR/app.py" "$APP_DIR/app.py"
sudo install -m 0644 "$SRC_DIR/static/index.html" "$APP_DIR/static/index.html"
sudo install -m 0644 "$SRC_DIR/static/style.css" "$APP_DIR/static/style.css"
sudo install -m 0644 "$SRC_DIR/static/app.js" "$APP_DIR/static/app.js"
if [ ! -f "$CONF_DIR/config.json" ]; then
  sudo install -d -m 0755 "$CONF_DIR"
  sudo install -m 0644 "$SRC_DIR/config.example.json" "$CONF_DIR/config.json"
  echo "Created $CONF_DIR/config.json - edit ssh_key_path before starting."
fi
sudo install -m 0644 "$SRC_DIR/systemd/raspi-tailnet-monitor.service" /etc/systemd/system/raspi-tailnet-monitor.service
sudo systemctl daemon-reload
sudo systemctl enable raspi-tailnet-monitor.service
cat <<MSG
Installed.
Edit:   sudo nano $CONF_DIR/config.json
Start:  sudo systemctl start raspi-tailnet-monitor
Status: sudo systemctl status raspi-tailnet-monitor
Open:   http://<raspberry-pi-ip>:8080/
MSG

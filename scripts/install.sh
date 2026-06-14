#!/usr/bin/env bash
set -euo pipefail
APP_DIR=${APP_DIR:-/opt/raspi-tailnet-monitor}
CONF_DIR=${CONF_DIR:-/etc/raspi-tailnet-monitor}

sudo mkdir -p "$APP_DIR" "$CONF_DIR"
sudo cp -r app.py static "$APP_DIR/"
if [ ! -f "$CONF_DIR/config.json" ]; then
  sudo cp config.example.json "$CONF_DIR/config.json"
  echo "Created $CONF_DIR/config.json - edit ssh_key_path before starting."
fi
sudo cp systemd/raspi-tailnet-monitor.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable raspi-tailnet-monitor.service
cat <<MSG
Installed.
Edit:   sudo nano $CONF_DIR/config.json
Start:  sudo systemctl start raspi-tailnet-monitor
Status: sudo systemctl status raspi-tailnet-monitor
Open:   http://<raspberry-pi-ip>:8080/
MSG

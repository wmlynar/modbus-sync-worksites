#!/bin/bash
# install-modbus-sync-worksites-service.sh
#
# This script installs modbus-sync-worksites.js as a systemd service.
# Run as:
#   sudo bash install-modbus-sync-worksites-service.sh

set -e

SERVICE_NAME="modbus-sync-worksites.service"
SERVICE_FILE="/etc/systemd/system/${SERVICE_NAME}"

# Path to project and Node binary.
# Adjust NODE_BIN if your Node is not /usr/bin/nodejs (check with: which nodejs)
PROJECT_DIR="/home/admin/modbus-sync-worksites"
NODE_BIN="/usr/bin/nodejs"

echo "Installing systemd service to ${SERVICE_FILE} ..."

cat > "${SERVICE_FILE}" <<EOF
[Unit]
Description=Modbus -> RDS worksites sync service
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=admin
Group=admin
WorkingDirectory=${PROJECT_DIR}
ExecStart=${NODE_BIN} ${PROJECT_DIR}/modbus-sync-worksites.js
Restart=always
RestartSec=5
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
EOF

echo "Reloading systemd daemon..."
systemctl daemon-reload

echo "Enabling service ${SERVICE_NAME} to start on boot..."
systemctl enable "${SERVICE_NAME}"

echo "Starting service ${SERVICE_NAME}..."
systemctl start "${SERVICE_NAME}"

echo
echo "Service status:"
systemctl status "${SERVICE_NAME}" --no-pager -l
echo
echo "Follow logs with:"
echo "  journalctl -u ${SERVICE_NAME} -f"

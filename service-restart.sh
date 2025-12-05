#!/bin/bash
# service-restart.sh
#
# Restart the systemd service and show its status.
# Usage:
#   sudo ./service-restart.sh

SERVICE_NAME="modbus-sync-worksites.service"

systemctl restart "${SERVICE_NAME}"
systemctl status "${SERVICE_NAME}" --no-pager -l

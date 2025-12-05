#!/bin/bash
# service-status.sh
#
# Show systemd service status.
# Usage:
#   ./service-status.sh
# (if needed: sudo ./service-status.sh)

SERVICE_NAME="modbus-sync-worksites.service"

systemctl status "${SERVICE_NAME}" --no-pager -l

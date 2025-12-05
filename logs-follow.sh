#!/bin/bash
# logs-follow.sh
#
# Follow service logs in real time.
# Usage:
#   ./logs-follow.sh
# (if needed: sudo ./logs-follow.sh)

SERVICE_NAME="modbus-sync-worksites.service"

journalctl -u "${SERVICE_NAME}" -f -n 50

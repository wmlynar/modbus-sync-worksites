#!/bin/bash
# logs-last-hour.sh
#
# Show logs from the last hour.
# Usage:
#   ./logs-last-hour.sh
# (if needed: sudo ./logs-last-hour.sh)

SERVICE_NAME="modbus-sync-worksites.service"

journalctl -u "${SERVICE_NAME}" --since "-1 hour" --no-pager

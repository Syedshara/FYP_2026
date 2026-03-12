#!/usr/bin/env bash

set -euo pipefail

source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/common.sh"

service="${1:-all}"

case "$service" in
    all|backend|postgres|redis|fl_server|frontend|fl_client_a|fl_client_b|fl_client_c)
        ;;
    *)
        echo "Usage: ./scripts/linux/logs.sh [all|backend|postgres|redis|fl_server|frontend|fl_client_a|fl_client_b|fl_client_c]"
        exit 1
        ;;
esac

declare -A containers=(
    [backend]="iot_ids_backend"
    [postgres]="iot_ids_postgres"
    [redis]="iot_ids_redis"
    [fl_server]="iot_ids_fl_server"
    [fl_client_a]="iot_ids_fl_client_a"
    [fl_client_b]="iot_ids_fl_client_b"
    [fl_client_c]="iot_ids_fl_client_c"
)

echo
echo "========================================================"
echo "   IoT IDS Platform - Live Log Viewer"
echo "========================================================"
echo

if [ "$service" = "frontend" ]; then
    if [ -f "$FRONTEND_LOG_FILE" ]; then
        exec tail -f "$FRONTEND_LOG_FILE"
    fi
    echo "[X] Frontend log file not found. Start the frontend first with ./scripts/linux/start.sh"
    exit 1
fi

if [ "$service" = "all" ]; then
    exec compose -f "$COMPOSE_FILE" logs -f backend postgres redis fl_server
fi

container_name="${containers[$service]}"
if docker ps --format '{{.Names}}' | grep -Fx "$container_name" >/dev/null 2>&1; then
    exec docker logs "$container_name" --tail 200 -f
fi

echo "[X] Service '$service' is not running. Start it first with ./scripts/linux/start.sh"
exit 1

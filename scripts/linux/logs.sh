#!/usr/bin/env bash

set -euo pipefail

source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/common.sh"

service="${1:-all}"

usage() {
    echo "Usage: ./scripts/linux/logs.sh [all|backend|postgres|redis|fl_server|frontend|fl_clients|client:<client_id>|iot_ids_fl_client_<client_id>]"
}

# Convenience alias: client:<id> -> iot_ids_fl_client_<id>
if [[ "$service" == client:* ]]; then
    client_id="${service#client:}"
    if [ -z "$client_id" ]; then
        usage
        exit 1
    fi
    service="iot_ids_fl_client_${client_id,,}"
fi

case "$service" in
    all|backend|postgres|redis|fl_server|frontend|fl_clients|iot_ids_fl_client_*)
        ;;
    *)
        usage
        exit 1
        ;;
esac

declare -A containers=(
    [backend]="iot_ids_backend"
    [postgres]="iot_ids_postgres"
    [redis]="iot_ids_redis"
    [fl_server]="iot_ids_fl_server"
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

if [ "$service" = "fl_clients" ]; then
    mapfile -t client_containers < <(docker ps --format '{{.Names}}' | grep '^iot_ids_fl_client_' || true)
    if [ "${#client_containers[@]}" -eq 0 ]; then
        echo "[X] No dynamic FL client containers are currently running."
        exit 1
    fi

    if [ "${#client_containers[@]}" -eq 1 ]; then
        exec docker logs "${client_containers[0]}" --tail 200 -f
    fi

    echo "[!] Multiple FL client containers are running."
    echo "    Showing recent logs from each (non-follow mode):"
    echo
    for container_name in "${client_containers[@]}"; do
        echo "----- $container_name -----"
        docker logs "$container_name" --tail 120 || true
        echo
    done
    echo "Tip: Follow one client with: ./scripts/linux/logs.sh client:<client_id>"
    exit 0
fi

if [[ "$service" == iot_ids_fl_client_* ]]; then
    container_name="$service"
else
    container_name="${containers[$service]}"
fi
if docker ps --format '{{.Names}}' | grep -Fx "$container_name" >/dev/null 2>&1; then
    exec docker logs "$container_name" --tail 200 -f
fi

echo "[X] Service '$service' is not running. Start it first with ./scripts/linux/start.sh"
exit 1

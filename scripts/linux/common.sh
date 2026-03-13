#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
COMPOSE_FILE="$PROJECT_ROOT/docker-compose.dev.yml"
FRONTEND_PID_FILE="$PROJECT_ROOT/.frontend.pid"
FRONTEND_LOG_FILE="$PROJECT_ROOT/logs/frontend.log"

# Ensure the br_netfilter kernel module is loaded and sysctl values are set.
# Docker 29.x on kernel 6.x requires this for bridge networking to work.
# Without it, veth pairs may be created but not attached to the bridge,
# causing "No route to host" between containers on the same network.
ensure_kernel_networking() {
    if ! lsmod | grep -q "^br_netfilter"; then
        if sudo modprobe br_netfilter 2>/dev/null; then
            echo "[OK] Loaded br_netfilter kernel module"
        else
            echo "[!] Cannot load br_netfilter — Docker bridge networking may fail" >&2
            return 0
        fi
    fi

    if [ -f /proc/sys/net/bridge/bridge-nf-call-iptables ]; then
        sudo sysctl -q net.bridge.bridge-nf-call-iptables=1 2>/dev/null || true
        sudo sysctl -q net.bridge.bridge-nf-call-ip6tables=1 2>/dev/null || true
    fi

    # Persist across reboots (idempotent — only writes if file is missing)
    if [ ! -f /etc/modules-load.d/docker-bridge.conf ]; then
        echo "br_netfilter" | sudo tee /etc/modules-load.d/docker-bridge.conf >/dev/null 2>&1 || true
    fi
    if [ ! -f /etc/sysctl.d/99-docker-bridge.conf ]; then
        printf 'net.bridge.bridge-nf-call-iptables = 1\nnet.bridge.bridge-nf-call-ip6tables = 1\n' \
            | sudo tee /etc/sysctl.d/99-docker-bridge.conf >/dev/null 2>&1 || true
    fi
}

# Detect and repair veth interfaces that failed to attach to the compose bridge.
#
# Docker 29.x bug: when a container is restarted with `docker restart` (not
# `docker compose restart`), it sometimes creates a new veth pair without
# adding it to the bridge. The container shows as healthy but is unreachable
# from other containers on the same network.
#
# Detection: any veth with no "master <bridge>" and whose peer lives in a
# container network namespace (indicated by "link-netnsid" in ip-link output).
# Repair: attach the orphan to the correct bridge for iot_ids_network.
verify_docker_networking() {
    local network_name="iot_ids_network"

    local net_id
    net_id=$(docker network inspect "$network_name" --format '{{.Id}}' 2>/dev/null | cut -c1-12) || return 0
    local bridge="br-${net_id}"

    if ! ip link show "$bridge" &>/dev/null; then return 0; fi

    local fixed=0
    while IFS= read -r iface; do
        [ -z "$iface" ] && continue

        # Skip if already attached to any bridge
        ip link show "$iface" 2>/dev/null | grep -q "master" && continue

        # Only repair veths whose peer is inside a container network namespace.
        # Veths with "link-netnsid" in their ip-link output have a peer in a
        # different (container) namespace; host-only veths do not have this field.
        ip link show "$iface" 2>/dev/null | grep -q "link-netnsid" || continue

        if sudo ip link set "$iface" master "$bridge" 2>/dev/null; then
            printf "   [FIX] Attached orphan veth %s to bridge %s\n" "$iface" "$bridge"
            fixed=$((fixed + 1))
        fi
    done < <(ip link show type veth 2>/dev/null | grep "^[0-9]" | awk '{print $2}' | cut -d@ -f1)

    [ $fixed -gt 0 ] && printf "[OK] Repaired %d orphan veth(s) — bridge networking restored\n" "$fixed"
    return 0
}

compose() {
    if docker-compose version >/dev/null 2>&1; then
        docker-compose "$@"
    elif docker compose version >/dev/null 2>&1; then
        docker compose "$@"
    else
        echo "[X] Docker Compose not found. Install docker-compose or enable 'docker compose'." >&2
        exit 1
    fi
}

ensure_docker_running() {
    if ! command -v docker >/dev/null 2>&1; then
        echo "[X] Docker not found. Please install Docker first." >&2
        exit 1
    fi

    if ! docker info >/dev/null 2>&1; then
        echo "[X] Docker is not running. Start Docker and try again." >&2
        exit 1
    fi
}

ensure_node_installed() {
    if ! command -v node >/dev/null 2>&1; then
        echo "[X] Node.js not found. Please install Node.js 18+ first." >&2
        exit 1
    fi
}

wait_for_backend() {
    local max_attempts="${1:-30}"
    local delay_seconds="${2:-2}"
    local attempt=0

    while [ "$attempt" -lt "$max_attempts" ]; do
        sleep "$delay_seconds"
        if command -v curl >/dev/null 2>&1 && curl -fsS "http://localhost:8000/health" >/dev/null 2>&1; then
            printf "\n"
            return 0
        fi
        attempt=$((attempt + 1))
        printf "."
    done

    printf "\n"
    return 1
}

frontend_running() {
    if [ ! -f "$FRONTEND_PID_FILE" ]; then
        return 1
    fi

    local pid
    pid="$(head -n 1 "$FRONTEND_PID_FILE" 2>/dev/null || true)"
    if [ -z "$pid" ]; then
        rm -f "$FRONTEND_PID_FILE"
        return 1
    fi

    if kill -0 "$pid" >/dev/null 2>&1; then
        return 0
    fi

    rm -f "$FRONTEND_PID_FILE"
    return 1
}

start_frontend() {
    mkdir -p "$PROJECT_ROOT/logs"

    if frontend_running; then
        local pid
        pid="$(head -n 1 "$FRONTEND_PID_FILE")"
        echo "[OK] Frontend already running (PID: $pid)"
        return 0
    fi

    nohup npm --prefix "$PROJECT_ROOT/frontend" run dev -- --host >"$FRONTEND_LOG_FILE" 2>&1 &
    local pid=$!
    echo "$pid" > "$FRONTEND_PID_FILE"
    echo "[OK] Frontend started in background (PID: $pid)"
}

stop_frontend() {
    local stopped=0

    if frontend_running; then
        local pid
        pid="$(head -n 1 "$FRONTEND_PID_FILE")"
        kill "$pid" >/dev/null 2>&1 || true
        wait "$pid" 2>/dev/null || true
        rm -f "$FRONTEND_PID_FILE"
        stopped=$((stopped + 1))
    fi

    if pgrep -f "npm --prefix $PROJECT_ROOT/frontend run dev -- --host" >/dev/null 2>&1; then
        pkill -f "npm --prefix $PROJECT_ROOT/frontend run dev -- --host" >/dev/null 2>&1 || true
        stopped=$((stopped + 1))
    fi

    echo "$stopped"
}

#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
COMPOSE_FILE="$PROJECT_ROOT/docker-compose.dev.yml"
FRONTEND_PID_FILE="$PROJECT_ROOT/.frontend.pid"
FRONTEND_LOG_FILE="$PROJECT_ROOT/logs/frontend.log"

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

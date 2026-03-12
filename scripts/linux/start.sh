#!/usr/bin/env bash

set -euo pipefail

source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/common.sh"

echo "========================================================"
echo "   IoT IDS Platform - Starting Services"
echo "========================================================"
echo

echo "[*] Checking Docker..."
ensure_docker_running
echo "[OK] Docker is running"

echo
echo "[*] Starting backend services..."
compose -f "$COMPOSE_FILE" up -d
echo "[OK] Backend services started"

echo
echo "[*] Waiting for backend to be ready..."
if wait_for_backend 20 2; then
    echo "[OK] Backend is ready"
else
    echo "[!] Backend may still be starting. Check with: docker logs iot_ids_backend"
fi

echo
echo "[*] Starting frontend..."
start_frontend

echo
echo "========================================================"
echo "   [SUCCESS] All Services Started!"
echo "========================================================"
echo
echo "Login Credentials:"
echo "   Username: admin"
echo "   Password: admin123"
echo
echo "Access Points:"
echo "   Frontend: http://localhost:5173"
echo "   Backend:  http://localhost:8000"
echo "   API Docs: http://localhost:8000/docs"
echo
echo "Service Status:"
echo -n "   PostgreSQL: "
docker ps --filter "name=iot_ids_postgres" --format "{{.Status}}"
echo -n "   Redis:      "
docker ps --filter "name=iot_ids_redis" --format "{{.Status}}"
echo -n "   Backend:    "
docker ps --filter "name=iot_ids_backend" --format "{{.Status}}"
echo
echo "FL Training containers are started automatically by the backend"
echo "when you trigger a training run from the dashboard."
echo
echo "To stop all services, run:"
echo "   ./scripts/linux/stop.sh"
echo
echo "Useful Commands:"
echo "   View backend logs:  docker logs iot_ids_backend -f"
echo "   View all services:  docker compose -f docker-compose.dev.yml ps"
echo "   Tail frontend log:  tail -f logs/frontend.log"
echo

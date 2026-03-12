#!/usr/bin/env bash

set -euo pipefail

source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/common.sh"

echo "========================================================"
echo "   IoT IDS Platform - Stopping Services"
echo "========================================================"
echo

echo "[*] Stopping backend services..."
compose -f "$COMPOSE_FILE" down
echo "[OK] Backend services stopped"

echo
echo "[*] Stopping frontend processes..."
stopped="$(stop_frontend)"
if [ "$stopped" -gt 0 ]; then
    echo "[OK] Stopped $stopped frontend process(es)"
else
    echo "[OK] No frontend processes found"
fi

echo
echo "========================================================"
echo "   [SUCCESS] All Services Stopped!"
echo "========================================================"
echo
echo "To start again, run:"
echo "   ./scripts/linux/start.sh"
echo

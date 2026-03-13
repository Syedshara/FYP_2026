#!/usr/bin/env bash

set -euo pipefail

source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/common.sh"

echo "========================================================"
echo "   IoT IDS Platform - Initial Setup"
echo "========================================================"
echo

echo "[*] Checking Docker..."
ensure_docker_running
echo "[OK] Docker is running"

echo
echo "[*] Checking kernel networking prerequisites..."
ensure_kernel_networking

echo "[*] Checking Node.js..."
ensure_node_installed
echo "[OK] Node.js $(node --version) installed"

echo
echo "[*] Setting up environment variables..."
if [ ! -f "$PROJECT_ROOT/.env" ]; then
    if [ -f "$PROJECT_ROOT/.env.example" ]; then
        cp "$PROJECT_ROOT/.env.example" "$PROJECT_ROOT/.env"
        echo "[OK] Created .env from .env.example"
    else
        echo "[X] .env.example not found. Create .env manually before continuing."
        exit 1
    fi
else
    echo "[OK] .env file already exists"
fi

echo
echo "[*] Generating PKI certificates for mTLS + gradient signing..."
CERTS_DIR="$PROJECT_ROOT/certs"
if [ -d "$CERTS_DIR" ]; then
    echo "[OK] Certificates already exist — skipping (delete ./certs/ to regenerate)"
else
    if ! command -v openssl >/dev/null 2>&1; then
        echo "[X] openssl not found. Install openssl and re-run setup."
        exit 1
    fi

    mkdir -p "$CERTS_DIR/client_keys"

    # ── 1. Self-signed CA ─────────────────────────────────────────────────
    openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:4096 \
        -out "$CERTS_DIR/ca.key" 2>/dev/null
    openssl req -new -x509 -days 3650 -key "$CERTS_DIR/ca.key" \
        -out "$CERTS_DIR/ca.crt" \
        -subj "/CN=IoT-IDS-CA/O=IoT IDS Platform/C=MY" 2>/dev/null
    echo "   [+] CA certificate created"

    # ── 2. FL Server certificate (signed by CA, with SAN for Docker hostnames) ──
    openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 \
        -out "$CERTS_DIR/server.key" 2>/dev/null
    openssl req -new -key "$CERTS_DIR/server.key" \
        -out "$CERTS_DIR/server.csr" \
        -subj "/CN=iot_ids_fl_server/O=IoT IDS Platform/C=MY" \
        -addext "subjectAltName=DNS:iot_ids_fl_server,DNS:fl_server,DNS:localhost,IP:127.0.0.1" 2>/dev/null
    # Create ext file for SAN (needed for older openssl that ignores -addext on x509 -req)
    cat > "$CERTS_DIR/server_ext.cnf" << 'EXTEOF'
[v3_req]
subjectAltName = DNS:iot_ids_fl_server,DNS:fl_server,DNS:localhost,IP:127.0.0.1
EXTEOF
    openssl x509 -req -days 3650 \
        -in "$CERTS_DIR/server.csr" \
        -CA "$CERTS_DIR/ca.crt" -CAkey "$CERTS_DIR/ca.key" -CAcreateserial \
        -out "$CERTS_DIR/server.crt" \
        -extfile "$CERTS_DIR/server_ext.cnf" -extensions v3_req 2>/dev/null
    rm -f "$CERTS_DIR/server.csr" "$CERTS_DIR/server_ext.cnf"
    echo "   [+] FL server certificate created (SANs: iot_ids_fl_server, fl_server, localhost)"

    # ── 3. FL Client mTLS certificates + Ed25519 signing keys ────────────
    for CLIENT_NAME in Bank_A Bank_B Bank_C; do
        # RSA mTLS cert
        openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 \
            -out "$CERTS_DIR/${CLIENT_NAME}.key" 2>/dev/null
        openssl req -new -key "$CERTS_DIR/${CLIENT_NAME}.key" \
            -out "$CERTS_DIR/${CLIENT_NAME}.csr" \
            -subj "/CN=${CLIENT_NAME}/O=IoT IDS Platform/C=MY" 2>/dev/null
        openssl x509 -req -days 3650 \
            -in "$CERTS_DIR/${CLIENT_NAME}.csr" \
            -CA "$CERTS_DIR/ca.crt" -CAkey "$CERTS_DIR/ca.key" -CAcreateserial \
            -out "$CERTS_DIR/${CLIENT_NAME}.crt" 2>/dev/null
        rm -f "$CERTS_DIR/${CLIENT_NAME}.csr"

        # Ed25519 signing keypair
        openssl genpkey -algorithm ed25519 \
            -out "$CERTS_DIR/${CLIENT_NAME}_ed25519.pem" 2>/dev/null
        openssl pkey -in "$CERTS_DIR/${CLIENT_NAME}_ed25519.pem" -pubout \
            -out "$CERTS_DIR/client_keys/${CLIENT_NAME}.pub.pem" 2>/dev/null

        echo "   [+] ${CLIENT_NAME} certificates and signing keys created"
    done

    # Restrict permissions — private keys should not be world-readable
    chmod 600 "$CERTS_DIR"/*.key "$CERTS_DIR"/*.pem 2>/dev/null || true
    chmod 644 "$CERTS_DIR"/*.crt "$CERTS_DIR/client_keys"/*.pem 2>/dev/null || true

    echo "[OK] PKI certificates generated in ./certs/"
fi

echo
echo "[*] Installing frontend dependencies..."
(cd "$PROJECT_ROOT/frontend" && npm install)
echo "[OK] Frontend dependencies installed"

echo
echo "[*] Building Docker images (this may take a few minutes)..."
compose -f "$COMPOSE_FILE" build
echo "[OK] Docker images built successfully"

echo
echo "[*] Starting database services..."
compose -f "$COMPOSE_FILE" up -d --wait postgres redis
echo "[OK] Database services started and healthy"

echo
echo "[*] Verifying container network connectivity..."
verify_docker_networking

echo
echo "[*] Running database migrations..."
compose -f "$COMPOSE_FILE" run --rm backend alembic upgrade head
echo "[OK] Database migrations completed"

echo
echo "[*] Starting backend services..."
compose -f "$COMPOSE_FILE" up -d backend
echo "[OK] Backend services started"

echo
echo "[*] Verifying container network connectivity..."
verify_docker_networking

echo
echo "[*] Waiting for backend to be ready..."
if wait_for_backend 30 2; then
    echo "[OK] Backend is ready"
else
    echo "[X] Backend took longer than expected to start. Check logs with: docker logs iot_ids_backend"
    exit 1
fi

echo
echo "[*] Starting frontend..."
start_frontend

echo
echo "========================================================"
echo "   [SUCCESS] Setup Complete!"
echo "========================================================"
echo
echo "Default Login Credentials:"
echo "   Username: admin"
echo "   Password: admin123"
echo
echo "Access the application:"
echo "   Frontend: http://localhost:5173"
echo "   Backend:  http://localhost:8000"
echo "   API Docs: http://localhost:8000/docs"
echo
echo "To start the project in the future, run:"
echo "   ./scripts/linux/start.sh"
echo
echo "To stop all services, run:"
echo "   ./scripts/linux/stop.sh"
echo

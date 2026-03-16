. (Join-Path $PSScriptRoot "common.ps1")

Write-Host "========================================================" -ForegroundColor Cyan
Write-Host "   IoT IDS Platform - Initial Setup" -ForegroundColor Cyan
Write-Host "========================================================" -ForegroundColor Cyan
Write-Host ""

$projectRoot = Get-ProjectRoot
$composeFile = Get-ComposeFile

Write-Host "[*] Checking Docker..." -ForegroundColor Yellow
try {
    docker info *> $null
    if ($LASTEXITCODE -ne 0) {
        Write-Host "[X] Docker is not running. Please start Docker Desktop and run this script again." -ForegroundColor Red
        exit 1
    }
    Write-Host "[OK] Docker is running" -ForegroundColor Green
} catch {
    Write-Host "[X] Docker not found. Please install Docker Desktop first." -ForegroundColor Red
    exit 1
}

Write-Host "[*] Checking Node.js..." -ForegroundColor Yellow
try {
    $nodeVersion = node --version
    Write-Host "[OK] Node.js $nodeVersion installed" -ForegroundColor Green
} catch {
    Write-Host "[X] Node.js not found. Please install Node.js 18+ first." -ForegroundColor Red
    exit 1
}

Write-Host ""
Write-Host "[*] Setting up environment variables..." -ForegroundColor Yellow
$envFile = Join-Path $projectRoot ".env"
$envExample = Join-Path $projectRoot ".env.example"
if (-not (Test-Path $envFile)) {
    if (Test-Path $envExample) {
        Copy-Item $envExample $envFile
        Write-Host "[OK] Created .env from .env.example" -ForegroundColor Green
    } else {
        Write-Host "[X] .env.example not found. Create .env manually before continuing." -ForegroundColor Red
        exit 1
    }
} else {
    Write-Host "[OK] .env file already exists" -ForegroundColor Green
}

Write-Host ""
Write-Host "[*] Generating PKI certificates for mTLS + gradient signing..." -ForegroundColor Yellow
$certsDir = Join-Path $projectRoot "certs"
if (Test-Path $certsDir) {
    Write-Host "[OK] Certificates already exist — skipping (delete .\certs\ to regenerate)" -ForegroundColor Green
} else {
    # Verify openssl is available (ships with Windows 10/11 at C:\Windows\System32\OpenSSL.exe
    # or via Git for Windows / WSL)
    try {
        openssl version *> $null
        if ($LASTEXITCODE -ne 0) { throw "openssl not found" }
    } catch {
        Write-Host "[X] openssl not found. Install Git for Windows or OpenSSL and re-run setup." -ForegroundColor Red
        exit 1
    }

    New-Item -ItemType Directory -Path $certsDir | Out-Null
    New-Item -ItemType Directory -Path (Join-Path $certsDir "client_keys") | Out-Null

    # ── 1. Self-signed CA ─────────────────────────────────────────────────
    openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:4096 `
        -out "$certsDir\ca.key" 2>$null
    openssl req -new -x509 -days 3650 -key "$certsDir\ca.key" `
        -out "$certsDir\ca.crt" `
        -subj "/CN=IoT-IDS-CA/O=IoT IDS Platform/C=MY" 2>$null
    Write-Host "   [+] CA certificate created" -ForegroundColor Gray

    # ── 2. FL Server certificate (signed by CA, with SAN for Docker hostnames) ──
    openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 `
        -out "$certsDir\server.key" 2>$null
    openssl req -new -key "$certsDir\server.key" `
        -out "$certsDir\server.csr" `
        -subj "/CN=iot_ids_fl_server/O=IoT IDS Platform/C=MY" `
        -addext "subjectAltName=DNS:iot_ids_fl_server,DNS:fl_server,DNS:localhost,IP:127.0.0.1" 2>$null
    # Write SAN extension config file (needed for -extfile on x509 -req)
    @"
[v3_req]
subjectAltName = DNS:iot_ids_fl_server,DNS:fl_server,DNS:localhost,IP:127.0.0.1
"@ | Set-Content "$certsDir\server_ext.cnf"
    openssl x509 -req -days 3650 `
        -in "$certsDir\server.csr" `
        -CA "$certsDir\ca.crt" -CAkey "$certsDir\ca.key" -CAcreateserial `
        -out "$certsDir\server.crt" `
        -extfile "$certsDir\server_ext.cnf" -extensions v3_req 2>$null
    Remove-Item "$certsDir\server.csr" -ErrorAction SilentlyContinue
    Remove-Item "$certsDir\server_ext.cnf" -ErrorAction SilentlyContinue
    Write-Host "   [+] FL server certificate created (SANs: iot_ids_fl_server, fl_server, localhost)" -ForegroundColor Gray

    # ── 3. FL client certs/keys are generated dynamically ─────────────────
    # Static client provisioning is intentionally removed.
    # New FL clients (canvas/DB-driven) get their mTLS cert + Ed25519 keys
    # from backend/app/services/fl_service.py::_generate_client_keys().
    Write-Host "   [+] Dynamic FL client certificate provisioning enabled" -ForegroundColor Gray

    Write-Host "[OK] PKI certificates generated in .\certs\" -ForegroundColor Green
}

Write-Host ""
Write-Host "[*] Installing frontend dependencies..." -ForegroundColor Yellow
Push-Location (Join-Path $projectRoot "frontend")
try {
    npm install
    if ($LASTEXITCODE -ne 0) {
        Write-Host "[X] Failed to install frontend dependencies" -ForegroundColor Red
        Pop-Location
        exit 1
    }
    Write-Host "[OK] Frontend dependencies installed" -ForegroundColor Green
} catch {
    Write-Host "[X] Error installing frontend dependencies: $_" -ForegroundColor Red
    Pop-Location
    exit 1
}
Pop-Location

Write-Host ""
Write-Host "[*] Building Docker images (this may take a few minutes)..." -ForegroundColor Yellow
Invoke-Compose -f $composeFile build
if ($LASTEXITCODE -ne 0) {
    Write-Host "[X] Failed to build Docker images" -ForegroundColor Red
    exit 1
}
Write-Host "[OK] Docker images built successfully" -ForegroundColor Green

Write-Host ""
Write-Host "[*] Starting database services..." -ForegroundColor Yellow
Invoke-Compose -f $composeFile up -d postgres redis
if ($LASTEXITCODE -ne 0) {
    Write-Host "[X] Failed to start database services" -ForegroundColor Red
    exit 1
}
Write-Host "[OK] Database services started" -ForegroundColor Green

Write-Host ""
Write-Host "[*] Running database migrations..." -ForegroundColor Yellow
Invoke-Compose -f $composeFile run --rm backend alembic upgrade head
if ($LASTEXITCODE -ne 0) {
    Write-Host "[X] Failed to run database migrations" -ForegroundColor Red
    exit 1
}
Write-Host "[OK] Database migrations completed" -ForegroundColor Green

Write-Host ""
Write-Host "[*] Starting backend services..." -ForegroundColor Yellow
Invoke-Compose -f $composeFile up -d backend
if ($LASTEXITCODE -ne 0) {
    Write-Host "[X] Failed to start backend services" -ForegroundColor Red
    exit 1
}
Write-Host "[OK] Backend services started" -ForegroundColor Green

Write-Host "" 
Write-Host "[*] Waiting for backend to be ready..." -ForegroundColor Yellow
if (Wait-ForBackend) {
    Write-Host "[OK] Backend is ready" -ForegroundColor Green
} else {
    Write-Host "[X] Backend took longer than expected to start. Check logs with: docker logs iot_ids_backend" -ForegroundColor Red
    exit 1
}

Write-Host ""
Write-Host "[*] Starting frontend..." -ForegroundColor Yellow
$frontendPid = Start-FrontendProcess
Write-Host "[OK] Frontend started in new window (PID: $frontendPid)" -ForegroundColor Green

Write-Host ""
Write-Host "========================================================" -ForegroundColor Green
Write-Host "   [SUCCESS] Setup Complete!" -ForegroundColor Green
Write-Host "========================================================" -ForegroundColor Green
Write-Host ""
Write-Host "Default Login Credentials:" -ForegroundColor Cyan
Write-Host "   Username: admin" -ForegroundColor White
Write-Host "   Password: admin123" -ForegroundColor White
Write-Host ""
Write-Host "Access the application:" -ForegroundColor Cyan
Write-Host "   Frontend: http://localhost:5173" -ForegroundColor White
Write-Host "   Backend:  http://localhost:8000" -ForegroundColor White
Write-Host "   API Docs: http://localhost:8000/docs" -ForegroundColor White
Write-Host ""
Write-Host "To start the project in the future, run:" -ForegroundColor Cyan
Write-Host "   .\scripts\windows\start.ps1" -ForegroundColor White
Write-Host ""
Write-Host "To stop all services, run:" -ForegroundColor Cyan
Write-Host "   .\scripts\windows\stop.ps1" -ForegroundColor White
Write-Host ""

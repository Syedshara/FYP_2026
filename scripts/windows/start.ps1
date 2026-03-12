. (Join-Path $PSScriptRoot "common.ps1")

Write-Host "========================================================" -ForegroundColor Cyan
Write-Host "   IoT IDS Platform - Starting Services" -ForegroundColor Cyan
Write-Host "========================================================" -ForegroundColor Cyan
Write-Host ""

$projectRoot = Get-ProjectRoot
$composeFile = Get-ComposeFile

Write-Host "[*] Checking Docker..." -ForegroundColor Yellow
try {
    docker info *> $null
    if ($LASTEXITCODE -ne 0) {
        $dockerDesktop = "C:\Program Files\Docker\Docker\Docker Desktop.exe"
        if (Test-Path $dockerDesktop) {
            Write-Host "[!] Docker is not running. Starting Docker Desktop..." -ForegroundColor Yellow
            Start-Process $dockerDesktop
            Write-Host "[*] Waiting for Docker to start (30 seconds)..." -ForegroundColor Yellow
            Start-Sleep -Seconds 30
            docker info *> $null
        }

        if ($LASTEXITCODE -ne 0) {
            Write-Host "[X] Docker is not running. Please start Docker Desktop manually." -ForegroundColor Red
            exit 1
        }
    }
    Write-Host "[OK] Docker is running" -ForegroundColor Green
} catch {
    Write-Host "[X] Docker not found. Please install Docker Desktop first." -ForegroundColor Red
    exit 1
}

Write-Host ""
Write-Host "[*] Starting backend services..." -ForegroundColor Yellow
Invoke-Compose -f $composeFile up -d
if ($LASTEXITCODE -ne 0) {
    Write-Host "[X] Failed to start backend services" -ForegroundColor Red
    exit 1
}
Write-Host "[OK] Backend services started" -ForegroundColor Green

Write-Host ""
Write-Host "[*] Waiting for backend to be ready..." -ForegroundColor Yellow
if (Wait-ForBackend -MaxAttempts 20) {
    Write-Host "[OK] Backend is ready" -ForegroundColor Green
} else {
    Write-Host "[!] Backend may still be starting. Check with: docker logs iot_ids_backend" -ForegroundColor Yellow
}

Write-Host ""
Write-Host "[*] Starting frontend..." -ForegroundColor Yellow
$frontendPid = Start-FrontendProcess
Write-Host "[OK] Frontend started in new window (PID: $frontendPid)" -ForegroundColor Green

Write-Host ""
Write-Host "========================================================" -ForegroundColor Green
Write-Host "   [SUCCESS] All Services Started!" -ForegroundColor Green
Write-Host "========================================================" -ForegroundColor Green
Write-Host ""
Write-Host "Login Credentials:" -ForegroundColor Cyan
Write-Host "   Username: admin" -ForegroundColor White
Write-Host "   Password: admin123" -ForegroundColor White
Write-Host ""
Write-Host "Access Points:" -ForegroundColor Cyan
Write-Host "   Frontend: http://localhost:5173" -ForegroundColor White
Write-Host "   Backend:  http://localhost:8000" -ForegroundColor White
Write-Host "   API Docs: http://localhost:8000/docs" -ForegroundColor White
Write-Host ""
Write-Host "Service Status:" -ForegroundColor Cyan
Write-Host "   PostgreSQL: " -NoNewline -ForegroundColor White
docker ps --filter "name=iot_ids_postgres" --format "{{.Status}}" | Write-Host -ForegroundColor Green
Write-Host "   Redis:      " -NoNewline -ForegroundColor White
docker ps --filter "name=iot_ids_redis" --format "{{.Status}}" | Write-Host -ForegroundColor Green
Write-Host "   Backend:    " -NoNewline -ForegroundColor White
docker ps --filter "name=iot_ids_backend" --format "{{.Status}}" | Write-Host -ForegroundColor Green
Write-Host ""
Write-Host "FL Training containers are started automatically by the backend" -ForegroundColor DarkGray
Write-Host "when you trigger a training run from the dashboard." -ForegroundColor DarkGray
Write-Host ""
Write-Host "To stop all services, run:" -ForegroundColor Cyan
Write-Host "   .\scripts\windows\stop.ps1" -ForegroundColor White
Write-Host ""
Write-Host "Useful Commands:" -ForegroundColor Cyan
Write-Host "   View backend logs:  docker logs iot_ids_backend -f" -ForegroundColor White
Write-Host "   View all services:  docker-compose -f docker-compose.dev.yml ps" -ForegroundColor White
Write-Host "   Tail frontend log:  Get-Content .\logs\frontend.log -Wait" -ForegroundColor White
Write-Host ""

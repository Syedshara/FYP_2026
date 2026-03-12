. (Join-Path $PSScriptRoot "common.ps1")

Write-Host "========================================================" -ForegroundColor Cyan
Write-Host "   IoT IDS Platform - Stopping Services" -ForegroundColor Cyan
Write-Host "========================================================" -ForegroundColor Cyan
Write-Host ""

$composeFile = Get-ComposeFile

Write-Host "[*] Stopping backend services..." -ForegroundColor Yellow
Invoke-Compose -f $composeFile down

if ($LASTEXITCODE -eq 0) {
    Write-Host "[OK] Backend services stopped" -ForegroundColor Green
} else {
    Write-Host "[X] Failed to stop services" -ForegroundColor Red
    exit 1
}

Write-Host ""
Write-Host "[*] Stopping frontend processes..." -ForegroundColor Yellow
$stopped = Stop-FrontendProcess
if ($stopped -gt 0) {
    Write-Host "[OK] Stopped $stopped frontend process(es)" -ForegroundColor Green
} else {
    Write-Host "[OK] No frontend processes found" -ForegroundColor Green
}

Write-Host ""
Write-Host "========================================================" -ForegroundColor Green
Write-Host "   [SUCCESS] All Services Stopped!" -ForegroundColor Green
Write-Host "========================================================" -ForegroundColor Green
Write-Host ""
Write-Host "To start again, run:" -ForegroundColor Cyan
Write-Host "   .\scripts\windows\start.ps1" -ForegroundColor White
Write-Host ""

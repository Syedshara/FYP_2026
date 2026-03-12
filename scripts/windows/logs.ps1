. (Join-Path $PSScriptRoot "common.ps1")

param(
    [Parameter(Position = 0)]
    [ValidateSet("all", "backend", "postgres", "redis", "fl_server", "frontend", "fl_client_a", "fl_client_b", "fl_client_c")]
    [string]$Service = "all"
)

$containers = [ordered]@{
    backend     = @{ Name = "iot_ids_backend"; Title = "API  - FastAPI Backend :8000" }
    postgres    = @{ Name = "iot_ids_postgres"; Title = "DB   - PostgreSQL :5432" }
    redis       = @{ Name = "iot_ids_redis"; Title = "CACHE- Redis :6379" }
    fl_server   = @{ Name = "iot_ids_fl_server"; Title = "FL   - Flower Server :8080" }
    fl_client_a = @{ Name = "iot_ids_fl_client_a"; Title = "FL-A - Client Bank_A" }
    fl_client_b = @{ Name = "iot_ids_fl_client_b"; Title = "FL-B - Client Bank_B" }
    fl_client_c = @{ Name = "iot_ids_fl_client_c"; Title = "FL-C - Client Bank_C" }
}

Write-Host ""
Write-Host "========================================================" -ForegroundColor Cyan
Write-Host "   IoT IDS Platform - Live Log Viewer" -ForegroundColor Cyan
Write-Host "========================================================" -ForegroundColor Cyan
Write-Host ""

if ($Service -eq "all") {
    $keys = @("backend", "postgres", "redis", "fl_server")
} else {
    $keys = @($Service)
}

$running = @(docker ps --format "{{.Names}}" 2>$null)
$opened = 0

foreach ($key in $keys) {
    if ($key -eq "frontend") {
        $logFile = Get-FrontendLogFile
        if (Test-Path $logFile) {
            Start-Process powershell -ArgumentList "-NoExit", "-ExecutionPolicy", "Bypass", "-Command", "Get-Content '$logFile' -Wait"
            Write-Host "  + Frontend log                - window opened" -ForegroundColor Yellow
            $opened++
        } else {
            Write-Host "  - Frontend                    - log file not found" -ForegroundColor DarkGray
        }
        continue
    }

    $container = $containers[$key]
    if ($running -contains $container.Name) {
        Start-Process powershell -ArgumentList "-NoExit", "-ExecutionPolicy", "Bypass", "-Command", "docker logs $($container.Name) --tail 200 -f"
        Write-Host "  + $($container.Title.PadRight(30)) - window opened" -ForegroundColor Green
        $opened++
    } else {
        Write-Host "  - $($container.Title.PadRight(30)) - not running" -ForegroundColor DarkGray
    }
}

Write-Host ""
if ($opened -gt 0) {
    Write-Host "  Opened $opened log window(s). Close them with Ctrl+C or X." -ForegroundColor Green
} else {
    Write-Host "  No services running. Start with: .\scripts\windows\start.ps1" -ForegroundColor Red
}
Write-Host ""

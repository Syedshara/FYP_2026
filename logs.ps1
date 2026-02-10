# ========================================================
#  IoT IDS Platform - Live Log Viewer
# ========================================================
#  Opens a separate CMD window for each running service,
#  tailing docker logs in real-time.
#
#  Usage:
#    .\logs.ps1              # Open logs for all running services
#    .\logs.ps1 backend      # Backend only
#    .\logs.ps1 postgres     # PostgreSQL only
#    .\logs.ps1 redis        # Redis only
#    .\logs.ps1 fl_server    # FL Server only
#    .\logs.ps1 frontend     # Frontend (Vite) only
#
#  Close any log window with Ctrl+C or just close the window.
# ========================================================

param(
    [Parameter(Position = 0)]
    [ValidateSet("all","backend","postgres","redis","fl_server","frontend","fl_client_a","fl_client_b","fl_client_c")]
    [string]$Service = "all"
)

# ── Container map ────────────────────────────────────────
$containers = [ordered]@{
    backend     = @{ Name = "iot_ids_backend";     Title = "API  - FastAPI Backend :8000" }
    postgres    = @{ Name = "iot_ids_postgres";     Title = "DB   - PostgreSQL :5432" }
    redis       = @{ Name = "iot_ids_redis";        Title = "CACHE- Redis :6379" }
    fl_server   = @{ Name = "iot_ids_fl_server";    Title = "FL   - Flower Server :8080" }
    fl_client_a = @{ Name = "iot_ids_fl_client_a";  Title = "FL-A - Client Bank_A" }
    fl_client_b = @{ Name = "iot_ids_fl_client_b";  Title = "FL-B - Client Bank_B" }
    fl_client_c = @{ Name = "iot_ids_fl_client_c";  Title = "FL-C - Client Bank_C" }
}

# ── Header ───────────────────────────────────────────────
Write-Host ""
Write-Host "========================================================" -ForegroundColor Cyan
Write-Host "   IoT IDS Platform - Live Log Viewer" -ForegroundColor Cyan
Write-Host "========================================================" -ForegroundColor Cyan
Write-Host ""

# ── Which services? ──────────────────────────────────────
if ($Service -eq "all") {
    $keys = @("backend","postgres","redis","fl_server")
} else {
    $keys = @($Service)
}

# ── Running containers ───────────────────────────────────
$running = @(docker ps --format "{{.Names}}" 2>$null)

$opened = 0

foreach ($key in $keys) {

    # Frontend is not a docker container
    if ($key -eq "frontend") {
        $frontendDir = Join-Path $PSScriptRoot "frontend"
        if (Test-Path (Join-Path $frontendDir "package.json")) {
            Start-Process cmd.exe -ArgumentList "/k title LOGS: UI - Frontend Vite :5173 && cd /d $frontendDir && npm run dev -- --host"
            Write-Host "  + Frontend (Vite)           - window opened" -ForegroundColor Yellow
            $opened++
        } else {
            Write-Host "  - Frontend                  - package.json not found" -ForegroundColor DarkGray
        }
        continue
    }

    $c = $containers[$key]
    if ($running -contains $c.Name) {
        Start-Process cmd.exe -ArgumentList "/k title LOGS: $($c.Title) && docker logs $($c.Name) --tail 200 -f"
        Write-Host "  + $($c.Title.PadRight(30)) - window opened" -ForegroundColor Green
        $opened++
    } else {
        Write-Host "  - $($c.Title.PadRight(30)) - not running" -ForegroundColor DarkGray
    }
}

# ── Summary ──────────────────────────────────────────────
Write-Host ""
if ($opened -gt 0) {
    Write-Host "  Opened $opened log window(s). Close them with Ctrl+C or X." -ForegroundColor Green
} else {
    Write-Host "  No services running. Start with: .\start.ps1" -ForegroundColor Red
}
Write-Host ""

function Get-ProjectRoot {
    return (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
}

function Get-ComposeFile {
    return Join-Path (Get-ProjectRoot) "docker-compose.dev.yml"
}

function Get-FrontendLogFile {
    return Join-Path (Get-ProjectRoot) "logs\frontend.log"
}

function Get-FrontendPidFile {
    return Join-Path (Get-ProjectRoot) ".frontend.pid"
}

function Invoke-Compose {
    param(
        [Parameter(ValueFromRemainingArguments = $true)]
        [string[]]$ComposeArgs
    )

    if (Get-Command docker-compose -ErrorAction SilentlyContinue) {
        & docker-compose @ComposeArgs
        return $LASTEXITCODE
    }

    docker compose version *> $null
    if ($LASTEXITCODE -eq 0) {
        & docker compose @ComposeArgs
        return $LASTEXITCODE
    }

    Write-Host "[X] Docker Compose not found. Install Docker Compose or enable 'docker compose'." -ForegroundColor Red
    exit 1
}

function Wait-ForBackend {
    param(
        [int]$MaxAttempts = 30,
        [int]$DelaySeconds = 2
    )

    $attempt = 0
    $backendReady = $false

    while ($attempt -lt $MaxAttempts -and -not $backendReady) {
        Start-Sleep -Seconds $DelaySeconds
        try {
            $response = Invoke-WebRequest -Uri "http://localhost:8000/health" -TimeoutSec 2 -ErrorAction Stop
            if ($response.StatusCode -eq 200) {
                $backendReady = $true
            }
        } catch {
            # Backend not ready yet.
        }
        $attempt++
        Write-Host "." -NoNewline
    }

    Write-Host ""
    return $backendReady
}

function Get-FrontendProcess {
    $pidFile = Get-FrontendPidFile
    if (-not (Test-Path $pidFile)) {
        return $null
    }

    $pidValue = Get-Content $pidFile -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $pidValue) {
        Remove-Item $pidFile -ErrorAction SilentlyContinue
        return $null
    }

    $process = Get-Process -Id ([int]$pidValue) -ErrorAction SilentlyContinue
    if (-not $process) {
        Remove-Item $pidFile -ErrorAction SilentlyContinue
    }
    return $process
}

function Start-FrontendProcess {
    $existingProcess = Get-FrontendProcess
    if ($existingProcess) {
        Write-Host "[OK] Frontend already running (PID: $($existingProcess.Id))" -ForegroundColor Green
        return $existingProcess.Id
    }

    $projectRoot = Get-ProjectRoot
    $logDir = Join-Path $projectRoot "logs"
    $logFile = Get-FrontendLogFile
    $pidFile = Get-FrontendPidFile

    New-Item -ItemType Directory -Force -Path $logDir | Out-Null

    $command = "Set-Location '$projectRoot'; npm --prefix frontend run dev -- --host *>&1 | Tee-Object -FilePath '$logFile'"
    $process = Start-Process powershell -ArgumentList "-NoExit", "-ExecutionPolicy", "Bypass", "-Command", $command -PassThru
    Set-Content -Path $pidFile -Value $process.Id
    return $process.Id
}

function Stop-FrontendProcess {
    $stopped = 0
    $pidFile = Get-FrontendPidFile
    $process = Get-FrontendProcess

    if ($process) {
        try {
            Stop-Process -Id $process.Id -Force -ErrorAction Stop
            $stopped++
        } catch {
            Write-Host "[!] Failed to stop frontend process from PID file: $_" -ForegroundColor Yellow
        }
    }

    Remove-Item $pidFile -ErrorAction SilentlyContinue

    $projectRoot = Get-ProjectRoot
    $nodeProcesses = Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
        Where-Object { $_.CommandLine -match [regex]::Escape($projectRoot) -and ($_.CommandLine -match "vite" -or $_.CommandLine -match "npm") }

    foreach ($nodeProcess in $nodeProcesses) {
        try {
            Stop-Process -Id $nodeProcess.ProcessId -Force -ErrorAction SilentlyContinue
            $stopped++
        } catch {
            # Ignore failures on already-closed processes.
        }
    }

    return $stopped
}

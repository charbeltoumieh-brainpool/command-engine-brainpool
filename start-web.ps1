$ErrorActionPreference = "Stop"

$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$BackendDir = Join-Path $Root "backend"
$FrontendDir = Join-Path $Root "frontend"

$BackendPort = if ($env:BACKEND_PORT) { $env:BACKEND_PORT } else { "8085" }
$FrontendPort = if ($env:FRONTEND_PORT) { $env:FRONTEND_PORT } else { "5179" }

$VenvPython = Join-Path $BackendDir ".venv\Scripts\python.exe"
if (Test-Path $VenvPython) {
    $BackendCmd = $VenvPython
    $BackendArgs = @("-m", "uvicorn", "app.main:app", "--host", "127.0.0.1", "--port", $BackendPort, "--reload")
} elseif (Get-Command uv -ErrorAction SilentlyContinue) {
    $BackendCmd = "uv"
    $BackendArgs = @("run", "--directory", $BackendDir, "uvicorn", "app.main:app", "--host", "127.0.0.1", "--port", $BackendPort, "--reload")
} else {
    $BackendCmd = "python"
    $BackendArgs = @("-m", "uvicorn", "app.main:app", "--host", "127.0.0.1", "--port", $BackendPort, "--reload")
}

Write-Host "Starting Command Engine Backend on http://127.0.0.1:$BackendPort ..."
$BackendProc = Start-Process -FilePath $BackendCmd -ArgumentList $BackendArgs -WorkingDirectory $BackendDir -PassThru -NoNewWindow

Write-Host "Starting Command Engine Frontend on http://127.0.0.1:$FrontendPort ..."
$FrontendProc = Start-Process -FilePath "npm.cmd" -ArgumentList @("run", "dev", "--", "--host", "127.0.0.1", "--port", $FrontendPort) -WorkingDirectory $FrontendDir -PassThru -NoNewWindow

Write-Host ""
Write-Host "Command Engine Web is running:"
Write-Host "  UI:  http://127.0.0.1:$FrontendPort"
Write-Host "  API: http://127.0.0.1:$BackendPort/api/health"
Write-Host "Press Ctrl+C to stop both processes."

try {
    while (-not $BackendProc.HasExited -and -not $FrontendProc.HasExited) {
        Start-Sleep -Milliseconds 500
    }
} finally {
    if ($BackendProc -and -not $BackendProc.HasExited) {
        Stop-Process -Id $BackendProc.Id -Force -ErrorAction SilentlyContinue
    }
    if ($FrontendProc -and -not $FrontendProc.HasExited) {
        Stop-Process -Id $FrontendProc.Id -Force -ErrorAction SilentlyContinue
    }
}

@echo off
setlocal
cd /d "%~dp0"

set "PIDFILE=%~dp0data\bridge.lock"

if not exist "%PIDFILE%" (
  echo [agent-bridge] not running: no lock file.
  goto :end
)

set /p PID=<"%PIDFILE%"

if "%PID%"=="" (
  echo [agent-bridge] lock file is empty. nothing to stop.
  goto :end
)

echo [agent-bridge] stopping PID %PID% ...
taskkill /F /PID %PID% >nul 2>&1
if errorlevel 1 (
  echo [agent-bridge] PID %PID% was not running.
) else (
  echo [agent-bridge] stopped.
)

:end
echo.
pause

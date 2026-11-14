@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"

set "NODE=%~dp0runtime\node.exe"
if not exist "%NODE%" set "NODE=node"
if exist "%ProgramFiles%\nodejs\node.exe" set "NODE=%ProgramFiles%\nodejs\node.exe"

echo [agent-bridge] foreground mode. Press Ctrl+C to stop.
echo [agent-bridge] log is also written to data\bridge-desktop.log
echo.

if not exist "data" mkdir "data"
powershell.exe -NoProfile -Command "& $env:NODE --env-file-if-exists=.env src/index.mjs 2>&1 | ForEach-Object { $_.ToString() } | Tee-Object -FilePath 'data/bridge-desktop.log' -Append; exit $LASTEXITCODE"

echo.
echo [agent-bridge] exited.
pause

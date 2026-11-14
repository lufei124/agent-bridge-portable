@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"

set "NODE=%~dp0runtime\node.exe"
if not exist "%NODE%" set "NODE=node"

echo [agent-bridge] foreground mode. Press Ctrl+C to stop.
echo [agent-bridge] log is also written to data\bridge.log
echo.

"%NODE%" --env-file-if-exists=.env src\index.mjs

echo.
echo [agent-bridge] exited.
pause

@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"

set "NODE=%~dp0runtime\node.exe"
if not exist "%NODE%" set "NODE=node"
if /i "%~1"=="--deepseek" if exist "%ProgramFiles%\nodejs\node.exe" set "NODE=%ProgramFiles%\nodejs\node.exe"

"%NODE%" --env-file-if-exists=.env "%~dp0tools\doctor.mjs" %*

echo.
pause

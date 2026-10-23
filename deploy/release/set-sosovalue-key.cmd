@echo off
rem Double-click (or run from cmd / PowerShell): set-sosovalue-key.sh in Git Bash, which
rem asks for the SoSoValue key and sets it for local testing and production.
setlocal
set "GITBASH=%ProgramFiles%\Git\bin\bash.exe"
if not exist "%GITBASH%" (
  echo Git Bash was not found at "%GITBASH%". Install Git for Windows, or run set-sosovalue-key.sh from Git Bash.
  pause
  exit /b 1
)
cd /d "%~dp0..\.."
"%GITBASH%" deploy/release/set-sosovalue-key.sh %*
echo.
pause

@echo off
rem ============================================================================
rem  ValueDesk - the guided test run before launch.
rem
rem  Double-click this file, or run it in a terminal:
rem      RUN-LIVE-TESTS.cmd              the full guided run (stages A, B, C, D)
rem      RUN-LIVE-TESTS.cmd --stages A,B only the offline suites and the read-only checks
rem      RUN-LIVE-TESTS.cmd --help       every option
rem
rem  It tells you what to do at every step and ends with one summary.
rem  What each stage covers: docs\TESTING.md
rem
rem  This file only starts the guide (apps\web\e2e\guide\guide.ts). It never
rem  takes a private key: the guide asks for it itself, with a hidden prompt.
rem ============================================================================
setlocal
title ValueDesk - guided test run

rem A key variable left in this window is not passed on (looked at by name only).
if defined VS_E2E_KEY echo  Note: VS_E2E_KEY is set in this window. The guide does not use it and it is
if defined VS_E2E_KEY echo  not passed on. The guide asks for the key itself, with a hidden prompt.
set "VS_E2E_KEY="

cd /d "%~dp0apps\web" 2>nul
if errorlevel 1 goto nofolder
if not exist "e2e\guide\guide.ts" goto nofolder

where node >nul 2>nul
if errorlevel 1 goto nonode

if exist "node_modules\tsx\package.json" goto run
if exist "..\..\node_modules\tsx\package.json" goto run
goto nopackages

:run
node --import tsx e2e\guide\guide.ts %*
set "VS_GUIDE_EXIT=%ERRORLEVEL%"
goto done

:nofolder
echo.
echo  The guide was not found: apps\web\e2e\guide\guide.ts is missing next to this
echo  file. Run RUN-LIVE-TESTS.cmd from the ValueDesk repository folder.
set "VS_GUIDE_EXIT=2"
goto done

:nonode
echo.
echo  Node.js was not found on this computer.
echo  Install Node.js 22 or newer from https://nodejs.org and run this file again.
set "VS_GUIDE_EXIT=2"
goto done

:nopackages
echo.
echo  The project's packages are not installed yet.
echo  Open a terminal in the repository folder and run:   npm install
echo  Then run this file again.
set "VS_GUIDE_EXIT=2"
goto done

:done
echo.
set "VS_GUIDE_PAUSE=1"
for %%A in (%*) do if /i "%%~A"=="--no-pause" set "VS_GUIDE_PAUSE="
if defined VS_GUIDE_PAUSE pause
endlocal & exit /b %VS_GUIDE_EXIT%

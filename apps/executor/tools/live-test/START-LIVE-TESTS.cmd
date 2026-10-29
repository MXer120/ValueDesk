@echo off
rem ============================================================================
rem  ValueDesk - the live test suite on every target, with real money
rem  (README.md in this folder, "Start here").
rem
rem  Double-click this file, or run it in a terminal:
rem      START-LIVE-TESTS.cmd              the real run: self, self with a Hyperliquid
rem                                        leader (when its key is set), hosted, browser
rem      START-LIVE-TESTS.cmd --dry        everything on paper (no funds, no keys)
rem      START-LIVE-TESTS.cmd --status     the progress of the run going on
rem      START-LIVE-TESTS.cmd --help       every option
rem
rem  Run it again to resume: what passed on this code is not run again.
rem  Ctrl+C once stops safely (the running part cleans up first): wait for it.
rem
rem  This file only starts all.ts with Node. The keys stay in .env.live, which
rem  the runner reads itself; nothing here reads or prints them.
rem ============================================================================
setlocal
title ValueDesk - live tests

cd /d "%~dp0..\..\..\.." 2>nul
if errorlevel 1 goto nofolder
if not exist "apps\executor\tools\live-test\all.ts" goto nofolder

rem Node: the newest one unpacked under %LOCALAPPDATA%\ddx-tools, else the one on PATH.
set "VS_NODE="
for /d %%D in ("%LOCALAPPDATA%\ddx-tools\node-v*-win-x64") do if exist "%%~fD\node.exe" set "VS_NODE=%%~fD\node.exe"
if not defined VS_NODE for /f "delims=" %%N in ('where node 2^>nul') do if not defined VS_NODE set "VS_NODE=%%N"
if not defined VS_NODE goto nonode

if not exist "node_modules\tsx\package.json" goto nopackages

"%VS_NODE%" --import tsx apps\executor\tools\live-test\all.ts %*
set "VS_EXIT=%ERRORLEVEL%"
goto done

:nofolder
echo.
echo  apps\executor\tools\live-test\all.ts was not found from here. Run this file
echo  from its own folder in the ValueDesk repository.
set "VS_EXIT=2"
goto done

:nonode
echo.
echo  Node.js was not found on this computer (neither under %LOCALAPPDATA%\ddx-tools
echo  nor on PATH). Install Node.js 22.13 or newer from https://nodejs.org and run
echo  this file again.
set "VS_EXIT=2"
goto done

:nopackages
echo.
echo  The project's packages are not installed yet.
echo  Open a terminal in the repository folder and run:   npm install
echo  Then run this file again.
set "VS_EXIT=2"
goto done

:done
echo.
set "VS_PAUSE=1"
for %%A in (%*) do if /i "%%~A"=="--no-pause" set "VS_PAUSE="
if defined VS_PAUSE pause
endlocal & exit /b %VS_EXIT%

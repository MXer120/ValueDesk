@echo off
rem ============================================================================
rem  ValueDesk - the hedge bot's two-wallet pair, live (hedge-pair.ts in this
rem  folder). Works from any folder; double-click shows the plan only.
rem
rem      START-HEDGE-PAIR.cmd               the plan: sizes, buffers, fees (nothing signed or sent)
rem      START-HEDGE-PAIR.cmd go            start the BTC pair (wallet A main, wallet B second leg)
rem      START-HEDGE-PAIR.cmd status        watch the pair, every 60 s (read-only, Ctrl+C ends the watch)
rem      START-HEDGE-PAIR.cmd stop          stop the pair: both legs close
rem      START-HEDGE-PAIR.cmd go "BTC,ETH"        other markets of the run (BTC ETH ZEC HYPE), in quotes
rem
rem  This file only starts hedge-pair.ts with Node. The keys stay in .env.live,
rem  which the tool reads itself; nothing here reads or prints them.
rem ============================================================================
setlocal
title ValueDesk - hedge pair

set "VS_HERE=%~dp0"
cd /d "%~dp0..\..\..\.." 2>nul
if errorlevel 1 goto nofolder
if not exist "apps\executor\tools\live-test\hedge-pair.ts" goto nofolder

rem .env.live: next to this file, else the main checkout's (this file in a worktree under .claude\worktrees).
set "VS_ENV=%VS_HERE%.env.live"
if not exist "%VS_ENV%" set "VS_ENV=%CD%\..\..\..\apps\executor\tools\live-test\.env.live"
if not exist "%VS_ENV%" goto noenv

rem Node: the newest one unpacked under %LOCALAPPDATA%\ddx-tools, else the one on PATH.
set "VS_NODE="
for /d %%D in ("%LOCALAPPDATA%\ddx-tools\node-v*-win-x64") do if exist "%%~fD\node.exe" set "VS_NODE=%%~fD\node.exe"
if not defined VS_NODE for /f "delims=" %%N in ('where node 2^>nul') do if not defined VS_NODE set "VS_NODE=%%N"
if not defined VS_NODE goto nonode
if not exist "node_modules\tsx\package.json" goto nopackages

set "VS_COINS=%~2"
if not defined VS_COINS set "VS_COINS=BTC"
set "VS_ARGS=--only %VS_COINS%"
if /i "%~1"=="go" set "VS_ARGS=--only %VS_COINS% --go"
if /i "%~1"=="status" set "VS_ARGS=--status --watch 60 --events"
if /i "%~1"=="stop" set "VS_ARGS=--stop"

"%VS_NODE%" --import tsx apps\executor\tools\live-test\hedge-pair.ts --env "%VS_ENV%" %VS_ARGS%
set "VS_EXIT=%ERRORLEVEL%"
goto done

:nofolder
echo.
echo  apps\executor\tools\live-test\hedge-pair.ts was not found from here. Keep this
echo  file in its own folder in the ValueDesk repository.
set "VS_EXIT=2"
goto done

:noenv
echo.
echo  .env.live with the two test wallets' keys was not found, next to this file or
echo  in the main checkout's apps\executor\tools\live-test folder.
set "VS_EXIT=2"
goto done

:nonode
echo.
echo  Node.js was not found on this computer (neither under %LOCALAPPDATA%\ddx-tools
echo  nor on PATH). Install Node.js 22.13 or newer from https://nodejs.org.
set "VS_EXIT=2"
goto done

:nopackages
echo.
echo  The project's packages are not installed yet. Open a terminal in the
echo  repository folder and run:   npm install
set "VS_EXIT=2"
goto done

:done
endlocal & exit /b %VS_EXIT%

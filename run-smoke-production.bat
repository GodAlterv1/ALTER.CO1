@echo off
REM Double-click this file, or run from cmd, to smoke-test production.
cd /d "%~dp0"

set "SMOKE_BASE_URL=https://alter-co.onrender.com"

where npm >nul 2>&1
if %ERRORLEVEL% EQU 0 goto run
if exist "%ProgramFiles%\nodejs\npm.cmd" (
  set "PATH=%ProgramFiles%\nodejs;%PATH%"
  goto run
)
if exist "%LocalAppData%\Programs\node\npm.cmd" (
  set "PATH=%LocalAppData%\Programs\node;%PATH%"
  goto run
)

echo.
echo Node.js / npm not found. Install Node LTS from https://nodejs.org
echo Or use GitHub: Actions -^> "Smoke test (production)" -^> Run workflow
echo.
pause
exit /b 1

:run
echo Running smoke against %SMOKE_BASE_URL% ...
call npm run smoke
echo.
pause

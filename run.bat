@echo off
setlocal
cd /d "%~dp0"

where node >nul 2>&1
if errorlevel 1 (
  echo [Vibe Wrangler] Node.js was not found on your PATH. Install Node 22 or newer: https://nodejs.org
  exit /b 1
)

where claude >nul 2>&1
if errorlevel 1 (
  echo [Vibe Wrangler] Warning: the Claude CLI was not found on your PATH.
  echo               The app will run, but the agent will not be able to start.
  echo.
)

rem 5000 is Vibe Wrangler's port (see c:\github\apps.json). It is where the board has always
rem actually run -- a machine-wide PORT=5000 beat the old 3000 default -- and 3000 now belongs
rem to house_dreamer, so leaving it as the fallback was a collision waiting to happen.
if "%PORT%"=="" set PORT=5000

echo [Vibe Wrangler] starting on http://localhost:%PORT%
start "" "http://localhost:%PORT%"
node --no-warnings=ExperimentalWarning server.js

endlocal

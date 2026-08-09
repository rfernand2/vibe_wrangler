@echo off
setlocal
cd /d "%~dp0"

where node >nul 2>&1
if errorlevel 1 (
  echo [llm_tasks] Node.js was not found on your PATH. Install Node 22 or newer: https://nodejs.org
  exit /b 1
)

where claude >nul 2>&1
if errorlevel 1 (
  echo [llm_tasks] Warning: the Claude CLI was not found on your PATH.
  echo               The app will run, but the agent will not be able to start.
  echo.
)

if "%PORT%"=="" set PORT=3000

echo [llm_tasks] starting on http://localhost:%PORT%
start "" "http://localhost:%PORT%"
node --no-warnings=ExperimentalWarning server.js

endlocal

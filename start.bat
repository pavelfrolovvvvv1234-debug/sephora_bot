@echo off
REM Quick start script for Windows
echo ============================================
echo   Sephora Host Bot - Quick Start
echo ============================================
echo.

REM Check if .env exists
if not exist .env (
    echo [ERROR] .env file not found!
    echo Please create .env file with required variables.
    echo See README.md for details.
    pause
    exit /b 1
)

REM Check if node_modules exists
if not exist node_modules (
    echo [INFO] Installing dependencies...
    call npm install
    if errorlevel 1 (
        echo [ERROR] Failed to install dependencies
        pause
        exit /b 1
    )
)

REM Check Node.js version
echo [INFO] Checking Node.js version...
node --version
if errorlevel 1 (
    echo [ERROR] Node.js not found! Please install Node.js 18+.
    pause
    exit /b 1
)

echo.
echo [INFO] Starting bot in development mode...
echo [INFO] Press Ctrl+C to stop
echo.

REM Start bot with nodemon (old code by default)
call npm run dev

pause

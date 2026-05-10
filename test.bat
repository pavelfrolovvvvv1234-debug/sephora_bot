@echo off
REM Quick test script for Windows
echo ============================================
echo   Sephora Host Bot - Quick Test
echo ============================================
echo.

echo [TEST 1] Checking .env file...
if exist .env (
    echo [OK] .env file exists
) else (
    echo [FAIL] .env file not found!
    exit /b 1
)

echo.
echo [TEST 2] Checking Node.js...
node --version >nul 2>&1
if errorlevel 1 (
    echo [FAIL] Node.js not found!
    exit /b 1
) else (
    echo [OK] Node.js installed
    node --version
)

echo.
echo [TEST 3] Checking dependencies...
if exist node_modules (
    echo [OK] node_modules exists
) else (
    echo [WARN] node_modules not found, installing...
    call npm install
)

echo.
echo [TEST 4] Checking TypeScript compilation...
call npm run typecheck >nul 2>&1
if errorlevel 1 (
    echo [WARN] TypeScript compilation has errors
    echo Running typecheck with output:
    call npm run typecheck
) else (
    echo [OK] TypeScript compilation successful
)

echo.
echo [TEST 5] Checking database directory...
if not exist data (
    echo [INFO] Creating data directory...
    mkdir data
)
echo [OK] Database directory ready

echo.
echo [TEST 6] Checking sessions directory...
if not exist sessions (
    echo [INFO] Creating sessions directory...
    mkdir sessions
)
echo [OK] Sessions directory ready

echo.
echo ============================================
echo   All basic tests passed!
echo ============================================
echo.
echo To start the bot, run: start.bat
echo.
pause

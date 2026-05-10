# Скрипт автоматического деплоя на VPS (PowerShell)
# Использование: .\deploy.ps1

$ErrorActionPreference = "Stop"

Write-Host "🚀 Начинаем деплой бота на VPS..." -ForegroundColor Green
Write-Host ""

# Проверка что мы в правильной директории
if (-not (Test-Path "package.json")) {
    Write-Host "❌ Ошибка: package.json не найден. Запустите скрипт из корня проекта." -ForegroundColor Red
    exit 1
}

# Проверка что .env существует
if (-not (Test-Path ".env")) {
    Write-Host "⚠️  .env файл не найден. Создайте его перед деплоем." -ForegroundColor Yellow
    $response = Read-Host "Продолжить без .env? (y/n)"
    if ($response -ne "y" -and $response -ne "Y") {
        exit 1
    }
}

Write-Host "📦 Шаг 1: Проверка зависимостей..." -ForegroundColor Green

# Проверка Node.js
try {
    $nodeVersion = node -v
    Write-Host "✅ Node.js: $nodeVersion" -ForegroundColor Green
} catch {
    Write-Host "❌ Node.js не установлен. Установите Node.js 20+" -ForegroundColor Red
    exit 1
}

# Проверка npm
try {
    $npmVersion = npm -v
    Write-Host "✅ npm: $npmVersion" -ForegroundColor Green
} catch {
    Write-Host "❌ npm не установлен." -ForegroundColor Red
    exit 1
}

# Проверка PM2
$usePm2 = $false
try {
    $pm2Version = pm2 -v
    Write-Host "✅ PM2: $pm2Version" -ForegroundColor Green
    $usePm2 = $true
} catch {
    Write-Host "⚠️  PM2 не установлен. Установите: npm install -g pm2" -ForegroundColor Yellow
    $response = Read-Host "Продолжить без PM2? (y/n)"
    if ($response -ne "y" -and $response -ne "Y") {
        exit 1
    }
}

Write-Host ""
Write-Host "📥 Шаг 2: Получение последних изменений из Git..." -ForegroundColor Green

# Проверка Git
if (Get-Command git -ErrorAction SilentlyContinue) {
    if (Test-Path ".git") {
        try {
            git pull origin main
        } catch {
            try {
                git pull origin master
            } catch {
                Write-Host "⚠️  Не удалось получить изменения из Git" -ForegroundColor Yellow
            }
        }
    } else {
        Write-Host "⚠️  Это не Git репозиторий" -ForegroundColor Yellow
    }
} else {
    Write-Host "⚠️  Git не установлен" -ForegroundColor Yellow
}

Write-Host ""
Write-Host "📦 Шаг 3: Установка зависимостей..." -ForegroundColor Green
npm install

if ($LASTEXITCODE -ne 0) {
    Write-Host "❌ Ошибка при установке зависимостей" -ForegroundColor Red
    exit 1
}

Write-Host ""
Write-Host "🔨 Шаг 4: Сборка проекта..." -ForegroundColor Green
npm run build

if ($LASTEXITCODE -ne 0) {
    Write-Host "❌ Ошибка при сборке проекта" -ForegroundColor Red
    exit 1
}

if (-not (Test-Path "dist") -or (Get-ChildItem "dist" -ErrorAction SilentlyContinue | Measure-Object).Count -eq 0) {
    Write-Host "❌ Ошибка: Проект не собран. Проверьте dist/ директорию." -ForegroundColor Red
    exit 1
}

Write-Host "✅ Проект успешно собран" -ForegroundColor Green

Write-Host ""
Write-Host "📁 Шаг 5: Создание необходимых директорий..." -ForegroundColor Green
New-Item -ItemType Directory -Force -Path "data", "sessions", "logs" | Out-Null

Write-Host ""
Write-Host "🚀 Шаг 6: Запуск бота..." -ForegroundColor Green

if ($usePm2) {
    # Проверяем есть ли уже запущенный процесс
    $pm2List = pm2 list 2>&1
    if ($pm2List -match "sephora-host-bot") {
        Write-Host "⚠️  Бот уже запущен. Перезапускаем..." -ForegroundColor Yellow
        pm2 restart sephora-host-bot
    } else {
        Write-Host "✅ Запускаем новый процесс..." -ForegroundColor Green
        pm2 start ecosystem.config.js
        pm2 save
    }
    
    Write-Host "✅ Бот запущен через PM2" -ForegroundColor Green
    Write-Host ""
    Write-Host "📊 Статус:" -ForegroundColor Yellow
    pm2 status
    
    Write-Host ""
    Write-Host "📋 Полезные команды:" -ForegroundColor Green
    Write-Host "  pm2 logs sephora-host-bot          # Просмотр логов" -ForegroundColor Gray
    Write-Host "  pm2 monit                          # Мониторинг" -ForegroundColor Gray
    Write-Host "  pm2 restart sephora-host-bot       # Перезапуск" -ForegroundColor Gray
    Write-Host "  pm2 stop sephora-host-bot          # Остановка" -ForegroundColor Gray
} else {
    Write-Host "⚠️  PM2 не используется. Запустите бота вручную:" -ForegroundColor Yellow
    Write-Host "  npm start" -ForegroundColor Gray
    Write-Host "  или" -ForegroundColor Gray
    Write-Host "  node dist/index.js" -ForegroundColor Gray
}

Write-Host ""
Write-Host "🎉 Деплой завершен!" -ForegroundColor Green
Write-Host ""
Write-Host "📋 Следующие шаги:" -ForegroundColor Yellow
    Write-Host "  1. Проверьте логи: pm2 logs sephora-host-bot" -ForegroundColor Gray
Write-Host "  2. Проверьте статус: pm2 status" -ForegroundColor Gray
Write-Host "  3. Протестируйте бота в Telegram" -ForegroundColor Gray
Write-Host ""

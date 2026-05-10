#!/bin/bash

# Скрипт автоматического деплоя на VPS
# Использование: ./deploy.sh

set -e  # Остановить при ошибке

echo "🚀 Начинаем деплой бота на VPS..."

# Цвета для вывода
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m' # No Color

# Проверка что мы в правильной директории
if [ ! -f "package.json" ]; then
    echo -e "${RED}❌ Ошибка: package.json не найден. Запустите скрипт из корня проекта.${NC}"
    exit 1
fi

# Проверка что .env существует
if [ ! -f ".env" ]; then
    echo -e "${YELLOW}⚠️  .env файл не найден. Создайте его перед деплоем.${NC}"
    read -p "Продолжить без .env? (y/n): " -n 1 -r
    echo
    if [[ ! $REPLY =~ ^[Yy]$ ]]; then
        exit 1
    fi
fi

echo -e "${GREEN}📦 Шаг 1: Проверка зависимостей...${NC}"

# Проверка Node.js
if ! command -v node &> /dev/null; then
    echo -e "${RED}❌ Node.js не установлен. Установите Node.js 20+${NC}"
    exit 1
fi

NODE_VERSION=$(node -v | cut -d'v' -f2 | cut -d'.' -f1)
if [ "$NODE_VERSION" -lt 18 ]; then
    echo -e "${RED}❌ Требуется Node.js 18+. Текущая версия: $(node -v)${NC}"
    exit 1
fi

echo -e "${GREEN}✅ Node.js: $(node -v)${NC}"

# Проверка npm
if ! command -v npm &> /dev/null; then
    echo -e "${RED}❌ npm не установлен.${NC}"
    exit 1
fi

echo -e "${GREEN}✅ npm: $(npm -v)${NC}"

# Проверка PM2 (если используется)
USE_PM2=true
if ! command -v pm2 &> /dev/null; then
    echo -e "${YELLOW}⚠️  PM2 не установлен. Установите: npm install -g pm2${NC}"
    read -p "Продолжить без PM2? (y/n): " -n 1 -r
    echo
    if [[ ! $REPLY =~ ^[Yy]$ ]]; then
        exit 1
    fi
    USE_PM2=false
fi

if [ "$USE_PM2" = true ]; then
    echo -e "${GREEN}✅ PM2: $(pm2 -v)${NC}"
fi

echo -e "${GREEN}📥 Шаг 2: Получение последних изменений из Git...${NC}"

# Проверка Git
if command -v git &> /dev/null; then
    if [ -d ".git" ]; then
        git pull origin main || git pull origin master || echo -e "${YELLOW}⚠️  Не удалось получить изменения из Git${NC}"
    else
        echo -e "${YELLOW}⚠️  Это не Git репозиторий${NC}"
    fi
else
    echo -e "${YELLOW}⚠️  Git не установлен${NC}"
fi

echo -e "${GREEN}📦 Шаг 3: Установка зависимостей...${NC}"
npm install

echo -e "${GREEN}🔨 Шаг 4: Сборка проекта...${NC}"
npm run build

if [ ! -d "dist" ] || [ -z "$(ls -A dist)" ]; then
    echo -e "${RED}❌ Ошибка: Проект не собран. Проверьте dist/ директорию.${NC}"
    exit 1
fi

echo -e "${GREEN}✅ Проект успешно собран${NC}"

echo -e "${GREEN}📁 Шаг 5: Создание необходимых директорий...${NC}"
mkdir -p data sessions logs
chmod 755 data sessions logs

echo -e "${GREEN}🚀 Шаг 6: Запуск бота...${NC}"

if [ "$USE_PM2" = true ]; then
    # Проверяем есть ли уже запущенный процесс
    if pm2 list | grep -q "sephora-host-bot"; then
        echo -e "${YELLOW}⚠️  Бот уже запущен. Перезапускаем...${NC}"
        pm2 restart sephora-host-bot
    else
        echo -e "${GREEN}✅ Запускаем новый процесс...${NC}"
        pm2 start ecosystem.config.js
        pm2 save
    fi
    
    echo -e "${GREEN}✅ Бот запущен через PM2${NC}"
    echo -e "${YELLOW}📊 Статус:${NC}"
    pm2 status
    
    echo ""
    echo -e "${GREEN}📋 Полезные команды:${NC}"
    echo "  pm2 logs sephora-host-bot          # Просмотр логов"
    echo "  pm2 monit                          # Мониторинг"
    echo "  pm2 restart sephora-host-bot       # Перезапуск"
    echo "  pm2 stop sephora-host-bot          # Остановка"
else
    echo -e "${YELLOW}⚠️  PM2 не используется. Запустите бота вручную:${NC}"
    echo "  npm start"
    echo "  или"
    echo "  node dist/index.js"
fi

echo ""
echo -e "${GREEN}🎉 Деплой завершен!${NC}"
echo ""
echo -e "${YELLOW}📋 Следующие шаги:${NC}"
echo "  1. Проверьте логи: pm2 logs sephora-host-bot"
echo "  2. Проверьте статус: pm2 status"
echo "  3. Протестируйте бота в Telegram"
echo ""

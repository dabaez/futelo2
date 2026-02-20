#!/usr/bin/env bash
# deploy.sh – run this on the Ubuntu droplet after cloning the repo
# Usage: bash deploy.sh

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")" && pwd)"
WEB_DIR="/var/www/futelo/dist"
NGINX_CONF="/etc/nginx/sites-available/futelo"
NGINX_LINK="/etc/nginx/sites-enabled/futelo"

echo "==> Installing backend dependencies…"
cd "$REPO_ROOT/backend"
npm ci --omit=dev

echo "==> Installing & building frontend…"
cd "$REPO_ROOT/frontend"
npm ci
npm run build

echo "==> Deploying frontend to $WEB_DIR…"
sudo mkdir -p "$WEB_DIR"
sudo cp -r dist/. "$WEB_DIR/"

echo "==> Installing Nginx config…"
sudo cp "$REPO_ROOT/nginx/futelo.conf" "$NGINX_CONF"
if [ ! -L "$NGINX_LINK" ]; then
  sudo ln -s "$NGINX_CONF" "$NGINX_LINK"
fi
sudo nginx -t && sudo systemctl reload nginx

echo "==> Launching backend with PM2…"
cd "$REPO_ROOT/backend"
if ! command -v pm2 &>/dev/null; then
  sudo npm install -g pm2
fi
pm2 delete futelo-backend 2>/dev/null || true
pm2 start src/server.js --name futelo-backend --max-memory-restart 400M
pm2 save

echo ""
echo "==> Done! Futelo is live."
echo "    Remember to copy backend/.env.example → backend/.env and fill in your secrets."

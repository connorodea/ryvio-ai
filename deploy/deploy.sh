#!/usr/bin/env bash
set -euo pipefail

APP_DIR="/var/www/ryvio-ai"
SERVICE_NAME="ryvio-ai"

echo "==> Deploying $SERVICE_NAME..."

cd "$APP_DIR"

# Detect package manager
if [ -f "pnpm-lock.yaml" ]; then
  PM="pnpm"
elif [ -f "package-lock.json" ]; then
  PM="npm"
elif [ -f "yarn.lock" ]; then
  PM="yarn"
else
  echo "ERROR: No lockfile found"
  exit 1
fi

echo "==> Installing dependencies with $PM..."
if [ "$PM" = "npm" ]; then
  npm ci --omit=dev
elif [ "$PM" = "pnpm" ]; then
  pnpm install --frozen-lockfile --prod
else
  yarn install --frozen-lockfile --production
fi

echo "==> Restarting $SERVICE_NAME..."
systemctl restart "$SERVICE_NAME"

echo "==> Checking service status..."
sleep 2
systemctl status "$SERVICE_NAME" --no-pager

echo "==> Deploy complete!"

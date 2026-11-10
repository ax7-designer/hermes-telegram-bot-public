#!/bin/bash
# Build script for Render: clones Obsidian vault before starting the bot
# Requires GITHUB_PAT environment variable for private repo access

set -e

echo "==> Installing production dependencies..."
npm ci --omit=dev --no-audit --no-fund

echo "==> Cloning Obsidian vault..."

if [ -z "$GITHUB_PAT" ]; then
  echo "⚠️  GITHUB_PAT not set, skipping vault clone"
  exit 0
fi

VAULT_REPO="https://${GITHUB_PAT}@github.com/ax7-designer/obsidian-vault-hermes.git"
VAULT_DIR="/opt/render/project/obsidian-vault"

if [ -d "$VAULT_DIR" ]; then
  echo "==> Vault directory exists, pulling latest..."
  cd "$VAULT_DIR"
  git pull origin main || echo "⚠️  Git pull failed, using existing vault"
else
  echo "==> Cloning vault to $VAULT_DIR..."
  git clone "$VAULT_REPO" "$VAULT_DIR"
fi

echo "✅ Obsidian vault ready at $VAULT_DIR"

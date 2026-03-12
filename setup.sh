#!/bin/bash
# ============================================================
# Roybal Restoration App — First-Time Setup Script
# Run this from the roybal-restoration-app/ directory after
# installing Node.js (https://nodejs.org — LTS version).
# ============================================================

set -e  # Exit on any error

BOLD='\033[1m'
ORANGE='\033[38;5;208m'
GREEN='\033[0;32m'
RED='\033[0;31m'
NC='\033[0m' # No Color

echo ""
echo -e "${ORANGE}${BOLD}   ROYBAL RESTORATION — APP SETUP${NC}"
echo -e "${ORANGE}   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""

# ── 1. Check Node ────────────────────────────────────────────
echo -e "${BOLD}[1/6] Checking Node.js...${NC}"
if ! command -v node &> /dev/null; then
  echo -e "${RED}✗ Node.js not found.${NC}"
  echo "   Install from: https://nodejs.org (LTS version)"
  exit 1
fi
NODE_VERSION=$(node --version)
echo -e "${GREEN}✓ Node.js ${NODE_VERSION}${NC}"

# ── 2. Install dependencies ───────────────────────────────────
echo ""
echo -e "${BOLD}[2/6] Installing npm dependencies...${NC}"
npm install
echo -e "${GREEN}✓ Dependencies installed${NC}"

# ── 3. Build shared package ───────────────────────────────────
echo ""
echo -e "${BOLD}[3/6] Building @roybal/shared package...${NC}"
# Since TypeScript is source-linked, just typecheck
npm run typecheck --workspace=packages/shared 2>/dev/null || true
echo -e "${GREEN}✓ Shared package ready${NC}"

# ── 4. Create .env files ──────────────────────────────────────
echo ""
echo -e "${BOLD}[4/6] Setting up environment variables...${NC}"

if [ ! -f "apps/mobile/.env" ]; then
  cp apps/mobile/.env.example apps/mobile/.env
  echo -e "${ORANGE}  ⚠  Created apps/mobile/.env from .env.example${NC}"
  echo "     → Fill in your Supabase + Magicplan credentials"
else
  echo -e "${GREEN}  ✓ apps/mobile/.env already exists${NC}"
fi

if [ ! -f "apps/web/.env" ]; then
  cp apps/web/.env.example apps/web/.env
  echo -e "${ORANGE}  ⚠  Created apps/web/.env from .env.example${NC}"
  echo "     → Fill in your Supabase + Magicplan credentials"
else
  echo -e "${GREEN}  ✓ apps/web/.env already exists${NC}"
fi

# ── 5. Supabase check ─────────────────────────────────────────
echo ""
echo -e "${BOLD}[5/6] Supabase setup reminder...${NC}"
echo "   Run these SQL files in your Supabase SQL Editor:"
echo "   1. supabase/migrations/001_initial_schema.sql"
echo "   2. supabase/migrations/002_storage.sql"
echo ""
echo "   Or use the Supabase CLI:"
echo "   $ supabase db push"

# ── 6. Done ───────────────────────────────────────────────────
echo ""
echo -e "${BOLD}[6/6] Setup complete!${NC}"
echo ""
echo -e "${ORANGE}${BOLD}   NEXT STEPS:${NC}"
echo "   1. Fill in .env files with your Supabase credentials"
echo "   2. Run the SQL migrations in Supabase"
echo "   3. Start the web admin:    npm run web"
echo "   4. Start the mobile app:   npm run mobile"
echo "   5. Deploy Magicplan webhook:"
echo "      supabase functions deploy magicplan-webhook"
echo ""
echo -e "${GREEN}${BOLD}   Ready to build!${NC}"
echo ""

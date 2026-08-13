#!/bin/bash
# ============================================================
# Roybal Construction App — First-Time Setup Script
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
echo -e "${ORANGE}${BOLD}   ROYBAL CONSTRUCTION — APP SETUP${NC}"
echo -e "${ORANGE}   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""

# ── 1. Check Node ────────────────────────────────────────────
echo -e "${BOLD}[1/4] Checking Node.js...${NC}"
if ! command -v node &> /dev/null; then
  echo -e "${RED}✗ Node.js not found.${NC}"
  echo "   Install from: https://nodejs.org (LTS version)"
  exit 1
fi
NODE_VERSION=$(node --version)
echo -e "${GREEN}✓ Node.js ${NODE_VERSION}${NC}"

# ── 2. Install dependencies ───────────────────────────────────
echo ""
echo -e "${BOLD}[2/4] Installing npm dependencies...${NC}"
npm install
echo -e "${GREEN}✓ Dependencies installed${NC}"

# ── 3. Create .env files ──────────────────────────────────────
echo ""
echo -e "${BOLD}[3/4] Setting up environment variables...${NC}"
echo "   The field, admin, and board apps are static — they read their"
echo "   Supabase config at runtime and need no .env here."

if [ ! -f "apps/site/.env" ]; then
  cp apps/site/.env.example apps/site/.env
  echo -e "${ORANGE}  ⚠  Created apps/site/.env from .env.example${NC}"
  echo "     → Fill in the values before running the marketing site"
else
  echo -e "${GREEN}  ✓ apps/site/.env already exists${NC}"
fi

# ── 4. Done ───────────────────────────────────────────────────
echo ""
echo -e "${BOLD}[4/4] Setup complete!${NC}"
echo ""
echo -e "${ORANGE}${BOLD}   NEXT STEPS:${NC}"
echo "   Start the field forms PWA:  npm run field"
echo "   Start the job board:        npm run board"
echo "   Start the marketing site:   npm run site"
echo ""
echo "   Run the field app's test suite:  npm run field:test"
echo ""
echo "   Supabase edge functions deploy with the Supabase CLI:"
echo "   $ supabase functions deploy <name>"
echo ""
echo -e "${GREEN}${BOLD}   Ready to build!${NC}"
echo ""

#!/bin/bash

# PHASE 1: VERIFY AND FIX ENVIRONMENT VARIABLES
# This script helps diagnose and fix missing environment variables on VPS

set -e

VPS_HOST="8.215.40.119"
VPS_USER="root"

echo "=========================================="
echo "PHASE 1: Environment Variable Diagnostic"
echo "=========================================="
echo ""

# Step 1: Check current env vars
echo "Step 1: Checking current environment variables on VPS..."
echo ""

ssh ${VPS_USER}@${VPS_HOST} << 'EOFDIAG'
echo "Current .env status:"
if [ -f /home/swift/.env ]; then
  echo "[FOUND] /home/swift/.env"
  echo ""
  echo "Critical variables currently set:"
  grep -E "DATABASE_URL|REDIS_URL|OPENROUTER_API_KEY|SANDBOX_SERVICE_TOKEN|NEXTAUTH_SECRET" /home/swift/.env | sed 's/=.*/=***/' || echo "[MISSING ALL]"
else
  echo "[MISSING] /home/swift/.env - This is the problem!"
fi

echo ""
echo "Checking PM2 services:"
pm2 list | grep -E "swift-worker|swift-sandbox|swift-web" || true
EOFDIAG

echo ""
echo "=========================================="
echo "Step 2: What you need to do"
echo "=========================================="
echo ""
echo "The 500 error is because swift-worker cannot find:"
echo "  ✗ REDIS_URL"
echo "  ✗ DATABASE_URL"
echo "  ✗ OPENROUTER_API_KEY"
echo ""
echo "Option A: Quick fix (run commands on VPS)"
echo "Option B: Create /home/swift/.env file with all variables"
echo ""
echo "Required variables to set:"
echo "  1. DATABASE_URL (from Neon dashboard)"
echo "  2. REDIS_URL (should be redis://localhost:6379)"
echo "  3. OPENROUTER_API_KEY (from your account)"
echo "  4. NEXTAUTH_SECRET (same as Vercel)"
echo "  5. GOOGLE_CLIENT_ID & GOOGLE_CLIENT_SECRET"
echo "  6. Supabase credentials (3 variables)"
echo "  7. SANDBOX_SERVICE_TOKEN (64-char hex)"
echo ""
echo "=========================================="
echo "Total: 12 CRITICAL variables needed"
echo "=========================================="
echo ""

#!/bin/bash

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

echo "======================================"
echo "Swift Reddy - Environment Variables Verification"
echo "======================================"
echo ""

# Check if on VPS
if [[ ! -f ~/.ssh/id_rsa ]]; then
  echo "⚠️  This script should run ON THE VPS server"
  echo "Usage: ssh root@8.215.40.119, then run this script"
  exit 1
fi

# Source the env file
if [ -f /home/swift/.env ]; then
  source /home/swift/.env
  echo -e "${GREEN}✓ Found .env file${NC}"
else
  echo -e "${RED}✗ No .env file found at /home/swift/.env${NC}"
  exit 1
fi

echo ""
echo "Checking Critical Variables..."
echo "======================================"

# Function to check env var
check_env() {
  local var_name=$1
  local var_value=${!var_name}
  
  if [ -z "$var_value" ]; then
    echo -e "${RED}✗ $var_name: MISSING${NC}"
    return 1
  elif [[ "$var_value" == *"<"* ]] || [[ "$var_value" == *"placeholder"* ]]; then
    echo -e "${YELLOW}⚠ $var_name: Placeholder value${NC}"
    return 1
  else
    # Show first 20 chars only for security
    echo -e "${GREEN}✓ $var_name: ${var_value:0:20}...${NC}"
    return 0
  fi
}

# Critical variables
CRITICAL_VARS=(
  "DATABASE_URL"
  "REDIS_URL"
  "OPENROUTER_API_KEY"
  "AI_GATEWAY_API_KEY"
  "GOOGLE_CLIENT_ID"
  "GOOGLE_CLIENT_SECRET"
)

MISSING=0
for var in "${CRITICAL_VARS[@]}"; do
  check_env "$var" || ((MISSING++))
done

echo ""
echo "======================================"
if [ $MISSING -eq 0 ]; then
  echo -e "${GREEN}✓ All critical variables are set!${NC}"
else
  echo -e "${RED}✗ Missing $MISSING critical variables${NC}"
fi
echo "======================================"

echo ""
echo "Service Status:"
echo "======================================"
pm2 list

echo ""
echo "To fix missing variables:"
echo "1. Edit: nano /home/swift/.env"
echo "2. Add missing variables"
echo "3. Save and exit (Ctrl+X, Y, Enter)"
echo "4. Restart services: pm2 restart all"
echo ""

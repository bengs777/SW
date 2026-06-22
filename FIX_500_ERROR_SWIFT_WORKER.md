# Fix 500 Error - Swift Worker Issue

## Problem
- Clicking "Langkukan Prompt" returns **500 error**
- Browser console shows: `Failed to load resource: the server responded with a status of 500`
- Services are running but generating errors

## Root Cause
The issue is in the **queue health check** at `/app/api/generate/jobs/route.ts`. The queue health is failing because:

1. **Redis connection error** - Queue cannot connect to Redis
2. **Database connection error** - Queue cannot connect to database
3. **Worker not responding** - swift-worker service is not processing jobs

## Solution: 3 Quick Checks

### Step 1: Verify Redis Connection on VPS
```bash
ssh root@8.215.40.119

# Check if Redis is running
redis-cli ping
# Should return: PONG

# Check Redis connection string
echo $REDIS_URL
# Should show: redis://localhost:6379 or similar

# Test connection
redis-cli -u $REDIS_URL ping
```

**If REDIS_URL is empty or redis-cli fails:**
- Set `REDIS_URL` in `/home/swift/.env`
- Restart services: `pm2 restart all`

---

### Step 2: Verify Database Connection on VPS
```bash
ssh root@8.215.40.119

# Check database URL
echo $DATABASE_URL
# Should show valid connection string

# Test connection (using psql if available)
psql $DATABASE_URL -c "SELECT 1"
# Should return: (1 row)
```

**If DATABASE_URL is empty or connection fails:**
- Set `DATABASE_URL` in `/home/swift/.env`
- Restart services: `pm2 restart all`

---

### Step 3: Check Swift-Worker Logs
```bash
ssh root@8.215.40.119

# View worker logs (last 100 lines)
pm2 logs swift-worker --lines 100

# Look for errors like:
# - "Redis connection failed"
# - "Database connection error"  
# - "ECONNREFUSED"
# - "Cannot find module"
```

---

## Manual Quick Fix

If you can SSH to VPS directly:

```bash
ssh root@8.215.40.119

# Go to app directory
cd /home/swift/reddy

# Check .env file
cat .env | grep -E "REDIS|DATABASE"

# If missing or wrong, edit it
nano .env

# Add/verify these lines:
# REDIS_URL=redis://localhost:6379
# DATABASE_URL=<your_neon_or_db_connection_string>

# Save and exit (Ctrl+X, Y, Enter)

# Restart all services
pm2 restart all

# Wait 10 seconds
sleep 10

# Check status
pm2 list
```

---

## Test the Fix

### Via Browser
1. Go to https://ai-swift.biz.id
2. Click "Langkukan Prompt"
3. Should see loading animation (not error)

### Via curl (from local machine)
```bash
curl -X POST https://ai-swift.biz.id/api/generate/jobs \
  -H "Content-Type: application/json" \
  -d '{
    "projectId": "test",
    "prompt": "test",
    "model": "gpt-4"
  }'
```

Should return 400-401 (auth error), not 500 (server error).

---

## If Still Getting 500 Error

### Check Environment Variables Completely
```bash
ssh root@8.215.40.119

# Show all env vars
pm2 show swift-worker | grep -A 50 "env"

# Or check the .env file directly
cat /home/swift/.env
```

### Restart Everything
```bash
ssh root@8.215.40.119

# Kill all
pm2 kill

# Wait 5 seconds
sleep 5

# Restart services
pm2 start ecosystem.config.cjs

# Check status
pm2 list
```

### Check Disk Space
```bash
ssh root@8.215.40.119

# Check disk usage
df -h

# Check memory
free -h

# If disk is full (>90%), clean up old logs:
pm2 flush
```

---

## Common 500 Errors & Fixes

| Error | Cause | Fix |
|-------|-------|-----|
| "Cannot connect to Redis" | Redis URL wrong/missing | Set `REDIS_URL` env var |
| "Cannot connect to database" | DB URL wrong/missing | Set `DATABASE_URL` env var |
| "Socket hang up" | Network issue | Restart service: `pm2 restart swift-worker` |
| "ENOENT: no such file" | File path wrong | Check file paths in code |
| "Out of memory" | Service using too much RAM | Increase VPS RAM or restart |

---

## Success Indicators

When fixed, you should see:

✅ No 500 error in browser console  
✅ "Langkukan Prompt" shows loading spinner  
✅ Generation starts (may take 10-30 seconds)  
✅ Code preview appears  

---

## Still Stuck?

If none of this works, provide:

```bash
# 1. PM2 List Output
pm2 list

# 2. Worker Logs (last 50 lines)
pm2 logs swift-worker --lines 50

# 3. Environment Variables
echo "Redis:" $REDIS_URL
echo "Database:" $DATABASE_URL
echo "API Gateway Key:" echo ${AI_GATEWAY_API_KEY:0:10}...

# 4. Disk & Memory Status
df -h
free -h

# 5. Network Check
curl -v https://ai-swift.biz.id/api/generate/jobs 2>&1 | head -30
```

Copy-paste all outputs and share them.

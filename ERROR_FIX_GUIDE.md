# Swift AI Website Error Fix - Complete Guide

## Status Summary
The website is showing "Failed to create generation job" errors. The investigation identified the root cause and provides solutions.

## What's Working ✅
- Database (Turso) - Configured correctly
- Authentication (Google OAuth) - Configured correctly
- Supabase Storage - Configured correctly
- OpenRouter AI - Configured correctly
- Sandbox Runtime - Configured correctly

## What's Broken ❌
- Generation Queue - Redis native connection not configured
- Generation Worker - Cannot start without Redis

## The Problem in Detail

### Error Flow
1. User tries to generate code using AI
2. Frontend makes POST request to `/api/generate/jobs`
3. API creates a database record for the job
4. API tries to enqueue the job to Redis queue
5. **FAILS**: Redis connection not available
6. API returns 503 error: "Generation queue is unavailable"
7. Frontend shows "Failed to create generation job"

### Root Cause
Swift AI requires a native TCP Redis connection (BullMQ library), but the environment only has Upstash REST API credentials configured. These are incompatible:

```
❌ What we have: REST API (UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN)
✅ What we need: Native Redis URL (REDIS_URL)
```

## How to Fix

### Option 1: Get Correct Upstash Native Redis Credentials (Recommended)

#### Step 1: Access Upstash Console
1. Go to https://console.upstash.com/redis
2. Log in with your Upstash account
3. Select your Redis instance: `true-mink-98071`

#### Step 2: Get Native Redis Connection String
1. Find the **Connect** tab
2. Look for **Redis CLI** section or **Native Redis Connection**
3. Copy the connection string (format: `redis://default:PASSWORD@hostname:port`)
4. This should look similar to:
   ```
   redis://default:xxxxxxxxxxxxxxx@true-mink-98071.upstash.io:31329
   ```

#### Step 3: Update .env File
1. Open `.env` file in your editor
2. Find the Redis section (lines 19-26)
3. Replace the REDIS_URL line with the correct credentials:
   ```env
   REDIS_URL=redis://default:YOUR_PASSWORD@true-mink-98071.upstash.io:31329
   ```

#### Step 4: Restart Application
```bash
# If you're running dev server:
# Press Ctrl+C to stop
# Then run:
npm run dev

# Or if deployed to Railway/Vercel:
# Trigger a redeployment to pick up the new .env
```

### Option 2: Use Local Redis for Development

If you can't access Upstash console immediately:

```bash
# Install Docker if you don't have it
# Then run Redis locally:
docker run -d -p 6379:6379 redis:latest

# Update .env:
REDIS_URL=redis://localhost:6379
```

### Option 3: Temporary Workaround (May Work)

The current `.env` already has an attempted REDIS_URL using the REST token as password. Try restarting the app first to see if it works. If not, you'll need Option 1 or 2.

## Verification Steps

After implementing the fix, verify it works:

1. **Check Application Starts**
   ```bash
   # Look for this in console output:
   # "[Generation Queue] Redis connected successfully"
   ```

2. **Test in Browser**
   - Go to dashboard
   - Create a new project
   - Try to generate code
   - Should NOT see "Failed to create generation job" error

3. **Check Generation Job Status**
   - Go to project dashboard
   - Look for job progress messages
   - Job should transition from "queued" → "running" → "completed"

4. **Check Logs for Errors**
   ```bash
   # Look for errors like:
   # - "ECONNREFUSED" = Redis host unreachable
   # - "WRONGPASS" = Incorrect Redis password
   # - "Generation worker completed" = Jobs are processing
   ```

## Troubleshooting

### Problem: Still getting "Failed to create generation job"

**Check 1: Is REDIS_URL set correctly?**
```bash
# In application logs/console, look for:
echo $REDIS_URL  # Should show your Redis URL
```

**Check 2: Can Redis be reached?**
```bash
# Try connecting directly (requires Redis CLI):
redis-cli -u "redis://default:PASSWORD@hostname:31329"
# Should see: 127.0.0.1:6379>
```

**Check 3: Is generation worker running?**
Look for in console:
```
"Generation worker started"
```
If not, check that `SWIFT_ENABLE_GENERATION_WORKER=true` in .env

### Problem: "ECONNREFUSED at redis://..."
- Redis server is not running or unreachable
- Check hostname and port are correct
- For Upstash: hostname must be `true-mink-98071.upstash.io`
- Default port for Upstash is `31329`

### Problem: "WRONGPASS" error
- The password in REDIS_URL is incorrect
- Get the correct password from Upstash console
- Don't use REST API token as password

### Problem: Jobs created but not processed
- Check `SWIFT_ENABLE_GENERATION_WORKER=true`
- Check generation worker is running
- Check application logs for worker errors
- May need worker running in separate process

## Quick Reference

### Environment Variables Needed
```env
# ✅ Already working
DATABASE_URL=libsql://...
TURSO_DATABASE_URL=libsql://...
TURSO_AUTH_TOKEN=...
NEXT_PUBLIC_SUPABASE_URL=https://...
SUPABASE_ANON_KEY=...
SUPABASE_SERVICE_ROLE_KEY=...
OPENROUTER_API_KEY=sk-or-v1-...
NEXTAUTH_SECRET=...
GOOGLE_CLIENT_ID=...
GOOGLE_CLIENT_SECRET=...

# ⚠️ Needs Fix
REDIS_URL=redis://default:PASSWORD@hostname:port

# ✅ Already set
UPSTASH_REDIS_REST_URL=https://...
UPSTASH_REDIS_REST_TOKEN=...
SWIFT_ENABLE_GENERATION_WORKER=true
```

## File Changes Made

The following files were updated to help diagnose and fix Redis issues:

1. **`lib/queue/generation-queue.ts`**
   - Added fallback to build Upstash native Redis URL
   - Better error handling and logging
   - Support for both native Redis and Upstash

2. **`.env`**
   - Added REDIS_URL attempt (may need correction)
   - Enabled generation worker

3. **`REDIS_SETUP.md`** (New file)
   - Detailed Redis setup instructions

4. **`ERROR_FIX_GUIDE.md`** (This file)
   - Complete troubleshooting guide

## Next Steps

1. **Immediate**: Get Redis credentials from Upstash console
2. **Update**: Modify REDIS_URL in .env with correct credentials
3. **Restart**: Restart the application
4. **Test**: Try generating code in dashboard
5. **Monitor**: Check logs for "Generation job completed" message

## Support Resources

- Upstash Dashboard: https://console.upstash.com/
- Upstash Docs: https://upstash.com/docs/redis/
- BullMQ Docs: https://docs.bullmq.io/
- Swift AI GitHub: Check repository for additional documentation

---

**Need more help?** Check the application console for detailed error messages. They usually indicate:
- Connection refused → Redis not reachable
- Wrong password → Incorrect credentials
- Queue unavailable → REDIS_URL not set

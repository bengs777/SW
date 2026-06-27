# URGENT FIX: 500 Error - Swift Worker Environment Variables

## THE PROBLEM

Your swift-worker service is crashing with 500 errors because **environment variables are not set on the VPS**.

The service tries to connect to Redis and Database, but can't find the connection strings.

## SOLUTION: 3 STEPS (15 minutes)

### STEP 1: SSH to VPS

```bash
ssh root@8.215.40.119
```

### STEP 2: Check Current Status

```bash
# See what .env file exists
ls -la /home/swift/.env

# Check PM2 worker status and errors
pm2 show swift-worker

# See the actual error
pm2 logs swift-worker --lines 50
```

**Expected output**: Either `.env` doesn't exist, OR it's missing critical variables.

### STEP 3: Create/Update .env File

**Option A: Using nano editor**

```bash
nano /home/swift/.env
```

Then paste ALL of these (update with YOUR actual values):

```
# Database - FROM NEON DASHBOARD
NODE_ENV=production
DATABASE_URL=postgresql://user:password@host.neon.tech/dbname?sslmode=require&pooler_mode=transaction

# Redis - Most likely this (check if Redis is running: redis-cli ping)
REDIS_URL=redis://localhost:6379

# NextAuth - SAME AS VERCEL
NEXTAUTH_SECRET=<your-32-char-secret-from-vercel>
NEXTAUTH_URL=https://ai-swift.biz.id

# Google OAuth - FROM GOOGLE CONSOLE
GOOGLE_CLIENT_ID=xxxxx.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=GOCSPX-xxxxxxxxxxxxx

# Supabase - FROM SUPABASE DASHBOARD
NEXT_PUBLIC_SUPABASE_URL=https://xxxx.supabase.co
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_DEFAULT_KEY=eyJ...
SUPABASE_SERVICE_ROLE_KEY=eyJ...
SUPABASE_STORAGE_BUCKET=swift-artifacts

# OpenRouter AI API
OPENROUTER_API_KEY=sk-or-v1-xxxxxxxxxxxxx

# Sandbox Configuration
SANDBOX_SERVICE_URL=https://sandbox.ai-swift.biz.id
SANDBOX_SERVICE_TOKEN=<64-char-hex-token>
SANDBOX_PUBLIC_BASE_URL=https://sandbox.ai-swift.biz.id
SWIFT_WORKER_HEALTH_URL=https://sandbox.ai-swift.biz.id/worker/health

# Sandbox Runtime Tuning
SWIFT_SANDBOX_ROOT=/data/swift-sandbox
SWIFT_SANDBOX_MAX_PROJECTS=12
SWIFT_SANDBOX_MAX_FILES=240
SWIFT_SANDBOX_MAX_TOTAL_BYTES=6291456
SWIFT_SANDBOX_PROJECT_IDLE_TTL_MS=1800000
SWIFT_SANDBOX_PROCESS_MAX_UPTIME_MS=1200000
```

After pasting:
1. Press **Ctrl+X** to exit
2. Press **Y** to confirm save
3. Press **Enter** to accept filename

**Option B: Using echo (one-liner)**

If you know all values, use this to create the file directly:

```bash
cat > /home/swift/.env << 'EOF'
NODE_ENV=production
DATABASE_URL=postgresql://user:password@host.neon.tech/dbname?sslmode=require&pooler_mode=transaction
REDIS_URL=redis://localhost:6379
NEXTAUTH_SECRET=your-secret-here
NEXTAUTH_URL=https://ai-swift.biz.id
GOOGLE_CLIENT_ID=xxxxx.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=GOCSPX-xxxxxxxxxxxxx
NEXT_PUBLIC_SUPABASE_URL=https://xxxx.supabase.co
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_DEFAULT_KEY=eyJ...
SUPABASE_SERVICE_ROLE_KEY=eyJ...
SUPABASE_STORAGE_BUCKET=swift-artifacts
OPENROUTER_API_KEY=sk-or-v1-xxxxxxxxxxxxx
SANDBOX_SERVICE_URL=https://sandbox.ai-swift.biz.id
SANDBOX_SERVICE_TOKEN=64-char-hex-token
SANDBOX_PUBLIC_BASE_URL=https://sandbox.ai-swift.biz.id
SWIFT_WORKER_HEALTH_URL=https://sandbox.ai-swift.biz.id/worker/health
SWIFT_SANDBOX_ROOT=/data/swift-sandbox
SWIFT_SANDBOX_MAX_PROJECTS=12
SWIFT_SANDBOX_MAX_FILES=240
SWIFT_SANDBOX_MAX_TOTAL_BYTES=6291456
SWIFT_SANDBOX_PROJECT_IDLE_TTL_MS=1800000
SWIFT_SANDBOX_PROCESS_MAX_UPTIME_MS=1200000
EOF
```

### STEP 4: Set File Permissions

```bash
chmod 600 /home/swift/.env
chown swift:swift /home/swift/.env
```

### STEP 5: Restart All Services

```bash
pm2 restart all
```

### STEP 6: Verify It's Working

```bash
# Check status
pm2 list

# Check logs for errors
pm2 logs swift-worker --lines 20

# Should see NO "REDIS" or "DATABASE" connection errors
```

### STEP 7: Test in Browser

1. Go to https://ai-swift.biz.id
2. Click "Langkukan Prompt"
3. It should work now!

If still getting 500:
```bash
# See actual error
pm2 logs swift-worker --lines 100

# Restart again
pm2 restart swift-worker
```

## WHERE TO GET THESE VALUES

| Variable | Where to find | Example |
|----------|--------------|---------|
| DATABASE_URL | Neon Dashboard → Connection string (pooled) | postgresql://user:pass@... |
| REDIS_URL | Your Redis server (usually localhost:6379) | redis://localhost:6379 |
| NEXTAUTH_SECRET | Vercel dashboard → Environment Variables | Must be 32+ chars |
| GOOGLE_CLIENT_ID | Google OAuth Console | xxx.apps.googleusercontent.com |
| GOOGLE_CLIENT_SECRET | Google OAuth Console | GOCSPX-xxx |
| NEXT_PUBLIC_SUPABASE_URL | Supabase Dashboard → Settings | https://xxx.supabase.co |
| NEXT_PUBLIC_SUPABASE_PUBLISHABLE_DEFAULT_KEY | Supabase Dashboard → Settings | eyJ... |
| SUPABASE_SERVICE_ROLE_KEY | Supabase Dashboard → Settings (different from above!) | eyJ... |
| OPENROUTER_API_KEY | OpenRouter Account → API Keys | sk-or-v1-xxx |
| SANDBOX_SERVICE_TOKEN | Generate random 64-char hex | $(openssl rand -hex 32) |

## TROUBLESHOOTING

**Still seeing 500 error?**

Check if redis-server is running:
```bash
redis-cli ping
# Should return: PONG
```

If not running:
```bash
systemctl start redis-server
# or
redis-server &
```

**PM2 service won't start?**

Check the full error:
```bash
pm2 show swift-worker
# Look at "error log file" and "out file"
tail -100 /path/to/error.log
```

**Database connection refuses?**

Test connection:
```bash
psql "postgresql://user:password@host.neon.tech/dbname?sslmode=require"
```

Should connect successfully.

**Still broken after 5 min?**

Send me:
1. Output of: `pm2 logs swift-worker --lines 100`
2. Output of: `cat /home/swift/.env` (redact secrets)
3. Output of: `pm2 list`

## CRITICAL: DO NOT SKIP

- **File permissions**: Must be 600 (chmod 600)
- **All 12 variables must be set** - Even one missing will cause 500 error
- **Use pooled DATABASE_URL** for Neon
- **REDIS_URL must be native redis://** (not REST API)
- **Test after restart**: `pm2 list` should show all services online

---

**After you complete this, reply with:**
1. Are all services showing as "online" in pm2 list?
2. Do you see any errors in `pm2 logs swift-worker`?
3. Does the prompt button work now?

Then we move to Phase 2: Queue Testing.

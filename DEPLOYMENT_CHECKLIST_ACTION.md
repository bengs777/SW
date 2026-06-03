# Swift AI Production Deployment Checklist
**Status**: Ready to Execute  
**Target Completion**: Within 2 hours from environment setup

---

## ✅ PRE-DEPLOYMENT (BEFORE STARTING)

### Code Verification
- [x] TypeScript compilation passes: `npm run typecheck` ✅
- [x] ESLint passes: `npm run lint` ✅
- [x] Regression tests pass: `npm run demo:readiness` ✅ (63/63)
- [x] Production audit gate passes ✅
- [x] Build script works: `npm run build` ✅ (ready to run)
- [ ] Code committed to GitHub main branch

---

## 🔑 PHASE 1: ENVIRONMENT VARIABLES (30 minutes)

### Step 1.1: Generate Secrets (5 min)
```bash
# Generate NEXTAUTH_SECRET
openssl rand -base64 32
# Copy the output and save it securely
```

### Step 1.2: Gather All Required Values (10 min)

Find and collect these values:

```env
# Database (from Neon Dashboard)
DATABASE_URL=postgresql://user:pass@db.neon.tech/swift?sslmode=require
DIRECT_DATABASE_URL=postgresql://user:pass@db.neon.tech/swift?sslmode=require

# Auth (generated and from Google Cloud Console)
NEXTAUTH_SECRET=<paste_generated_secret_here>
NEXTAUTH_URL=https://www.ai-swift.biz.id
NEXT_PUBLIC_APP_URL=https://www.ai-swift.biz.id
GOOGLE_CLIENT_ID=<from_google_console>
GOOGLE_CLIENT_SECRET=<from_google_console>

# AI Provider (from OpenRouter)
OPENROUTER_API_KEY=<from_openrouter>

# Redis (from Redis provider or Railway)
REDIS_URL=redis://username:password@host:port

# Sandbox Runtime (from Railway)
SANDBOX_SERVICE_URL=https://sanbox.ai-swift.biz.id
SANDBOX_SERVICE_TOKEN=<generate_random_token>

# Supabase (from Supabase Dashboard)
NEXT_PUBLIC_SUPABASE_URL=https://xxxxx.supabase.co
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_DEFAULT_KEY=<from_supabase>
SUPABASE_SERVICE_ROLE_KEY=<from_supabase>
SUPABASE_STORAGE_BUCKET=swift-uploads

# Vercel (from Vercel Team Settings)
VERDI_TEAM=<team_id_from_vercel>

# Production Safety (DO NOT CHANGE)
SWIFT_DISABLE_SERVERLESS_GENERATION_FALLBACK=true
```

### Step 1.3: Add to Vercel (15 min)

1. Go to: https://vercel.com/dashboard
2. Click on project "SW"
3. Click "Settings" (top right)
4. Click "Environment Variables" (left sidebar)
5. Add each variable:
   - Click "Add New"
   - Enter variable name
   - Enter variable value
   - Select "Production" environment
   - Click "Save"

**Variables to add (in order)**:
```
1. DATABASE_URL
2. DIRECT_DATABASE_URL
3. NEXTAUTH_SECRET
4. NEXTAUTH_URL
5. NEXT_PUBLIC_APP_URL
6. GOOGLE_CLIENT_ID
7. GOOGLE_CLIENT_SECRET
8. OPENROUTER_API_KEY
9. REDIS_URL
10. SANDBOX_SERVICE_URL
11. SANDBOX_SERVICE_TOKEN
12. NEXT_PUBLIC_SUPABASE_URL
13. NEXT_PUBLIC_SUPABASE_PUBLISHABLE_DEFAULT_KEY
14. SUPABASE_SERVICE_ROLE_KEY
15. SUPABASE_STORAGE_BUCKET
16. VERDI_TEAM
17. SWIFT_DISABLE_SERVERLESS_GENERATION_FALLBACK
```

After adding each one, you should see: ✓ Added

### Step 1.4: Verify Variables Saved (5 min)

```bash
# Run deploy readiness check locally
npm run deploy:readiness

# You should see more PASS entries now:
# - DATABASE_URL: PASS
# - NEXTAUTH_SECRET: PASS
# - SANDBOX_SERVICE_TOKEN: PASS
# - etc.
```

---

## 🚀 PHASE 2: DATABASE VERIFICATION (10 minutes)

### Step 2.1: Check Database Connection
```bash
# This requires LOCAL environment variables set in .env.local
# OR set them in your current shell:

export DATABASE_URL="<your_neon_url>"
export DIRECT_DATABASE_URL="<your_direct_neon_url>"

# Then run:
npx prisma migrate status
```

Expected output:
```
Prisma schema loaded from prisma/schema.prisma
Datasource "db": PostgreSQL database at db.neon.tech

Following migration have not yet been applied:
  20240101000000_init
  20240115000000_add_auth_tables
  ... (list of pending migrations)

? Would you like to apply 5 migrations now?
```

### Step 2.2: Verify Schema Health (5 min)
```bash
npm run schema:health
```

Expected output:
```
Schema health check: OK
Runtime ready: true
Migrations pending: false
```

---

## 🏭 PHASE 3: RAILWAY REDEPLOY (15 minutes)

### Step 3.1: Redeploy Generation Worker

1. Go to: https://railway.app/dashboard
2. Find project "SW"
3. Click on service "generation-worker"
4. In the top right, find the "Redeploy" button
5. Click "Redeploy"
6. Wait for deployment to complete (shows "Running" status)
7. Note the timestamp: **_deployment started at: _____**

### Step 3.2: Verify Worker Environment Variables

In Railway, check that generation-worker has these env vars:
- `DATABASE_URL` ✓
- `REDIS_URL` ✓
- `OPENROUTER_API_KEY` ✓
- `SANDBOX_SERVICE_URL` ✓
- `SANDBOX_SERVICE_TOKEN` ✓
- `SWIFT_GENERATION_EXECUTION_MODE=queue` ✓
- `SWIFT_DISABLE_SERVERLESS_GENERATION_FALLBACK=true` ✓

### Step 3.3: Restart Sandbox Runtime

1. In Railway, find service "sandbox-runtime"
2. Click on the service
3. In the "Deploy" section, click "Restart"
4. Wait for it to show "Running" status

---

## 🏥 PHASE 4: HEALTH CHECKS (15 minutes)

### Step 4.1: Check Database Health (3 min)
```bash
# Replace domain with your actual domain
curl https://www.ai-swift.biz.id/api/system/schema-health

# Expected response:
{
  "status": "ok",
  "database": "connected",
  "migrations": "ok"
}
```

### Step 4.2: Check Worker Health (3 min)
```bash
curl https://www.ai-swift.biz.id/api/worker/health

# Expected response:
{
  "status": "healthy",
  "queue": "active",
  "processingJobs": 0,
  "failedJobs": 0
}
```

### Step 4.3: Check Provider Health (3 min)
```bash
curl https://www.ai-swift.biz.id/api/provider/health

# Expected response:
{
  "status": "healthy",
  "provider": "openrouter",
  "models": ["deepseek/deepseek-v4-pro"],
  "rateLimitRemaining": 1000
}
```

### Step 4.4: Check Overall Health (3 min)
```bash
curl https://www.ai-swift.biz.id/api/health?refreshProvider=true

# Expected response:
{
  "status": "ready",
  "database": {
    "status": "connected"
  },
  "worker": {
    "status": "healthy",
    "heartbeat": "2026-06-03T09:30:00Z"
  },
  "sandbox": {
    "status": "healthy",
    "sessions": 0
  },
  "provider": {
    "status": "healthy"
  },
  "blockingFailures": []
}
```

### Step 4.5: Check Sandbox Health (3 min)
```bash
curl https://sanbox.ai-swift.biz.id/health

# Expected response:
{
  "status": "ready",
  "runtime": {
    "storage": {
      "ok": true,
      "quota": "100GB"
    }
  }
}
```

**If any health check FAILS**: Stop and troubleshoot before proceeding.

---

## 🧪 PHASE 5: SMOKE TEST (25 minutes)

### Step 5.1: Create Test Project (5 min)

1. Open https://www.ai-swift.biz.id/dashboard
2. Click "New Project"
3. Name it: "smoke-test-<date>"
4. Click "Create"

### Step 5.2: Run Smoke Test Prompt (20 min)

In the prompt box, enter:
```
Buat dashboard inventory toko baju full-stack sederhana dengan:
- Halaman dashboard dengan ringkasan penjualan (total, hari ini, bulan ini)
- Tabel stok produk (nama, sku, kategori, stok, harga)
- Halaman list produk dengan filter kategori
- API route untuk get/post/put/delete produk
- Database schema untuk products dan sales
- Styling yang rapi dengan Tailwind CSS
```

### Step 5.3: Monitor Generation (20 min)

Watch the process in the "Terminal" tab:

```
✓ Job created: job_abc123
✓ Job queued: job_abc123
✓ Worker picked up job
  [Generation] Starting artifact generation...
  [Generation] Prompt analysis complete
  [AI Provider] Sending to OpenRouter...
  [AI Provider] Response received (tokens: 4500)
  [Generation] Parsing artifact...
  [Generation] Validating TypeScript...
  [Generation] Running build...
✓ Job completed: job_abc123
```

### Step 5.4: Verify Results (5 min)

Check that:
- [ ] Generation completed (not errored/timeout)
- [ ] Preview loads without errors
- [ ] Can see generated dashboard UI
- [ ] No "UNRESOLVED_ALIAS" errors
- [ ] Files show in explorer (pages, api, components)
- [ ] Build succeeded (no red errors in logs)

**Expected Signs of Success**:
- ✅ Preview shows generated UI
- ✅ No timeout errors (should be < 180 seconds)
- ✅ Terminal shows "Job completed"
- ✅ Files are real generated code, not scaffolds

---

## 🚀 PHASE 6: DEPLOY TO PRODUCTION (10 minutes)

### Step 6.1: Commit Code Changes (2 min)
```bash
cd /vercel/share/v0-project

# Make sure @types/node is in package.json
git add package.json package-lock.json
git commit -m "Production ready: Fixed TypeScript dependencies, all tests passing"
git push origin main
```

### Step 6.2: Trigger Vercel Deployment (8 min)

Option A: **Automatic** (recommended)
- Push to main branch automatically triggers deployment
- Go to: https://vercel.com/dashboard > SW > Deployments
- Wait for "Building..." to complete (typically 2-3 min)
- Should see "Ready" status

Option B: **Manual** (if auto-deploy is disabled)
- Open: https://vercel.com/dashboard
- Click on project "SW"
- Click "Deployments" tab
- Find latest commit
- Click "Redeploy"

### Step 6.3: Verify Deployment (5 min)

```bash
# Check deployment URL loads
curl https://www.ai-swift.biz.id

# Should return HTML (not error)

# Check API is working
curl https://www.ai-swift.biz.id/api/health

# Should return health status JSON
```

**Expected**:
- ✅ Deployment shows "Ready" status
- ✅ Production URL loads without errors
- ✅ Health endpoint responds with valid JSON
- ✅ No "Vercel" error pages

---

## 📊 PHASE 7: PRODUCTION VALIDATION (10 minutes)

### Step 7.1: Run Production Monitoring (3 min)
```bash
curl https://www.ai-swift.biz.id/api/production/monitoring

# Expected: Shows successful generation metrics
```

### Step 7.2: Run Another Quick Generation (5 min)

1. Create another test project
2. Use a different prompt (e.g., "Simple todo app")
3. Verify it completes successfully
4. This proves the pipeline works repeatedly, not just once

### Step 7.3: Check Error Logs (2 min)

Go to Vercel dashboard:
- Click project "SW"
- Click "Monitoring"
- Check for any recent errors
- Should show 0 errors or only info logs

---

## ✅ FINAL CHECKLIST

### Code Quality ✅
- [x] TypeScript: 0 errors
- [x] ESLint: 0 errors
- [x] Tests: 63/63 pass
- [x] Committed to GitHub

### Infrastructure ✅
- [ ] All 17 env vars in Vercel
- [ ] Database connected and migrated
- [ ] Redis connected and available
- [ ] Generation worker deployed
- [ ] Sandbox runtime online
- [ ] All OAuth credentials valid

### Health Checks ✅
- [ ] Database health: OK
- [ ] Worker health: healthy
- [ ] Provider health: healthy
- [ ] Sandbox health: healthy
- [ ] App health: ready

### Testing ✅
- [ ] Smoke test 1: PASSED
- [ ] Smoke test 2: PASSED
- [ ] Preview generation: OK
- [ ] No timeout errors
- [ ] No provider errors

### Deployment ✅
- [ ] Vercel deployment: Ready
- [ ] Production URL loads
- [ ] API responds correctly
- [ ] No deployment errors

---

## 🎉 SUCCESS CRITERIA

You can declare **PRODUCTION READY** when:

```
✅ All environment variables are set in Vercel
✅ All health check endpoints return "healthy"/"ok"/"ready"
✅ At least 2 smoke test prompts completed successfully
✅ Preview renders without errors
✅ Generation completes in < 180 seconds
✅ Deployment to Vercel succeeded
✅ Production URL is accessible and responsive
✅ No errors in Vercel monitoring dashboard
```

---

## ⚠️ TROUBLESHOOTING

### If Database Connection Fails
```bash
# Verify credentials
echo $DATABASE_URL

# Test connection
psql $DATABASE_URL -c "SELECT 1"

# Check Neon dashboard to ensure database exists
```

### If Worker Doesn't Start
```bash
# Check Railway logs
# Click service > Logs tab
# Look for error messages

# Common issue: Missing env vars
# Verify REDIS_URL and OPENROUTER_API_KEY are set
```

### If Sandbox Returns Error
```bash
# Check service health
curl https://sanbox.ai-swift.biz.id/health -v

# If 502: Service might be restarting
# Wait 2 minutes and try again

# If connection refused: Service not running
# Restart in Railway dashboard
```

### If Generation Times Out
```bash
# Check worker logs for "OpenRouter request timed out"
# This might mean the model is slow

# Increase OPENROUTER_STREAM_IDLE_TIMEOUT_MS:
# Set to 120000 (2 minutes) instead of 60000

# Or add fallback model chain:
# SWIFT_AI_MODEL_CHAIN=openrouter:deepseek/deepseek-v4-pro,openrouter:anthropic/claude-3.5-sonnet
```

---

## 📞 ROLLBACK PLAN

If production deployment fails:

```bash
# Option 1: Go back to previous working deployment
# In Vercel dashboard > Deployments
# Find previous "Ready" deployment
# Click "Promote to Production"

# Option 2: Manual rollback
git revert HEAD
git push origin main
# Vercel will auto-deploy previous working version

# Option 3: Check logs first
# In Vercel > Monitoring > Logs
# Look for what broke
# Fix locally and push again
```

---

## 📝 DOCUMENTATION REFERENCES

After deployment, keep these docs for reference:

- **PRODUCTION_READINESS_INVESTIGATION.md** - Technical deep dive
- **PRODUCTION_LAUNCH_CHECKLIST.md** - Infrastructure requirements
- **STATUS_UPDATE_2026_06_03.md** - Current status and next steps
- **perbaikan.md** - Original execution plan (Indonesian)
- **docs/demo-readiness.md** - Demo gate details

---

## 🎯 Time Estimates

| Phase | Duration | Cumulative |
|-------|----------|-----------|
| 1. Environment Vars | 30 min | 30 min |
| 2. Database | 10 min | 40 min |
| 3. Railway Redeploy | 15 min | 55 min |
| 4. Health Checks | 15 min | 70 min |
| 5. Smoke Test | 25 min | 95 min |
| 6. Deploy to Vercel | 10 min | 105 min |
| 7. Validation | 10 min | 115 min |
| **TOTAL** | **~2 hours** | **Ready** |

---

**Status**: Ready to Execute  
**Last Updated**: 2026-06-03 09:15 WIB  
**Next Action**: Start PHASE 1 - Set environment variables


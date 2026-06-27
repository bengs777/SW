# Reddy Complete Fix Plan - From 500 Error to Fully Functional

## Executive Summary

Your Reddy web generator (ai-swift.biz.id) is **99% ready**, but has one critical issue:

**Problem:** Swift-worker service cannot connect to Redis/Database → returns 500 error on prompt generation

**Solution:** Set environment variables on VPS

**Time to Fix:** 15 minutes  
**Time to Fully Working:** 30-45 minutes (with testing)

---

## Current Status

| Component | Status | Notes |
|-----------|--------|-------|
| Vercel Deployment | ✅ LIVE | ai-swift.biz.id is accessible |
| Frontend (Next.js) | ✅ LIVE | Can see UI, can authenticate |
| PM2 Services | ✅ RUNNING | All 3 services online (swift-web, swift-worker, swift-sandbox) |
| Database | ✅ READY | Neon PostgreSQL configured on Vercel |
| Code Quality | ✅ CLEAN | 0 npm vulnerabilities, TypeScript passes |
| **Functionality** | ❌ BROKEN | Prompt returns 500 error (missing env vars) |

---

## Root Cause Analysis

When you click "Langkukan Prompt":
1. Browser sends request to `/api/generate/jobs`
2. Vercel service receives it
3. Vercel tries to add job to Redis queue
4. **PROBLEM:** Redis URL not set on Vercel → Queue health check fails
5. Returns 500 error to browser

Similarly, swift-worker service on VPS:
- Tries to connect to Redis (cannot find URL)
- Tries to connect to Database (cannot find URL)
- Cannot start processing queue jobs
- Returns 500 error

**Fix:** Set 12 critical environment variables in two places:
- Vercel (17 variables)
- VPS /home/swift/.env (35 variables)

---

## Complete Fix Procedure (3 Phases)

### PHASE 1: Set Environment Variables (15 min)

**Location 1: Vercel Dashboard**
1. Go to vercel.com → Projects → Select your project
2. Settings → Environment Variables
3. Add these 17 variables:
   - DATABASE_URL
   - NEXTAUTH_SECRET
   - NEXTAUTH_URL
   - GOOGLE_CLIENT_ID
   - GOOGLE_CLIENT_SECRET
   - NEXT_PUBLIC_SUPABASE_URL
   - NEXT_PUBLIC_SUPABASE_PUBLISHABLE_DEFAULT_KEY
   - SUPABASE_SERVICE_ROLE_KEY
   - SUPABASE_STORAGE_BUCKET
   - OPENROUTER_API_KEY
   - REDIS_URL (THIS IS CRITICAL!)
   - SANDBOX_SERVICE_URL
   - SANDBOX_SERVICE_TOKEN
   - SWIFT_WORKER_HEALTH_URL
   - Plus a few optional ones

**Location 2: VPS /home/swift/.env**
Follow: `URGENT_FIX_500_ERROR.md` (detailed step-by-step guide)

Commands:
```bash
ssh root@8.215.40.119
nano /home/swift/.env
# Paste all 35+ variables (see guide for complete list)
chmod 600 /home/swift/.env
pm2 restart all
```

### PHASE 2: Test Queue & Workers (10-15 min)

Follow: `PHASE2_TEST_QUEUE.md`

Tests:
1. Health endpoints: `curl https://ai-swift.biz.id/api/health`
2. Redis connection: `redis-cli ping`
3. Database connection: `psql ...`
4. Sample generation job
5. End-to-end user flow

Expected: All tests pass, no errors in logs

### PHASE 3: Optimize & Verify (10 min)

1. Generate 3 sample prompts manually
2. Verify each completes successfully
3. Check performance (should complete in 30-60 seconds)
4. Monitor logs for errors
5. Test error scenarios (bad prompt, network failure)

---

## Files & References

| File | Purpose | When to use |
|------|---------|-------------|
| **ACTION_NOW.txt** | Quick checklist | START HERE - copy-paste ready |
| **URGENT_FIX_500_ERROR.md** | Detailed step-by-step | Detailed instructions for Phase 1 |
| **PHASE2_TEST_QUEUE.md** | Testing procedures | After Phase 1 - verify everything works |
| **VPS_ENV_SETUP.md** | Environment variable reference | If you need to understand what each var does |
| **DEPLOYMENT_STEP_BY_STEP.md** | Full deployment (if redeploying) | Not needed for this fix |

---

## What You Need Before Starting

Gather these values:

```
FROM NEON DASHBOARD:
□ DATABASE_URL = postgresql://...

FROM YOUR VPS/REDIS:
□ REDIS_URL = redis://localhost:6379

FROM VERCEL DASHBOARD:
□ NEXTAUTH_SECRET = ...
□ OPENROUTER_API_KEY = ...

FROM GOOGLE CONSOLE:
□ GOOGLE_CLIENT_ID = ...apps.googleusercontent.com
□ GOOGLE_CLIENT_SECRET = GOCSPX-...

FROM SUPABASE DASHBOARD:
□ NEXT_PUBLIC_SUPABASE_URL = https://xxx.supabase.co
□ NEXT_PUBLIC_SUPABASE_PUBLISHABLE_DEFAULT_KEY = eyJ...
□ SUPABASE_SERVICE_ROLE_KEY = eyJ...

GENERATE YOURSELF:
□ SANDBOX_SERVICE_TOKEN = $(openssl rand -hex 32)
```

---

## Step-by-Step Quick Start

### 1. Read Quick Reference (2 min)
```
Open: ACTION_NOW.txt
```

### 2. Verify Prerequisites (5 min)
```bash
ssh root@8.215.40.119
pm2 list        # All services should be online
pm2 logs swift-web --lines 5
```

### 3. Set Env Vars on VPS (8 min)
```
Follow: URGENT_FIX_500_ERROR.md
Sections: STEP 1-7
```

### 4. Restart & Test (5 min)
```bash
pm2 restart all
pm2 list
pm2 logs swift-worker --lines 20
```

### 5. Test in Browser (5 min)
```
Go to: https://ai-swift.biz.id
Try: Click "Langkukan Prompt" with simple test
Expected: Should work without 500 error
```

### 6. Run Comprehensive Tests (10 min)
```
Follow: PHASE2_TEST_QUEUE.md
All 4 test phases
```

---

## Expected Results

When everything is complete:

✅ Clicking "Langkukan Prompt" works  
✅ Prompt processes and completes  
✅ Generated code displays in editor  
✅ Can preview the generated code  
✅ Can edit and modify generated code  
✅ No 500 or 502 errors  
✅ Performance: ~30-60 seconds per generation  
✅ All PM2 services online  
✅ No errors in logs  

**You now have a fully functional AI code generator like Base44.com!**

---

## Troubleshooting

### "Still getting 500 error after fix"

1. Verify env vars were saved:
```bash
cat /home/swift/.env | grep REDIS_URL
# Should show: REDIS_URL=redis://...
```

2. Check PM2 logs:
```bash
pm2 logs swift-worker --lines 100 | grep -i error
```

3. Verify services restarted:
```bash
pm2 list
# All should show "online" with fresh "uptime"
```

### "Prompt works but slow (>2 minutes)"

1. Check OpenRouter API:
```bash
curl -s -H "Authorization: Bearer YOUR_KEY" \
  https://openrouter.ai/api/v1/models | jq . | head -20
# If error, key is invalid
```

2. Monitor worker during generation:
```bash
watch 'pm2 show swift-worker'
# Check CPU and memory usage
```

3. Check error logs:
```bash
pm2 logs swift-worker --lines 50 | grep -i timeout
```

### "Can log in but prompt button doesn't work"

1. Check browser console (F12):
```
Look for network error (502, 503, timeout)
```

2. Check Nginx logs:
```bash
sudo tail -50 /var/log/nginx/error.log
```

3. Check if swift-web is running:
```bash
pm2 show swift-web
pm2 logs swift-web --lines 30
```

---

## Performance Targets

After fix, you should see:

| Metric | Target | Current |
|--------|--------|---------|
| Time to first generation | <1 min | ? |
| Time per generation | 30-60 sec | ? |
| Error rate | 0% | ? |
| Worker memory | <500MB | ? |
| Database response time | <100ms | ? |
| Redis response time | <50ms | ? |

---

## Next Steps After Complete Fix

Once everything is working:

1. **Performance Optimization** (if needed)
   - Monitor real usage patterns
   - Optimize AI model if too slow
   - Scale worker resources if bottleneck

2. **User Experience**
   - Add progress indicators
   - Add error recovery
   - Add generation history

3. **Production Hardening**
   - Setup monitoring alerts
   - Setup automatic backups
   - Setup log aggregation
   - Setup uptime monitoring

4. **Launch!**
   - Share with users
   - Gather feedback
   - Plan improvements

---

## Support

If you get stuck:

**Reply with:**
1. Which file are you in? (ACTION_NOW.txt, URGENT_FIX_500_ERROR.md, etc)
2. What step?
3. Error message or screenshot
4. Output of: `pm2 list` and `pm2 logs swift-worker --lines 20`

I'll respond with exact fix immediately.

---

## Timeline Summary

| Phase | Action | Time | Status |
|-------|--------|------|--------|
| 1 | Set env variables | 15 min | DO THIS FIRST |
| 2 | Test queue & workers | 10 min | After Phase 1 |
| 3 | Verify & optimize | 10 min | After Phase 2 |
| **Total** | **Fully functional** | **35-45 min** | **Ready to launch** |

---

**You're almost there! Complete Phase 1 now and reply with results.**

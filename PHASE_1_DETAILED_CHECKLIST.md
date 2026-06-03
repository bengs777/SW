# PHASE 1: IMMEDIATE FIXES - Detailed Checklist
## Step-by-Step Instructions with Exact Actions

**Timeline**: 1-2 hours  
**Status**: Ready to execute  
**Approval**: Required before proceeding

---

## PHASE 1 OVERVIEW

This phase has 3 main steps:
1. **Prepare environment variables** (30 minutes)
2. **Configure Vercel production environment** (20 minutes)
3. **Redeploy Railway services** (10 minutes)

Total: ~60 minutes (1 hour)

---

## STEP 1: GATHER & PREPARE ENVIRONMENT VARIABLES
**Duration**: 30 minutes  
**Prerequisites**: Must complete ENV_VARS_GATHERING_GUIDE.md

### Action 1.1: Review the gathering guide
- [ ] Open `ENV_VARS_GATHERING_GUIDE.md` in this project
- [ ] Read through all 18 variables
- [ ] Mark which ones you already have

### Action 1.2: Generate NEXTAUTH_SECRET
- [ ] Open terminal
- [ ] Run: `openssl rand -base64 32`
- [ ] Copy the output (44-character string)
- [ ] Save in secure location

### Action 1.3: Gather Database URLs from Neon
- [ ] Go to https://console.neon.tech
- [ ] Log in with your account
- [ ] Select "Swift AI" project
- [ ] Click "Connection string"
- [ ] Copy **pooled connection string** → Save as DATABASE_URL
- [ ] Click "direct connection"
- [ ] Copy **direct connection string** → Save as DIRECT_DATABASE_URL
- [ ] Verify both start with `postgresql://`

### Action 1.4: Get Google OAuth credentials
- [ ] Go to https://console.cloud.google.com
- [ ] Create new project: "Swift AI OAuth" (if needed)
- [ ] Enable Google+ API
- [ ] Go to Credentials
- [ ] Create OAuth 2.0 Client ID (Web application)
- [ ] Add authorized redirect URI: `https://www.ai-swift.biz.id/api/auth/callback/google`
- [ ] Copy Client ID → Save as GOOGLE_CLIENT_ID
- [ ] Copy Client Secret → Save as GOOGLE_CLIENT_SECRET

### Action 1.5: Get OpenRouter API key
- [ ] Go to https://openrouter.ai
- [ ] Log in or create account
- [ ] Go to Dashboard > API Keys
- [ ] Create new API key or copy existing
- [ ] Copy → Save as OPENROUTER_API_KEY

### Action 1.6: Get Redis URL
- [ ] Go to your Redis provider (Upstash, Redis Cloud, etc.)
- [ ] Find your Redis instance
- [ ] Copy connection URL
- [ ] Should look like: `rediss://default:token@host:6380`
- [ ] Save as REDIS_URL

### Action 1.7: Get Supabase credentials
- [ ] Go to https://supabase.com
- [ ] Log in and select Swift AI project
- [ ] Go to Settings > API
- [ ] Copy "Project URL" → Save as NEXT_PUBLIC_SUPABASE_URL
- [ ] Copy "anon public" key → Save as NEXT_PUBLIC_SUPABASE_PUBLISHABLE_DEFAULT_KEY
- [ ] Copy "service_role" key → Save as SUPABASE_SERVICE_ROLE_KEY
- [ ] Go to Storage, note bucket name → Save as SUPABASE_STORAGE_BUCKET

### Action 1.8: Confirm sandbox configuration
- [ ] Note sandbox domain: `https://sandbox.ai-swift.biz.id`
- [ ] Save as SANDBOX_SERVICE_URL
- [ ] Generate token: `openssl rand -base64 32`
- [ ] Save as SANDBOX_SERVICE_TOKEN

### Action 1.9: Confirm your domain
- [ ] Confirm production domain: `https://www.ai-swift.biz.id`
- [ ] Save as NEXTAUTH_URL and NEXT_PUBLIC_APP_URL

### Completion Check 1.9
- [ ] All 18 variables gathered and saved securely
- [ ] No variables have placeholder values
- [ ] All database URLs verified
- [ ] All API keys tested (optional but recommended)

**Status**: ✅ Ready for Vercel configuration

---

## STEP 2: CONFIGURE VERCEL PRODUCTION ENVIRONMENT
**Duration**: 20 minutes  
**Prerequisites**: All 18 variables gathered from Step 1

### Action 2.1: Access Vercel dashboard
- [ ] Go to https://vercel.com/dashboard
- [ ] Select project: `sw` (prj_y5acefspL2NLDB3Iw91Q6nxQMBVT)
- [ ] Go to Settings tab (top menu)

### Action 2.2: Navigate to Environment Variables
- [ ] In Settings, click "Environment Variables" (left sidebar)
- [ ] You should see "Production" environment selected
- [ ] Verify "main" branch is selected

### Action 2.3: Add DATABASE_URL
- [ ] Click "Add" (new environment variable)
- [ ] Name: `DATABASE_URL`
- [ ] Value: Paste the DATABASE_URL from Neon (from Step 1.3)
- [ ] Environment: Select "Production"
- [ ] Click "Add"
- [ ] Wait for confirmation (checkmark appears)

### Action 2.4: Add DIRECT_DATABASE_URL
- [ ] Click "Add"
- [ ] Name: `DIRECT_DATABASE_URL`
- [ ] Value: Paste the DIRECT_DATABASE_URL (from Step 1.3)
- [ ] Environment: Production
- [ ] Click "Add"

### Action 2.5: Add NEXTAUTH_SECRET
- [ ] Click "Add"
- [ ] Name: `NEXTAUTH_SECRET`
- [ ] Value: Paste the secret from Step 1.2 (openssl output)
- [ ] Environment: Production
- [ ] Click "Add"

### Action 2.6: Add NEXTAUTH_URL
- [ ] Click "Add"
- [ ] Name: `NEXTAUTH_URL`
- [ ] Value: `https://www.ai-swift.biz.id`
- [ ] Environment: Production
- [ ] Click "Add"

### Action 2.7: Add NEXT_PUBLIC_APP_URL
- [ ] Click "Add"
- [ ] Name: `NEXT_PUBLIC_APP_URL`
- [ ] Value: `https://www.ai-swift.biz.id`
- [ ] Environment: Production
- [ ] Click "Add"

### Action 2.8: Add GOOGLE_CLIENT_ID
- [ ] Click "Add"
- [ ] Name: `GOOGLE_CLIENT_ID`
- [ ] Value: Paste from Step 1.4
- [ ] Environment: Production
- [ ] Click "Add"

### Action 2.9: Add GOOGLE_CLIENT_SECRET
- [ ] Click "Add"
- [ ] Name: `GOOGLE_CLIENT_SECRET`
- [ ] Value: Paste from Step 1.4
- [ ] Environment: Production
- [ ] Click "Add"

### Action 2.10: Add OPENROUTER_API_KEY
- [ ] Click "Add"
- [ ] Name: `OPENROUTER_API_KEY`
- [ ] Value: Paste from Step 1.5
- [ ] Environment: Production
- [ ] Click "Add"

### Action 2.11: Add REDIS_URL
- [ ] Click "Add"
- [ ] Name: `REDIS_URL`
- [ ] Value: Paste from Step 1.6
- [ ] Environment: Production
- [ ] Click "Add"

### Action 2.12: Add SANDBOX_SERVICE_URL
- [ ] Click "Add"
- [ ] Name: `SANDBOX_SERVICE_URL`
- [ ] Value: `https://sandbox.ai-swift.biz.id`
- [ ] Environment: Production
- [ ] Click "Add"

### Action 2.13: Add SANDBOX_SERVICE_TOKEN
- [ ] Click "Add"
- [ ] Name: `SANDBOX_SERVICE_TOKEN`
- [ ] Value: Paste from Step 1.8 (openssl output)
- [ ] Environment: Production
- [ ] Click "Add"

### Action 2.14: Add NEXT_PUBLIC_SUPABASE_URL
- [ ] Click "Add"
- [ ] Name: `NEXT_PUBLIC_SUPABASE_URL`
- [ ] Value: Paste from Step 1.7
- [ ] Environment: Production
- [ ] Click "Add"

### Action 2.15: Add NEXT_PUBLIC_SUPABASE_PUBLISHABLE_DEFAULT_KEY
- [ ] Click "Add"
- [ ] Name: `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_DEFAULT_KEY`
- [ ] Value: Paste from Step 1.7 (anon public key - JWT)
- [ ] Environment: Production
- [ ] Click "Add"

### Action 2.16: Add SUPABASE_SERVICE_ROLE_KEY
- [ ] Click "Add"
- [ ] Name: `SUPABASE_SERVICE_ROLE_KEY`
- [ ] Value: Paste from Step 1.7 (service_role key - JWT)
- [ ] Environment: Production
- [ ] Click "Add"

### Action 2.17: Add SUPABASE_STORAGE_BUCKET
- [ ] Click "Add"
- [ ] Name: `SUPABASE_STORAGE_BUCKET`
- [ ] Value: Your bucket name (e.g., `generated-artifacts`)
- [ ] Environment: Production
- [ ] Click "Add"

### Action 2.18: Add SWIFT_DISABLE_SERVERLESS_GENERATION_FALLBACK
- [ ] Click "Add"
- [ ] Name: `SWIFT_DISABLE_SERVERLESS_GENERATION_FALLBACK`
- [ ] Value: `true`
- [ ] Environment: Production
- [ ] Click "Add"

### Action 2.19: Optional - Add VERDI_TEAM
- [ ] Click "Add"
- [ ] Name: `VERDI_TEAM`
- [ ] Value: Your team ID or skip if not using teams
- [ ] Environment: Production
- [ ] Click "Add"

### Action 2.20: Optional - Add SWIFT_AI_PROVIDER_NAME
- [ ] Click "Add"
- [ ] Name: `SWIFT_AI_PROVIDER_NAME`
- [ ] Value: `openrouter`
- [ ] Environment: Production
- [ ] Click "Add"

### Completion Check 2.20: Verify all variables in Vercel
- [ ] Go back to Environment Variables page
- [ ] Count all visible environment variables
- [ ] Should see at least 18 variables (16 required + 2 optional)
- [ ] All have production environment selected
- [ ] No red error indicators

**Example**: You should see entries like:
```
✓ DATABASE_URL               Production
✓ DIRECT_DATABASE_URL        Production
✓ NEXTAUTH_SECRET            Production
✓ NEXTAUTH_URL               Production
... (14 more variables)
```

**Status**: ✅ Environment variables configured in Vercel

---

## STEP 3: REDEPLOY RAILWAY SERVICES
**Duration**: 10 minutes  
**Prerequisites**: Vercel environment variables configured

### Action 3.1: Access Railway dashboard
- [ ] Go to https://railway.app
- [ ] Log in with your account
- [ ] Select your Swift AI project

### Action 3.2: Redeploy generation-worker service
- [ ] Find service: `generation-worker`
- [ ] Click on the service
- [ ] Click "Deployments" tab
- [ ] Click "Deploy" button (latest commit)
- [ ] Wait for deployment to complete (green status)
- [ ] Note: This can take 2-5 minutes

### Action 3.3: Redeploy sandbox-runtime service
- [ ] Find service: `sandbox-runtime`
- [ ] Click on the service
- [ ] Click "Deployments" tab
- [ ] Click "Deploy" button (latest commit)
- [ ] Wait for deployment to complete (green status)
- [ ] Note: This can take 2-5 minutes

### Completion Check 3.3: Verify service health
- [ ] Both services show green status
- [ ] No error messages in deployment logs
- [ ] Services are running (not crashed/stopped)

**Status**: ✅ Railway services redeployed

---

## PHASE 1 COMPLETION CHECKLIST

### Verify all steps completed:
- [ ] Step 1: All 18 environment variables gathered
- [ ] Step 2: All 18 variables added to Vercel production
- [ ] Step 3: Both Railway services redeployed successfully

### System should now be:
- [ ] ✅ Code deployed in Vercel (main branch)
- [ ] ✅ Environment variables configured
- [ ] ✅ Database connectivity ready (URLs set)
- [ ] ✅ OAuth configured (Google)
- [ ] ✅ AI provider connected (OpenRouter)
- [ ] ✅ Queue system ready (Redis)
- [ ] ✅ Sandbox service deployed
- [ ] ✅ Ready for Phase 2 health checks

---

## TROUBLESHOOTING PHASE 1

### Issue: "Invalid value" error when adding variable
**Solution**: 
- Check the value doesn't have extra spaces
- Verify it's the complete value (not truncated)
- For JWT tokens, ensure entire token is pasted

### Issue: Railway deployment fails
**Solution**:
- Wait 5 minutes and try again
- Check service logs for specific error
- Verify git branch is correct (should be main)
- Try manual rebuild: Railways > Service > Rebuild

### Issue: Vercel environment variable not taking effect
**Solution**:
- Redeploy the project: Vercel > Deployments > Redeploy
- Wait 2-3 minutes for new deployment
- Clear browser cache
- Check "Rerender on commit" is enabled

### Issue: Cannot access Neon/Google/Supabase dashboards
**Solution**:
- Verify you're logged in to correct account
- Check email for correct login credentials
- Reset password if needed
- Contact provider support

---

## NEXT PHASE

Once Phase 1 is complete (all checkmarks above):
1. Proceed to **PHASE 2: HEALTH & CONNECTIVITY CHECKS**
2. Open: `PHASE_2_HEALTH_CHECKS.md`
3. Expected duration: 1 hour

---

## PHASE 1 SUMMARY

**What was done**:
- Gathered all 18 critical environment variables
- Configured Vercel production environment
- Redeployed Railway services with new configuration

**What's ready**:
- Production environment fully configured
- All integrations connected (Database, OAuth, AI, Queue, Storage)
- Services running with latest code

**What's next**:
- Phase 2: Verify health and connectivity
- Phase 3: Smoke testing with real generation
- Phase 4: Production deployment

---

**Phase 1 Status**: READY FOR COMPLETION  
**Estimated Completion Time**: 1-2 hours  
**Next Step**: Execute Actions 1.1-3.3 above, then proceed to Phase 2


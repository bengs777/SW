# Swift AI Improvement Implementation Roadmap

## Phase 1: Immediate Fixes (1-2 hours)

### 1.1 Railway Services Redeploy

**Status**: PENDING  
**Priority**: CRITICAL  
**Time**: 30 minutes

**Steps**:
1. Login to Railway dashboard (railway.app)
2. Navigate to project: bengs777/SW
3. Verify generation-worker service:
   - Service connected to repo: bengs777/SW
   - Branch: main
   - Latest commit hash matches local
4. Redeploy generation-worker:
   - Click "Deploy" button
   - Wait for "Deployed" status
   - Verify no errors in logs
5. Verify sandbox-runtime service:
   - Service connected and healthy
   - Domain sanbox.ai-swift.biz.id accessible
6. Test accessibility:
   - curl https://sanbox.ai-swift.biz.id/health
   - Expected: 200 OK with health status

**Acceptance Criteria**:
- [ ] Worker shows "Deployed" status
- [ ] Sandbox shows "Deployed" status
- [ ] No deployment errors in Railway logs
- [ ] Health endpoints return 200 OK

**Notes**:
- Redeploy will pull latest code with timeout fixes
- Environment variables must be set in Railway (check settings)
- Deployment typically takes 2-3 minutes

---

### 1.2 Vercel Environment Variables Configuration

**Status**: PENDING  
**Priority**: CRITICAL  
**Time**: 30 minutes

**Variables to Configure** (18 total):

**Database (2)**:
```
DATABASE_URL=postgresql://user:pass@host/db?schema=public&sslmode=require
DIRECT_DATABASE_URL=postgresql://user:pass@host/db?schema=public&sslmode=require&statement_cache_size=0
```

**Authentication (3)**:
```
NEXTAUTH_SECRET=<generate with: openssl rand -base64 32>
NEXTAUTH_URL=https://www.ai-swift.biz.id
NEXT_PUBLIC_APP_URL=https://www.ai-swift.biz.id
```

**OAuth (2)**:
```
GOOGLE_CLIENT_ID=<from Google Cloud Console>
GOOGLE_CLIENT_SECRET=<from Google Cloud Console>
```

**AI Provider (1)**:
```
OPENROUTER_API_KEY=<from OpenRouter dashboard>
```

**Timeout Configuration (2)**:
```
OPENROUTER_STREAM_IDLE_TIMEOUT_MS=60000
OPENROUTER_HARD_TIMEOUT_MS=180000
```

**Queue/Cache (1)**:
```
REDIS_URL=redis://user:pass@host:port
```

**Sandbox Service (2)**:
```
SANDBOX_SERVICE_URL=https://sanbox.ai-swift.biz.id
SANDBOX_SERVICE_TOKEN=<match token in Railway worker>
```

**Supabase (4)**:
```
NEXT_PUBLIC_SUPABASE_URL=https://xxxxx.supabase.co
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_DEFAULT_KEY=<anon key>
SUPABASE_SERVICE_ROLE_KEY=<service role key>
SUPABASE_STORAGE_BUCKET=v0-projects
```

**Vercel (1)**:
```
VERDI_TEAM=<Vercel team ID>
```

**Steps**:
1. Go to Vercel Dashboard → Project "sw" → Settings
2. Navigate to "Environment Variables"
3. For each variable:
   - Click "Add New"
   - Paste NAME and VALUE
   - Select "Production" environment
   - Click "Add"
4. Verify all 18 variables visible in list
5. Redeploy to apply changes:
   - Go to Deployments
   - Click redeploy icon on latest deployment

**Acceptance Criteria**:
- [ ] All 18 variables added to Vercel
- [ ] All set to "Production" environment
- [ ] Redeploy completes successfully
- [ ] No environment variable errors in logs

**Verification**:
```bash
curl https://www.ai-swift.biz.id/api/health
# Should return: { "status": "ready", ... }
```

---

## Phase 2: Health & Connectivity Verification (1 hour)

### 2.1 Run All Health Checks

**Status**: PENDING  
**Priority**: CRITICAL  
**Time**: 20 minutes

**Endpoints to Check**:

1. **Main API Health**:
   ```bash
   curl https://www.ai-swift.biz.id/api/health?refreshProvider=true
   # Expected: { "status": "ready", "uptime": ..., "timestamp": ... }
   ```

2. **Worker Health**:
   ```bash
   curl https://www.ai-swift.biz.id/api/worker/health
   # Expected: { "status": "healthy", "queue": "active", "workers": N }
   ```

3. **Provider Health**:
   ```bash
   curl https://www.ai-swift.biz.id/api/provider/health
   # Expected: { "status": "healthy", "provider": "openrouter", "latency": Nms }
   ```

4. **Production Monitoring**:
   ```bash
   curl https://www.ai-swift.biz.id/api/production/monitoring
   # Expected: { "status": "ok", "checks": [...] }
   ```

5. **Sandbox Health**:
   ```bash
   curl https://sanbox.ai-swift.biz.id/health
   # Expected: { "status": "ready", "runtime": { "storage": { "ok": true } } }
   ```

**Acceptance Criteria**:
- [ ] All 5 endpoints return 200 OK
- [ ] No 502/500 errors
- [ ] Response times < 2000ms
- [ ] No blockingFailures in health responses

---

### 2.2 Database Connection Verification

**Status**: PENDING  
**Priority**: CRITICAL  
**Time**: 10 minutes

**Steps**:
1. Check connection via health endpoint
2. Verify Neon dashboard shows active connections
3. Monitor for connection pool saturation
4. Test query execution time

**Acceptance Criteria**:
- [ ] Database connection established
- [ ] Pool utilization normal
- [ ] Query times < 100ms average

---

## Phase 3: Smoke Testing (1.5-2 hours)

### 3.1 End-to-End Generation Test

**Status**: PENDING  
**Priority**: CRITICAL  
**Time**: 45 minutes

**Test Prompt**:
```
Buat dashboard inventory toko baju full-stack sederhana dengan:
- Halaman produk dengan list view
- Ringkasan penjualan
- Tabel stok real-time
- API route untuk CRUD produk
- Tampilan preview yang rapi dan responsive
```

**Monitoring Points**:
- [ ] Prompt accepted (HTTP 202)
- [ ] Job ID returned
- [ ] Job enters BullMQ queue
- [ ] Worker picks up job (watch logs)
- [ ] No "timed out after 15 seconds" error
- [ ] Generation completes (status: completed)
- [ ] Output is NOT default scaffold
- [ ] Real code generated (e.g., actual components, not defaults)
- [ ] Preview URL generated
- [ ] Sandbox session status: ready

**Expected Output**:
- Dashboard with real generated code
- Components for inventory management
- Actual database models
- Real API routes
- Working preview

**Fallback** (if primary model fails):
```
SWIFT_AI_MODEL_CHAIN=openrouter:deepseek/deepseek-v4-pro,openrouter:anthropic/claude-3.5-sonnet,openrouter:openai/gpt-4o
```

**Success Criteria**:
- [ ] Generation completes without timeout
- [ ] Real code visible in preview
- [ ] No ErrorBoundary needed
- [ ] Can see actual app UI

---

### 3.2 Preview Validation

**Status**: PENDING  
**Priority**: IMPORTANT  
**Time**: 30 minutes

**Tests**:
- [ ] Preview displays generated UI
- [ ] No compile errors
- [ ] Responsive on mobile/tablet
- [ ] Interactive elements functional
- [ ] No ErrorBoundary component showing

---

### 3.3 Sandbox Build Validation

**Status**: PENDING  
**Priority**: IMPORTANT  
**Time**: 30 minutes

**Tests**:
- [ ] Dependencies install successfully
- [ ] Build completes in < 60 seconds
- [ ] No missing dependency errors
- [ ] Artifacts created in sandbox
- [ ] Preview server starts
- [ ] Can access generated files

---

## Phase 4: Production Deployment (1-2 hours)

### 4.1 Pre-Deployment Verification Checklist

**Status**: PENDING  
**Priority**: CRITICAL  
**Time**: 15 minutes

**Checks**:
- [ ] /api/health returns ready
- [ ] /api/worker/health returns healthy
- [ ] /api/provider/health returns healthy
- [ ] /sanbox.ai-swift.biz.id/health returns ready
- [ ] All health checks returning < 2000ms
- [ ] No blockingFailures detected
- [ ] Minimum 1 successful smoke test
- [ ] Sentry showing normal error rates (< 1%)
- [ ] No critical errors in recent logs

---

### 4.2 Deployment to Main Branch

**Status**: PENDING  
**Priority**: CRITICAL  
**Time**: 30 minutes

**Steps**:
1. Ensure all changes committed locally
2. Merge v0/production-readiness-investigation-597618eb → main:
   ```bash
   git checkout main
   git pull origin main
   git merge v0/production-readiness-investigation-597618eb
   git push origin main
   ```
3. Monitor Vercel deployment:
   - Deployment should auto-trigger
   - Wait for "Deployment Successful" status
   - Check logs for any errors
   - Verify no new errors introduced

**Acceptance Criteria**:
- [ ] Merge completes cleanly
- [ ] Vercel deployment succeeds
- [ ] No deployment errors
- [ ] Production domain responding

---

### 4.3 Post-Deployment Smoke Test

**Status**: PENDING  
**Priority**: CRITICAL  
**Time**: 15 minutes

**Steps**:
1. Re-run same smoke test on production
2. Verify generation works end-to-end
3. Check production logs in Vercel
4. Monitor for error rate increase
5. System must remain stable for 30 minutes

**Acceptance Criteria**:
- [ ] Smoke test passes on production
- [ ] No increase in error rate
- [ ] System stable for 30 minutes
- [ ] No critical issues found

---

## Success Metrics

### Phase 1: Immediate Fixes
- ✅ Railway redeploy complete
- ✅ 18 environment variables configured
- ✅ No configuration errors

### Phase 2: Health & Connectivity
- ✅ All 5 health endpoints returning 200 OK
- ✅ Database connections working
- ✅ Response times reasonable

### Phase 3: Smoke Testing
- ✅ Generation completes without timeout
- ✅ Real code generated (not scaffold)
- ✅ Preview renders correctly
- ✅ Sandbox build successful

### Phase 4: Production Deployment
- ✅ Merge to main succeeds
- ✅ Vercel deployment succeeds
- ✅ Post-deployment tests pass
- ✅ System stable

---

## PRODUCTION READY Achieved When

```
✅ All 4 phases complete
✅ All acceptance criteria met
✅ Zero critical blockers remaining
✅ Error rate < 1%
✅ Full pipeline working: Prompt → Queue → Generation → Preview → Deploy
✅ User can submit prompt and see real generated code
✅ System maintains stability for 30+ minutes
✅ All health checks passing
✅ Monitoring active and baseline captured
```

---

## Timeline

| Phase | Est. Time | Status |
|-------|-----------|--------|
| Phase 1: Immediate Fixes | 1-2 hours | PENDING |
| Phase 2: Health & Connectivity | 1 hour | PENDING |
| Phase 3: Smoke Testing | 1.5-2 hours | PENDING |
| Phase 4: Production Deployment | 1-2 hours | PENDING |
| **TOTAL** | **4-5 hours** | PENDING |

**Start Time**: [TO BE FILLED]  
**Expected Completion**: [TO BE FILLED]

---

Generated: June 3, 2026  
Status: Ready for Execution

# Production Deployment Checklist for Swift (Reddy)

## Pre-Deployment (Days 1-6)

### Security & Vulnerabilities
- [x] Run `npm audit fix` to patch all vulnerabilities (11 fixed)
- [x] Verify `npm audit` shows `0 vulnerabilities`
- [x] Run `npm run typecheck` - passes
- [x] Run `npm run lint` - passes
- [ ] Audit all `/app/api/` routes for authentication middleware
- [ ] Review preview iframe sandbox attributes
- [ ] Verify no API keys visible in source code
- [ ] Rotate any secrets visible in chat history

### Environment Variable Configuration
- [ ] **Vercel Production Environment** (see `VERCEL_ENV_SETUP.md`):
  - [ ] `DATABASE_URL` (Neon pooled connection)
  - [ ] `DIRECT_DATABASE_URL` (Neon direct, for migrations)
  - [ ] `NEXTAUTH_SECRET` (32+ character random)
  - [ ] `NEXTAUTH_URL` (production domain)
  - [ ] `GOOGLE_CLIENT_ID` (Google OAuth)
  - [ ] `GOOGLE_CLIENT_SECRET` (Google OAuth)
  - [ ] `NEXT_PUBLIC_SUPABASE_URL` (Supabase)
  - [ ] `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_DEFAULT_KEY` (Supabase)
  - [ ] `SUPABASE_SERVICE_ROLE_KEY` (Supabase)
  - [ ] `SUPABASE_STORAGE_BUCKET` (swift-artifacts)
  - [ ] `OPENROUTER_API_KEY` (AI provider)
  - [ ] `OPENROUTER_MODEL` (AI model)
  - [ ] `SWIFT_AI_PROVIDER_NAME` (openrouter)
  - [ ] `REDIS_URL` (native redis:// protocol)
  - [ ] `SANDBOX_SERVICE_URL` (https://sandbox.ai-swift.biz.id)
  - [ ] `SANDBOX_SERVICE_TOKEN` (64-char hex)
  - [ ] `SWIFT_WORKER_HEALTH_URL` (worker health endpoint)

- [ ] **VPS Environment Files** (see `VPS_ENV_SETUP.md`):
  - [ ] `/home/swift/.env` created with mode 600
  - [ ] `/home/swift/.env.sandbox` created with mode 600
  - [ ] All database/Redis/API credentials filled in
  - [ ] No placeholder values (grep check)
  - [ ] `SANDBOX_SERVICE_TOKEN` matches Vercel value

### Database Setup
- [ ] **Neon PostgreSQL**:
  - [ ] Account created at neon.tech
  - [ ] Database created
  - [ ] Pooled connection string obtained
  - [ ] Direct (non-pooled) connection string obtained
  - [ ] Both URLs include `sslmode=require`
  - [ ] Test pooled connection: `psql "$DATABASE_URL" -c "SELECT 1"`
  - [ ] Test direct connection: `psql "$DIRECT_DATABASE_URL" -c "SELECT 1"`
  - [ ] VPS IP (8.215.40.119) whitelisted if needed

- [ ] **Prisma Migrations**:
  - [ ] Generate Prisma client: `npm run db:generate`
  - [ ] Test migration on production DB: `npx prisma db push` (uses DIRECT_DATABASE_URL)
  - [ ] Verify schema created successfully
  - [ ] Check for any migration warnings

### Queue & Cache Setup
- [ ] **Redis**:
  - [ ] Redis instance created (Upstash, self-hosted, or managed)
  - [ ] Native Redis connection string obtained (redis:// or rediss://)
  - [ ] Test connection: `redis-cli -u "$REDIS_URL" ping`
  - [ ] REDIS_URL set on both Vercel and VPS
  - [ ] BullMQ job processing tested locally

### Storage Setup
- [ ] **Supabase**:
  - [ ] Account created at supabase.com
  - [ ] Project created
  - [ ] Storage bucket created (name: `swift-artifacts`)
  - [ ] API key and anon key obtained
  - [ ] Service role key obtained (secret, different from anon key)
  - [ ] All three Supabase credentials set on Vercel and VPS
  - [ ] Test storage upload via API

### OAuth Authentication
- [ ] **Google OAuth Setup**:
  - [ ] Google Cloud project created
  - [ ] OAuth 2.0 credential (Web application) created
  - [ ] Authorized Redirect URI added: `https://www.ai-swift.biz.id/api/auth/callback/google`
  - [ ] Client ID obtained
  - [ ] Client Secret obtained (min 24 chars)
  - [ ] Both values set on Vercel
  - [ ] Test sign-in locally before production

### VPS Infrastructure (Days 3-5)
- [ ] **VPS Provisioning**:
  - [ ] SSH access confirmed to 8.215.40.119
  - [ ] Bootstrap script executed: `bash scripts/vps-production-bootstrap.sh`
  - [ ] All packages installed (Node 22, PM2, Nginx, certbot, UFW)
  - [ ] Repository cloned to `/root/swift-runtime`
  - [ ] Dependencies installed (`npm ci`)
  - [ ] Sandbox directory created: `/data/swift-sandbox`

- [ ] **Security Hardening**:
  - [ ] SSH key-based auth configured
  - [ ] Password authentication disabled in sshd_config
  - [ ] UFW firewall enabled (SSH, HTTP, HTTPS only)
  - [ ] Fail2ban enabled for brute-force protection
  - [ ] Root password rotated (if using password fallback)

- [ ] **DNS & HTTPS**:
  - [ ] DNS record `sandbox.ai-swift.biz.id` → `8.215.40.119` verified
  - [ ] DNS propagated (tested with `nslookup` or `dig`)
  - [ ] Let's Encrypt certificate requested: `certbot --nginx -d sandbox.ai-swift.biz.id`
  - [ ] Certificate installed and Nginx reloaded
  - [ ] HTTPS working: `curl https://sandbox.ai-swift.biz.id/`
  - [ ] Auto-renewal verified: `certbot renew --dry-run`

- [ ] **Nginx Configuration**:
  - [ ] Nginx reverse proxy configured for both services
  - [ ] Routes configured:
    - `/` → port 8080 (sandbox runtime)
    - `/worker/health` → port 4000 (generation worker)
  - [ ] Nginx test passed: `nginx -t`
  - [ ] Nginx reloaded: `systemctl reload nginx`

- [ ] **PM2 Setup**:
  - [ ] PM2 installed globally: `npm install -g pm2`
  - [ ] PM2 startup enabled: `pm2 startup systemd -u root --hp /root`
  - [ ] Services configured in `ecosystem.config.cjs`:
    - [ ] `swift-generation-worker` service
    - [ ] `swift-sandbox` service

### Service Deployment (Day 6)
- [ ] **Environment Configuration** (see VPS_ENV_SETUP.md):
  - [ ] Fill `/home/swift/.env` with all production values
  - [ ] Fill `/home/swift/.env.sandbox` with sandbox-specific values
  - [ ] Verify file permissions: `ls -la /home/swift/.env*` (should show 600)
  - [ ] Verify no placeholders: `grep -i "example\|replace\|todo" /home/swift/.env` (should be empty)

- [ ] **Deploy Services**:
  - [ ] Run deployment script: `bash scripts/vps-production-deploy.sh`
  - [ ] Verify environment validation passed (no missing vars)
  - [ ] Verify Git pulled latest code
  - [ ] Verify dependencies installed
  - [ ] Verify services started successfully

- [ ] **Verify Service Health**:
  - [ ] Check PM2 status: `pm2 status` (both services online)
  - [ ] Local health checks:
    - [ ] `curl http://127.0.0.1:8080/health` → 200 JSON
    - [ ] `curl http://127.0.0.1:4000/health` → 200 JSON
  - [ ] Public health checks:
    - [ ] `curl https://sandbox.ai-swift.biz.id/health` → 200 JSON
    - [ ] `curl https://sandbox.ai-swift.biz.id/worker/health` → 200 JSON

### Final Pre-Deploy Testing (Day 6)
- [ ] **Build & Verification**:
  - [ ] `npm run build` completes without errors
  - [ ] `npm run typecheck` passes
  - [ ] `npm run lint` passes
  - [ ] `npm run audit:production` passes

- [ ] **Health Checks**:
  - [ ] `npm run postdeploy:health:prod` passes
  - [ ] All 6 health endpoints responding:
    1. Vercel dashboard: `https://www.ai-swift.biz.id/api/health`
    2. VPS sandbox local: `http://127.0.0.1:8080/health`
    3. VPS worker local: `http://127.0.0.1:4000/health`
    4. VPS sandbox public: `https://sandbox.ai-swift.biz.id/health`
    5. VPS worker public: `https://sandbox.ai-swift.biz.id/worker/health`
    6. Database: Neon connection working

## Production Deployment (Day 7)

### Pre-Deploy Snapshot
- [ ] Document baseline:
  - [ ] Current number of users (if any)
  - [ ] Current database state (optional backup)
  - [ ] Current error rates (screenshot/monitor)
  - [ ] Service status (health checks)

### Dashboard Deployment to Vercel
- [ ] **Push to Production Branch**:
  - [ ] All changes committed to local main branch
  - [ ] Vulnerability fixes merged
  - [ ] Environment setup docs committed (no secrets!)
  - [ ] Verify `.gitignore` includes `.env`, `.env.*`, `.env.production`

- [ ] **Deploy**:
  - [ ] Push to `main` branch: `git push origin main`
  - [ ] OR manually trigger in Vercel dashboard:
    - [ ] Go to Vercel Dashboard → Swift project
    - [ ] Click latest commit → "Redeploy"
  - [ ] Wait for build to complete (5-10 minutes)
  - [ ] Verify no deployment errors in Vercel logs

- [ ] **Post-Deploy Verification**:
  - [ ] Check Vercel deployment status (green/success)
  - [ ] Visit `https://www.ai-swift.biz.id` (loads)
  - [ ] Check browser console for errors
  - [ ] Verify Sentry integration (errors being tracked)

### Smoke Testing (Day 7)
Run through entire user flow to ensure everything works:

1. **Authentication**:
   - [ ] Visit `https://www.ai-swift.biz.id`
   - [ ] Click "Sign in with Google"
   - [ ] Complete OAuth flow (authenticate with Google account)
   - [ ] Redirected to dashboard

2. **Workspace & Project Creation**:
   - [ ] Create new workspace (name: "Production Smoke Test")
   - [ ] Create new project (name: "Landing Page Test")
   - [ ] Verify project created in database

3. **Generation Request**:
   - [ ] Send small generation prompt: `Buat landing page SaaS sederhana dengan React dan Tailwind`
   - [ ] Verify:
     - [ ] Job queued (see "Generating..." status)
     - [ ] Job ID assigned
     - [ ] Status updates in real-time
     - [ ] No error: "Queue belum siap"

4. **Generation Processing**:
   - [ ] Monitor VPS worker: `pm2 logs swift-generation-worker --lines 50`
   - [ ] Verify:
     - [ ] Job picked up from Redis queue
     - [ ] OpenRouter API called
     - [ ] Generation completes (5-15 minutes depending on prompt)
     - [ ] Artifact created in Supabase Storage

5. **Preview & Interaction**:
   - [ ] Click "Preview" when generation completes
   - [ ] Verify:
     - [ ] Iframe loads without CORS errors
     - [ ] Generated code renders
     - [ ] No console errors in DevTools
     - [ ] Responsive layout works on mobile view

6. **Balance Deduction**:
   - [ ] Check user balance after generation
   - [ ] Verify:
     - [ ] Balance decreased by 2,000 IDR
     - [ ] Transaction recorded in database
     - [ ] Transaction history shows entry

7. **Retry Functionality**:
   - [ ] Click "Regenerate" or "Retry"
   - [ ] Verify:
     - [ ] New job queued
     - [ ] New generation starts
     - [ ] Can switch between versions

8. **File Upload** (if supported):
   - [ ] Upload small file (< 5 MB):
     - [ ] Create test file (image, document, or code)
     - [ ] Drag/drop or browse to upload
     - [ ] Verify:
       - [ ] File uploaded to Supabase
       - [ ] File URL returned
       - [ ] File accessible in generation context

9. **Error Handling**:
   - [ ] Send malformed/invalid prompt (empty, gibberish)
   - [ ] Verify:
     - [ ] Error message displayed
     - [ ] User experience graceful (no crashes)
     - [ ] Balance not deducted

10. **Database Integrity**:
    - [ ] Connect to production Neon database
    - [ ] Query sample data:
      ```sql
      SELECT COUNT(*) FROM users;
      SELECT COUNT(*) FROM projects;
      SELECT COUNT(*) FROM generations;
      SELECT COUNT(*) FROM transactions;
      ```
    - [ ] Verify counts increased from baseline
    - [ ] No data corruption visible

### Monitoring & Logs
- [ ] **Vercel Logs**:
  - [ ] Check function logs for errors
  - [ ] Check build logs for warnings
  - [ ] Monitor error rates

- [ ] **VPS Logs**:
  - [ ] `pm2 logs swift-generation-worker` - no errors
  - [ ] `pm2 logs swift-sandbox` - no errors
  - [ ] Check system logs: `journalctl -xe | head -50`

- [ ] **Database**:
  - [ ] Connect to Neon: `psql "$DATABASE_URL"`
  - [ ] Check for locks: `SELECT * FROM pg_locks;`
  - [ ] Monitor slow queries (if available)

### Performance Checks
- [ ] **Web Vitals**:
  - [ ] Run `npm run postdeploy:health:prod`
  - [ ] Check LCP (Largest Contentful Paint)
  - [ ] Check CLS (Cumulative Layout Shift)
  - [ ] Check INP (Interaction to Next Paint)

- [ ] **Generation Performance**:
  - [ ] Time first generation (baseline)
  - [ ] Monitor VPS resources: `top -b -n 1`
  - [ ] Check Redis memory: `redis-cli info memory`
  - [ ] Verify queue throughput

## Post-Deployment (Day 8)

### Secret Rotation
- [ ] **Identify Exposed Secrets**:
  - [ ] Check if any secrets visible in:
    - [ ] Chat history with v0 AI
    - [ ] Screenshots taken during setup
    - [ ] Editor output/logs
    - [ ] Git history (verify .env not committed)

- [ ] **Rotate if Exposed**:
  - [ ] Generate new `NEXTAUTH_SECRET`: `openssl rand -base64 32`
  - [ ] Generate new `SANDBOX_SERVICE_TOKEN`: `openssl rand -hex 32`
  - [ ] Regenerate Google OAuth credentials if exposed
  - [ ] Regenerate API keys if exposed
  - [ ] Update on both Vercel and VPS
  - [ ] Restart services: `pm2 restart all`

### Security Hardening
- [ ] **VPS Security**:
  - [ ] Verify UFW enabled: `ufw status`
  - [ ] Verify Fail2ban active: `systemctl status fail2ban`
  - [ ] Check for open ports: `netstat -tlnp`
  - [ ] Rotate root/swift password (optional)

- [ ] **Code Security**:
  - [ ] Run security audit: `npm audit`
  - [ ] Verify no console logs with secrets
  - [ ] Review API routes for CSRF protection
  - [ ] Verify CORS configuration

- [ ] **Data Security**:
  - [ ] Verify database backups configured (Neon)
  - [ ] Verify backup retention policy
  - [ ] Test restore procedure (optional)
  - [ ] Verify encryption in transit (TLS/SSL)
  - [ ] Verify encryption at rest (if applicable)

### Monitoring & Alerting Setup
- [ ] **Application Monitoring**:
  - [ ] Sentry configured for error tracking
  - [ ] Alerts configured for critical errors
  - [ ] Monitor uptime (UptimeRobot or similar)

- [ ] **Infrastructure Monitoring**:
  - [ ] CPU usage alerts configured
  - [ ] Memory usage alerts configured
  - [ ] Disk space alerts configured
  - [ ] VPS restart policy configured

### Documentation & Runbooks
- [ ] **Incident Response**:
  - [ ] Document incident response procedure
  - [ ] Document escalation path
  - [ ] Document rollback procedure
  - [ ] Document emergency contacts

- [ ] **Runbooks**:
  - [ ] Restart services procedure
  - [ ] Restore from backup procedure
  - [ ] Scale up/down procedure
  - [ ] Debug generation failures procedure

### Final Sign-Off
- [ ] **Team Review**:
  - [ ] Code reviewed by team lead
  - [ ] Infrastructure reviewed by DevOps
  - [ ] Security review completed
  - [ ] Performance review completed

- [ ] **Go-Live Approval**:
  - [ ] Product owner approves deployment
  - [ ] No critical issues or P1 bugs
  - [ ] All success criteria met
  - [ ] Team ready for monitoring

## Success Criteria

Production is ready when ALL of the following are true:

1. ✅ `npm audit` shows `0 vulnerabilities`
2. ✅ `npm run typecheck` passes
3. ✅ `npm run lint` passes  
4. ✅ `npm run build` succeeds
5. ✅ `npm run audit:production` passes
6. ✅ `npm run postdeploy:health:prod` passes
7. ✅ All 6 health endpoints respond 200 OK
8. ✅ Vercel deployment successful (green)
9. ✅ VPS services online: `pm2 status` (both "online")
10. ✅ Database connectivity verified
11. ✅ Redis connectivity verified
12. ✅ HTTPS certificate valid and auto-renewing
13. ✅ Firewall configured (SSH/HTTP/HTTPS only)
14. ✅ SSH key-based auth enabled (password disabled)
15. ✅ Smoke test flow completed successfully
16. ✅ No secrets in Git history
17. ✅ No placeholder values in environment
18. ✅ Team sign-off obtained

## Rollback Plan

If critical issues arise post-deployment:

1. **Immediate** (first 5 minutes):
   - [ ] Identify issue severity (P1/P2/P3)
   - [ ] Notify on-call team
   - [ ] Stop accepting new generation requests (optional)

2. **Quick Fix** (if fixable in < 30 minutes):
   - [ ] Identify and fix issue
   - [ ] Test locally
   - [ ] Redeploy to Vercel
   - [ ] Verify fix with health checks

3. **Rollback to Previous Version** (if issue critical):
   - [ ] Go to Vercel Dashboard
   - [ ] Find previous successful deployment
   - [ ] Click "Redeploy" on previous version
   - [ ] Verify rollback successful with health checks
   - [ ] Post-incident review to prevent repeat

4. **Extended Rollback** (if VPS issue):
   - [ ] SSH to VPS: `ssh root@8.215.40.119`
   - [ ] Stop services: `pm2 stop all`
   - [ ] Revert code: `cd /root/swift-runtime && git revert HEAD`
   - [ ] Restart services: `bash scripts/vps-production-deploy.sh`
   - [ ] Verify recovery with health checks

## Reference Commands

### Quick Checks
```bash
# Full production readiness
npm run audit:production
npm run postdeploy:health:prod

# Database status
psql "$DATABASE_URL" -c "SELECT COUNT(*) FROM users;"

# VPS status
ssh root@8.215.40.119
pm2 status
curl https://sandbox.ai-swift.biz.id/health
```

### Emergency Procedures
```bash
# Restart all services
pm2 restart all && pm2 save

# View all logs
pm2 logs

# Stop services
pm2 stop all

# Force rebuild on Vercel
# (via dashboard: Deployments → More → Redeploy)

# Emergency: Kill hung process
pm2 kill && pm2 start ecosystem.config.cjs
```

---

**Deployment Date**: ______________
**Deployed By**: ______________
**Reviewed By**: ______________
**Sign-off Date**: ______________

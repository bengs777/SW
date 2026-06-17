# Swift (Reddy) Production Documentation

This folder contains all documentation needed to deploy Swift to production. Start here if you're preparing for production launch.

## 📋 Documentation Overview

### 1. Start Here: PRODUCTION_READINESS_SUMMARY.md
**Status Overview & Next Steps** (5-10 min read)
- What's complete ✅
- What you need to do next
- Required credentials checklist
- Success criteria
- Quick deployment timeline

👉 **Read this first** to understand the current state and what's needed.

---

## 📚 Detailed Implementation Guides

### 2. VERCEL_ENV_SETUP.md
**Configure Vercel Production Environment** (~30 min setup)

**What it covers:**
- 7 critical Vercel environment variables explained:
  - Database (Neon PostgreSQL)
  - NextAuth credentials
  - Google OAuth setup
  - Supabase integration
  - OpenRouter AI API
  - Redis connection
  - Sandbox service URLs
- Step-by-step Vercel UI instructions
- Validation & testing
- Troubleshooting guide
- Security best practices

**When to use:**
- You're responsible for Vercel environment variables
- You need to understand what each variable does
- You're debugging environment-related issues

---

### 3. VPS_SETUP_GUIDE.md
**Infrastructure Setup & Hardening** (~2-3 hours work)

**What it covers:**
- 7-phase VPS hardening procedure:
  1. Initial system setup (Node 22, PM2, Nginx)
  2. SSH hardening (key-based auth only)
  3. Firewall & Fail2ban configuration
  4. HTTPS certificate setup
  5. Environment variable configuration
  6. Service deployment (generation worker + sandbox)
  7. Verification & monitoring
- Bootstrap script explanation
- Troubleshooting common issues
- Security hardening checklist
- Ongoing maintenance procedures

**When to use:**
- You're deploying to the VPS for the first time
- You need to understand infrastructure setup
- You're troubleshooting VPS-related issues
- You're setting up monitoring/backup

---

### 4. VPS_ENV_SETUP.md
**Environment Variables on VPS** (~30 min setup)

**What it covers:**
- Two environment files:
  - `/home/swift/.env` - Shared configuration (35+ variables)
  - `/home/swift/.env.sandbox` - Sandbox-specific variables
- Database, Redis, OAuth credentials
- Supabase configuration
- Generation worker tuning
- Sandbox resource limits
- File permissions & security
- Complete example files
- Verification checklist

**When to use:**
- You're configuring the VPS environment
- You need to fill in production secrets
- You're troubleshooting connection issues
- You're documenting what each variable does

---

### 5. PRODUCTION_DEPLOYMENT_CHECKLIST.md
**Pre-Launch & Smoke Testing** (~Full day execution)

**What it covers:**
- **Pre-Deployment** (Days 1-6):
  - Security vulnerabilities ✅ (11 fixed)
  - Environment configuration
  - Database setup (Neon)
  - Queue setup (Redis)
  - Storage setup (Supabase)
  - OAuth configuration
  - VPS infrastructure
  - Service verification
  - 40+ pre-launch checklist items

- **Production Deployment** (Day 7):
  - Pre-deploy snapshot
  - Vercel deployment steps
  - Post-deployment verification
  - Full smoke test (10-step user flow)
  - Database integrity checks
  - Performance verification

- **Post-Deployment** (Day 8):
  - Secret rotation procedures
  - Security hardening
  - Monitoring setup
  - Documentation
  - Team sign-off

**When to use:**
- You're running the deployment
- You're performing smoke testing
- You need a step-by-step checklist
- You need to verify post-deployment health

---

## 🚀 Quick Start (For Experienced DevOps)

If you've done this before, here's the condensed path:

```bash
# 1. VPS Setup (one-time, ~2 hours)
ssh root@8.215.40.119
git clone https://github.com/bengs777/SW.git /root/swift-runtime
cd /root/swift-runtime
bash scripts/vps-production-bootstrap.sh
# ... configure DNS, request HTTPS cert ...

# 2. Environment Configuration (~30 min)
# Edit /root/swift-runtime/.env (35+ vars)
# Edit /root/swift-runtime/.env.sandbox
# Add 17 vars to Vercel environment

# 3. Deploy Services (~15 min)
bash scripts/vps-production-deploy.sh

# 4. Smoke Test (~1 hour)
# Follow PRODUCTION_DEPLOYMENT_CHECKLIST.md smoke test section

# 5. Verify Health (~10 min)
npm run postdeploy:health:prod
```

---

## 📊 What's Already Done

### Security
- ✅ All 11 npm vulnerabilities fixed (`npm audit` → 0 vulnerabilities)
- ✅ TypeScript typechecking passes
- ✅ ESLint checks pass
- ✅ Code build completes successfully

### Infrastructure Templates
- ✅ Bootstrap script: `scripts/vps-production-bootstrap.sh`
- ✅ Deployment script: `scripts/vps-production-deploy.sh`
- ✅ PM2 configuration: `ecosystem.config.cjs`
- ✅ Nginx reverse proxy templates

### Code & Architecture
- ✅ Neon PostgreSQL schema (Prisma)
- ✅ Redis/BullMQ queue system
- ✅ Supabase storage integration
- ✅ Google OAuth flow
- ✅ NextAuth configuration
- ✅ OpenRouter AI provider

---

## 📋 Team Assignments

| Responsibility | Owner | Docs to Read |
|---|---|---|
| **Vercel Setup** | DevOps/Admin | VERCEL_ENV_SETUP.md |
| **VPS Infrastructure** | DevOps | VPS_SETUP_GUIDE.md |
| **VPS Configuration** | DevOps/Admin | VPS_ENV_SETUP.md |
| **Deployment Execution** | DevOps | PRODUCTION_DEPLOYMENT_CHECKLIST.md |
| **QA & Smoke Tests** | QA/Product | PRODUCTION_DEPLOYMENT_CHECKLIST.md (Section: Smoke Testing) |
| **Security Hardening** | Security | VPS_SETUP_GUIDE.md + PRODUCTION_DEPLOYMENT_CHECKLIST.md |
| **Monitoring Setup** | DevOps | VPS_SETUP_GUIDE.md (Section: Ongoing Maintenance) |

---

## ⏱️ Estimated Timeline

| Phase | Duration | Owner |
|-------|----------|-------|
| VPS Infrastructure | 2 hours | DevOps |
| Environment Config | 1 hour | DevOps + Admin |
| Service Deployment | 30 min | DevOps |
| Vercel Dashboard Deploy | 15 min | Vercel (automated) |
| Smoke Testing | 1 hour | QA/Product |
| Security Hardening | 30 min | Security |
| **Total** | **~5 hours** | **Team** |

(Can be done in 1-2 days with parallel work)

---

## 🔐 Security Checklist (Pre-Launch)

Before going live:

- [ ] All 11 npm vulnerabilities fixed ✅
- [ ] No secrets in Git repository
- [ ] SSH key-based auth only (password disabled)
- [ ] UFW firewall configured (SSH/HTTP/HTTPS)
- [ ] Fail2ban enabled
- [ ] HTTPS certificate valid and auto-renewing
- [ ] Environment files have mode 600 (secrets not readable)
- [ ] No placeholder values in production environment
- [ ] All database/API connections tested
- [ ] Health endpoints responding 200 OK
- [ ] Monitoring/alerting configured

---

## 🧪 Testing & Validation

### Pre-Deployment
```bash
npm run audit:production      # Check production readiness
npm run build                 # Verify build succeeds
npm run typecheck            # Verify types
npm run lint                 # Verify linting
```

### Post-Deployment
```bash
npm run postdeploy:health:prod  # Full health check
# Should verify all 6 endpoints and services
```

### Manual Smoke Test (See PRODUCTION_DEPLOYMENT_CHECKLIST.md)
1. Sign in with Google OAuth
2. Create workspace and project
3. Send generation prompt
4. Preview generated code
5. Check balance deduction
6. Test retry functionality
7. Upload files
8. Verify database integrity
9. Check performance metrics

---

## 🆘 Troubleshooting Quick Links

**Environment Variables**
- Not set? → See **VERCEL_ENV_SETUP.md** Troubleshooting
- Wrong format? → See **VPS_ENV_SETUP.md** Troubleshooting
- Missing values? → See respective guide's "Verify Configuration"

**VPS Issues**
- Services won't start? → See **VPS_SETUP_GUIDE.md** Troubleshooting
- Port conflicts? → See **VPS_SETUP_GUIDE.md** "Port already in use"
- Certificate errors? → See **VPS_SETUP_GUIDE.md** "Certificate errors"

**Deployment Issues**
- Build fails? → See **PRODUCTION_DEPLOYMENT_CHECKLIST.md** Pre-Deploy section
- Health checks fail? → See **VPS_SETUP_GUIDE.md** Phase 6: Verification
- Services offline? → See **VPS_SETUP_GUIDE.md** "Services won't start"

**Database Issues**
- Connection timeout? → See **VPS_SETUP_GUIDE.md** "Database connection timeouts"
- Neon errors? → Check Neon IP whitelist in console
- Migrations fail? → Ensure using DIRECT_DATABASE_URL (not pooled)

---

## 📞 Getting Help

1. **Check the troubleshooting section** in relevant guide
2. **Review error logs**:
   - Vercel: Dashboard → Deployments → Logs
   - VPS: `pm2 logs swift-generation-worker` or `pm2 logs swift-sandbox`
3. **Test manually**:
   ```bash
   # Test database
   psql "$DATABASE_URL" -c "SELECT 1"
   
   # Test Redis
   redis-cli -u "$REDIS_URL" ping
   
   # Test services
   curl https://sandbox.ai-swift.biz.id/health
   ```
4. **Check health endpoints**:
   - Dashboard: `https://www.ai-swift.biz.id/api/health`
   - Sandbox: `https://sandbox.ai-swift.biz.id/health`
   - Worker: `https://sandbox.ai-swift.biz.id/worker/health`

---

## ✅ Success Criteria

Production is ready when:

1. All npm vulnerabilities fixed (0 found)
2. All health endpoints responding 200 OK
3. VPS services online (PM2 status)
4. HTTPS certificate valid
5. Firewall configured correctly
6. Smoke tests completed successfully
7. No secrets in Git history
8. Team sign-offs obtained
9. Monitoring configured
10. Runbooks documented

See **PRODUCTION_DEPLOYMENT_CHECKLIST.md** for full list.

---

## 📖 Document Relationships

```
┌─ PRODUCTION_READINESS_SUMMARY.md ◄─ START HERE
│  ├─ Overview & status
│  ├─ What's complete
│  └─ What to do next
│
├─ VERCEL_ENV_SETUP.md
│  ├─ 7 critical variables
│  ├─ Setup instructions
│  └─ Troubleshooting
│
├─ VPS_ENV_SETUP.md
│  ├─ /home/swift/.env
│  ├─ /home/swift/.env.sandbox
│  └─ 35+ variables documented
│
├─ VPS_SETUP_GUIDE.md
│  ├─ 7-phase hardening
│  ├─ Bootstrap script walkthrough
│  └─ Monitoring & maintenance
│
└─ PRODUCTION_DEPLOYMENT_CHECKLIST.md
   ├─ Pre-deployment (40+ items)
   ├─ Deployment execution
   ├─ Smoke testing (10-step flow)
   ├─ Post-deployment
   └─ Rollback procedures
```

---

## 🎯 Next Steps

1. **Read**: Start with `PRODUCTION_READINESS_SUMMARY.md` (5 min)
2. **Plan**: Review timeline and team assignments (5 min)
3. **Prepare**: Gather all required credentials (30 min)
4. **Execute**: Follow guides in order:
   - `VPS_SETUP_GUIDE.md` → Bootstrap VPS
   - `VERCEL_ENV_SETUP.md` → Configure Vercel
   - `VPS_ENV_SETUP.md` → Configure VPS
   - `PRODUCTION_DEPLOYMENT_CHECKLIST.md` → Deploy & Test
5. **Verify**: Run all health checks
6. **Monitor**: Set up monitoring for 24-48 hours

---

**Good luck with the production launch!**

For questions about any guide, refer to its troubleshooting section or see the full table of contents at the top of each document.

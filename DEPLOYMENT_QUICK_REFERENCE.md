# Deployment Quick Reference Card

**Print this or keep it handy during deployment**

---

## COMMAND CHEATSHEET

### SSH & Initial Access
```bash
ssh root@8.215.40.119
cd /home/reddy
git checkout production-readiness-plan
```

### Phase 1: Bootstrap
```bash
chmod +x scripts/vps-production-bootstrap.sh
# Then run commands from DEPLOYMENT_STEP_BY_STEP.md Phase 1
```

### Phase 2: Environment
```bash
sudo nano .env.production
# Fill in all required variables

# Test database
NODE_OPTIONS='--require dotenv/config' node -e "const { PrismaClient } = require('@prisma/client'); const prisma = new PrismaClient(); prisma.$disconnect().then(() => console.log('✓ Database connected')).catch(e => console.error('✗ Database error:', e.message));"
```

### Phase 3: Nginx
```bash
sudo nano /etc/nginx/sites-available/ai-swift
# Copy config from DEPLOYMENT_STEP_BY_STEP.md Phase 3.1

sudo ln -s /etc/nginx/sites-available/ai-swift /etc/nginx/sites-enabled/ai-swift
sudo rm /etc/nginx/sites-enabled/default
sudo nginx -t
sudo systemctl reload nginx
```

### Phase 4: Start Services
```bash
# Start all 3 services with PM2
pm2 start ecosystem-worker.cjs
pm2 start ecosystem-sandbox.cjs
pm2 start ecosystem-frontend.cjs
pm2 save

# Verify
pm2 list
pm2 logs service-name --lines 10
```

### Phase 5: DNS & SSL
```bash
# 1. Update DNS at registrar → Point ai-swift.biz.id to 8.215.40.119
# 2. Verify DNS
nslookup ai-swift.biz.id

# 3. Get SSL cert
sudo certbot certonly --nginx -d ai-swift.biz.id -d www.ai-swift.biz.id -m your-email@example.com --agree-tos --non-interactive

# 4. Reload Nginx
sudo systemctl reload nginx
```

### Phase 6: Health Checks
```bash
curl -s https://ai-swift.biz.id/health | jq .
curl -s https://ai-swift.biz.id/health/worker | jq .
curl -s https://ai-swift.biz.id/health/sandbox | jq .
curl -s https://ai-swift.biz.id/api/health/db | jq .
curl -s https://ai-swift.biz.id/api/health/redis | jq .
```

---

## TROUBLESHOOTING

| Problem | Solution |
|---------|----------|
| Can't SSH | Check security group allows port 22 |
| Node not found | Run: `curl -fsSL https://deb.nodesource.com/setup_22.x \| sudo -E bash -` |
| PM2 won't start | `pm2 kill && pm2 resurrect` |
| Nginx error | `sudo nginx -t` to check config |
| SSL error | `sudo certbot renew --force-renewal` |
| Database can't connect | Check DATABASE_URL format & firewall |
| Services keep crashing | Check `pm2 logs service-name` |
| Out of memory | `pm2 kill` & restart services one by one |

---

## CRITICAL VARIABLES

**Must be set before deployment:**

```
DATABASE_URL         - From Neon
DIRECT_URL          - From Neon
SUPABASE_URL        - From Supabase
REDIS_URL           - Local or service
OPENROUTER_API_KEY  - From OpenRouter
GOOGLE_CLIENT_ID    - From Google Cloud
GOOGLE_CLIENT_SECRET - From Google Cloud
SANDBOX_TOKEN       - Generate: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

---

## VERIFICATION CHECKLIST

Before going live:

- [ ] SSH access works
- [ ] Node 22 installed
- [ ] PM2 installed globally
- [ ] Nginx installed & running
- [ ] All .env variables filled
- [ ] Database connection works
- [ ] Redis connection works
- [ ] 3 services running: `pm2 list`
- [ ] DNS points to 8.215.40.119
- [ ] SSL cert installed
- [ ] All 6 health endpoints return 200 OK
- [ ] HTTPS works: `https://ai-swift.biz.id`
- [ ] Smoke test passes (manual test)
- [ ] Monitoring dashboard loads

---

## USEFUL COMMANDS

```bash
# Check what's listening on ports
sudo netstat -tlnp | grep LISTEN

# View service logs
pm2 logs service-name

# Monitor resources
pm2 monit

# Restart services
pm2 restart all

# Check Nginx status
sudo systemctl status nginx

# Check SSL cert expiry
echo | openssl s_client -servername ai-swift.biz.id -connect ai-swift.biz.id:443 2>/dev/null | openssl x509 -noout -dates

# Test database
psql $DATABASE_URL -c "SELECT 1"

# Check firewall
sudo ufw status
```

---

## TIMING

| Phase | Time |
|-------|------|
| 1. Bootstrap | 1-2 hours |
| 2. Environment | 45 min |
| 3. Nginx | 20 min |
| 4. Services | 20 min |
| 5. DNS & SSL | 30 min |
| 6. Health checks | 15 min |
| 7. Vercel | 30 min |
| 8. Smoke tests | 1 hour |
| 9. Monitoring | 20 min |
| 10. Security | 30 min |
| 11. Verification | 15 min |
| **TOTAL** | **~6-8 hours** |

---

## SUCCESS INDICATORS

✅ **You're done when:**

```
1. pm2 list shows 3 services "online"
2. curl https://ai-swift.biz.id responds with homepage
3. https://ai-swift.biz.id has valid SSL cert
4. All 6 health endpoints return 200 OK
5. Can login with Google OAuth
6. Can generate & preview code
7. Can upload generated projects
8. No errors in pm2 logs
9. Database shows successful connections
10. Performance metrics < 2s load time
```

---

## DEPLOYMENT COMPLETE! 🎉

**Access:** https://ai-swift.biz.id

**Status Page:** https://ai-swift.biz.id/status.json

**Need help?** Read full guide: DEPLOYMENT_STEP_BY_STEP.md

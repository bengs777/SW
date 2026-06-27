# PHASE 2: Test Queue & Worker Connections

After completing Phase 1 (env vars fixed), follow these tests to verify everything is working.

## TEST 1: Health Endpoints (2 minutes)

### 1.1 Swift Web Service Health
```bash
curl -s https://ai-swift.biz.id/api/health | jq .
```

Expected response:
```json
{
  "status": "ok",
  "service": "swift-web",
  "timestamp": "2026-06-22T15:30:00.000Z"
}
```

### 1.2 Swift Worker Health
```bash
curl -s https://sandbox.ai-swift.biz.id/worker/health | jq .
```

Expected response:
```json
{
  "status": "ok",
  "worker": "swift-generation-worker",
  "queue": {
    "active": 0,
    "waiting": 0,
    "failed": 0
  }
}
```

### 1.3 Sandbox Service Health
```bash
curl -s https://sandbox.ai-swift.biz.id/health | jq .
```

Expected response:
```json
{
  "status": "ok",
  "service": "swift-sandbox"
}
```

**If any of these fail:**
- Note the error message
- Check PM2 logs: `pm2 logs swift-worker --lines 50`
- Check firewall: `sudo ufw status`
- Verify Nginx: `sudo nginx -t`

## TEST 2: Queue Processing (5 minutes)

### 2.1 Check Redis Connection

On VPS, test Redis:
```bash
redis-cli ping
# Should return: PONG

redis-cli DBSIZE
# Should show number of keys

redis-cli INFO stats
# Should show keyspace hits/misses
```

### 2.2 Check Database Connection

```bash
psql "postgresql://user:password@host.neon.tech/dbname?sslmode=require" -c "SELECT version();"
# Should return PostgreSQL version
```

### 2.3 Test Queue with Sample Generation

```bash
curl -X POST https://ai-swift.biz.id/api/generate/jobs \
  -H "Content-Type: application/json" \
  -d '{
    "prompt": "Create a simple hello world button in React"
  }'
```

Expected response:
```json
{
  "id": "job-xxx",
  "status": "queued",
  "createdAt": "2026-06-22T15:30:00.000Z"
}
```

### 2.4 Check Job Status

```bash
curl -s https://ai-swift.biz.id/api/generate/jobs/job-xxx | jq .
```

Should show:
```json
{
  "id": "job-xxx",
  "status": "processing|completed|failed",
  "progress": 25,
  "result": {...}
}
```

**If job is stuck in "processing" for >30 seconds:**
- Check worker: `pm2 logs swift-worker --lines 100`
- Check if worker is consuming CPU/memory
- Might be hitting the AI API timeout

## TEST 3: End-to-End User Flow (10 minutes)

1. Open https://ai-swift.biz.id in browser
2. Login (or create account if first time)
3. Click "+ Langkukan Prompt"
4. Enter prompt: "Create a simple counter app in React"
5. Click "Start building"
6. Monitor:
   - Does it show "Generating..." status?
   - Does progress bar move?
   - Does it complete in <1 minute?
   - Can you preview the generated code?
   - Can you edit it in the editor?

### 3.1 Common Issues & Fixes

| Issue | Check | Fix |
|-------|-------|-----|
| Prompt takes >2 min | Worker logs | `pm2 restart swift-worker` |
| "Generation failed" error | OpenRouter API key | Verify key in `/home/swift/.env` |
| Can't preview code | Sandbox service | Check `pm2 logs swift-sandbox --lines 20` |
| UI shows "Connection error" | Redis connection | Verify `redis-cli ping` returns PONG |
| Empty response | Database | Check database has tables: `psql ... -c "\dt"` |

## TEST 4: Performance Baseline (5 minutes)

Generate 3 prompts and record:
- Time to generate (from prompt to completion)
- Token usage
- Error rate
- Resource usage on VPS

Example test:
```bash
# Test 1: Simple component
curl -X POST https://ai-swift.biz.id/api/generate/jobs \
  -d '{"prompt":"Button component"}' -H "Content-Type: application/json"

# Test 2: Medium app
curl -X POST https://ai-swift.biz.id/api/generate/jobs \
  -d '{"prompt":"Todo list app with dark mode"}' -H "Content-Type: application/json"

# Test 3: Complex app
curl -X POST https://ai-swift.biz.id/api/generate/jobs \
  -d '{"prompt":"Dashboard with charts and tables"}' -H "Content-Type: application/json"
```

Monitor during tests:
```bash
# On VPS, watch resources
watch 'pm2 monit'

# Or check individual service memory
pm2 show swift-worker
```

## EXPECTED RESULTS

After Phase 2, you should see:

✅ All 3 health endpoints return 200 OK  
✅ Redis responds to ping  
✅ Database queries work  
✅ Sample generation job completes  
✅ User can generate 3 prompts successfully  
✅ Prompt completes in 30-60 seconds  
✅ No 500 or 502 errors  
✅ No memory leaks or crashes  

## TROUBLESHOOTING

### "502 Bad Gateway"
```bash
# Check if Nginx is running
sudo systemctl status nginx

# Check if upstream services are alive
pm2 list
# All should be "online"

# Check Nginx logs
sudo tail -50 /var/log/nginx/error.log
```

### "Connection refused"
```bash
# Check if port is listening
sudo netstat -tulnp | grep 300
# Should show swift-web on port 3000

# Restart service
pm2 restart swift-web
```

### Worker not processing jobs
```bash
# Check if worker is stuck
pm2 show swift-worker

# Look for error patterns in logs
pm2 logs swift-worker | grep -i error

# If stuck, restart
pm2 restart swift-worker
```

## NEXT PHASE

When all Phase 2 tests pass:
- Reply with test results
- We'll move to Phase 3: Optimization & Go-Live

---

**Questions? Send:**
1. Curl command output that's failing
2. Full error message from `pm2 logs swift-worker`
3. Browser console error (F12 → Console tab)

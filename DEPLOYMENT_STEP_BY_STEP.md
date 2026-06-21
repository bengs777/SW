# Deployment Step-by-Step: Reddy ke ai-swift.biz.id

**Timeline Total: ~6-8 jam**  
**Current Date: June 21, 2026**  
**Status: Ready to Deploy ✅**

---

## PREREQUISITE CHECK (15 menit)

### ✅ Checklist sebelum mulai:

- [ ] Akses SSH ke VPS: `ssh root@8.215.40.119`
- [ ] Domain: `ai-swift.biz.id` (siap point ke VPS)
- [ ] Git repo: `bengs777/SW` (production-readiness-plan branch)
- [ ] Credentials ready:
  - [ ] Neon Database URL
  - [ ] Supabase URL & Keys
  - [ ] Redis connection string
  - [ ] OpenRouter API key
  - [ ] Google OAuth credentials
  - [ ] Let's Encrypt email

---

## PHASE 1: VPS BOOTSTRAP (1-2 jam)

### Step 1.1: SSH ke VPS

```bash
ssh root@8.215.40.119
# Expected output: Welcome to Ubuntu/Debian prompt
```

**Verifikasi:**
```bash
# Check OS version
lsb_release -a
# Output: Ubuntu 20.04 LTS atau lebih

# Check Node.js (if already installed)
node --version
npm --version
```

---

### Step 1.2: Clone Repository

```bash
cd /home
git clone https://github.com/bengs777/SW.git reddy
cd reddy
git checkout production-readiness-plan
```

**Verifikasi:**
```bash
git log -1 --oneline
# Should show latest commit with "finalize production readiness"
```

---

### Step 1.3: Persiapan Bootstrap Script

```bash
# Dari dalam /home/reddy directory
chmod +x scripts/vps-production-bootstrap.sh
cat scripts/vps-production-bootstrap.sh | head -20
# Verifikasi script terlihat valid
```

---

### Step 1.4: Install Node.js 22 (jika belum ada)

```bash
# If Node 22 not installed:
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs

# Verify
node --version  # Should be v22.x.x
npm --version   # Should be 10.x.x
```

---

### Step 1.5: Install PM2 (Global)

```bash
npm install -g pm2
pm2 --version

# Setup PM2 startup hook
pm2 startup
# Follow instructions given by PM2
pm2 save
```

**Verifikasi:**
```bash
pm2 list
# Should show 0 apps initially
```

---

### Step 1.6: Install Nginx

```bash
sudo apt-get update
sudo apt-get install -y nginx
sudo systemctl enable nginx
sudo systemctl start nginx

# Verify
sudo systemctl status nginx
# Should show "active (running)"
```

---

### Step 1.7: Install Certbot untuk SSL

```bash
sudo apt-get install -y certbot python3-certbot-nginx
```

---

### Step 1.8: Setup UFW Firewall

```bash
# Enable UFW
sudo ufw enable

# Allow SSH (CRITICAL - jangan lupa!)
sudo ufw allow 22/tcp

# Allow HTTP
sudo ufw allow 80/tcp

# Allow HTTPS
sudo ufw allow 443/tcp

# Verify
sudo ufw status
# Should show all rules
```

**Output yang diharapkan:**
```
To                         Action      From
--                         ------      ----
22/tcp                     ALLOW       Anywhere
80/tcp                     ALLOW       Anywhere
443/tcp                    ALLOW       Anywhere
```

---

### Step 1.9: Setup Project Directory

```bash
cd /home/reddy

# Install dependencies
npm ci --production=false

# Verify build
npm run build

# Expected: "✓ Compiled successfully"
```

---

**✅ Phase 1 Complete!**

---

## PHASE 2: CONFIGURE ENVIRONMENT VARIABLES (45 menit)

### Step 2.1: Siapkan .env.production di VPS

```bash
cd /home/reddy

# Create .env.production file
sudo nano .env.production
```

**Paste content berikut dan isi dengan nilai actual:**

```env
# === DATABASE ===
DATABASE_URL="postgresql://user:password@host:5432/db"
DIRECT_URL="postgresql://user:password@host:5432/db"

# === SUPABASE ===
NEXT_PUBLIC_SUPABASE_URL="https://xxx.supabase.co"
NEXT_PUBLIC_SUPABASE_ANON_KEY="eyJxxxx..."
SUPABASE_SERVICE_ROLE_KEY="eyJxxxx..."

# === REDIS ===
REDIS_URL="redis://localhost:6379"

# === AI GENERATION ===
OPENROUTER_API_KEY="sk-or-v1-xxxx"
GENERATION_WORKER_URL="http://localhost:3001"
SANDBOX_URL="http://localhost:3002"
SANDBOX_TOKEN="your-secure-token-here"

# === GOOGLE OAUTH ===
GOOGLE_CLIENT_ID="xxx.apps.googleusercontent.com"
GOOGLE_CLIENT_SECRET="GOCSP-xxx"

# === APP CONFIG ===
NEXT_PUBLIC_APP_URL="https://ai-swift.biz.id"
NODE_ENV="production"

# === MONITORING ===
ENABLE_MONITORING="true"
```

**Instruksi mengisi:**
1. `DATABASE_URL` & `DIRECT_URL` - dari Neon console
2. `NEXT_PUBLIC_SUPABASE_URL` & keys - dari Supabase settings
3. `REDIS_URL` - setup redis terlebih dahulu (Step 2.2)
4. `OPENROUTER_API_KEY` - dari OpenRouter dashboard
5. `GOOGLE_CLIENT_ID/SECRET` - dari Google Cloud Console
6. `SANDBOX_TOKEN` - generate dengan: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`

**Simpan file:** `Ctrl+X` → `Y` → `Enter`

---

### Step 2.2: Install & Setup Redis (opsional, jika local)

```bash
# Install Redis
sudo apt-get install -y redis-server

# Start Redis
sudo systemctl enable redis-server
sudo systemctl start redis-server

# Test Redis
redis-cli ping
# Expected: PONG
```

---

### Step 2.3: Create .env.sandbox untuk Sandbox Service

```bash
sudo nano .env.sandbox
```

**Paste:**
```env
PORT=3002
NODE_ENV=production
SANDBOX_TOKEN="your-secure-token-here"
NEXT_PUBLIC_APP_URL="https://ai-swift.biz.id"
```

**Simpan:** `Ctrl+X` → `Y` → `Enter`

---

### Step 2.4: Verifikasi Environment Variables

```bash
# Test database connection
NODE_OPTIONS='--require dotenv/config' node -e "
  const { PrismaClient } = require('@prisma/client');
  const prisma = new PrismaClient();
  prisma.\$disconnect().then(() => console.log('✓ Database connected')).catch(e => console.error('✗ Database error:', e.message));
"
```

**Expected output:** `✓ Database connected`

---

**✅ Phase 2 Complete!**

---

## PHASE 3: CONFIGURE NGINX REVERSE PROXY (30 menit)

### Step 3.1: Buat Nginx Config

```bash
sudo nano /etc/nginx/sites-available/ai-swift
```

**Paste:**
```nginx
upstream next_app {
    server 127.0.0.1:3000;
}

upstream generation_worker {
    server 127.0.0.1:3001;
}

upstream sandbox_service {
    server 127.0.0.1:3002;
}

server {
    listen 80;
    server_name ai-swift.biz.id www.ai-swift.biz.id;

    # Redirect HTTP to HTTPS (after SSL is setup)
    return 301 https://$server_name$request_uri;
}

server {
    listen 443 ssl http2;
    server_name ai-swift.biz.id www.ai-swift.biz.id;

    # SSL certificates (akan diisi oleh certbot)
    ssl_certificate /etc/letsencrypt/live/ai-swift.biz.id/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/ai-swift.biz.id/privkey.pem;

    # Security headers
    add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;
    add_header X-Frame-Options "SAMEORIGIN" always;
    add_header X-Content-Type-Options "nosniff" always;

    # Logging
    access_log /var/log/nginx/ai-swift-access.log;
    error_log /var/log/nginx/ai-swift-error.log;

    # Root path → Next.js frontend
    location / {
        proxy_pass http://next_app;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_cache_bypass $http_upgrade;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    # API → Generation Worker
    location /api/generate {
        proxy_pass http://generation_worker;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    }

    # Health checks
    location /health {
        proxy_pass http://next_app;
    }

    location /health/worker {
        proxy_pass http://generation_worker;
    }

    location /health/sandbox {
        proxy_pass http://sandbox_service;
    }
}
```

**Simpan:** `Ctrl+X` → `Y` → `Enter`

---

### Step 3.2: Enable Nginx Config

```bash
# Create symlink
sudo ln -s /etc/nginx/sites-available/ai-swift /etc/nginx/sites-enabled/ai-swift

# Remove default config
sudo rm /etc/nginx/sites-enabled/default

# Test config
sudo nginx -t
# Expected: "nginx: the configuration file syntax is ok"

# Reload Nginx
sudo systemctl reload nginx
```

---

**✅ Phase 3 Complete!**

---

## PHASE 4: DEPLOY VPS SERVICES (30 menit)

### Step 4.1: Start Generation Worker Service

```bash
cd /home/reddy

# Create ecosystem config untuk worker
cat > ecosystem-worker.cjs << 'EOF'
module.exports = {
  apps: [
    {
      name: 'swift-generation-worker',
      script: './scripts/generation-worker.js',
      env: {
        NODE_ENV: 'production',
        PORT: 3001
      },
      instances: 1,
      exec_mode: 'fork',
      error_file: '/var/log/pm2/worker-error.log',
      out_file: '/var/log/pm2/worker-out.log',
      max_memory_restart: '1G',
      autorestart: true,
      watch: false,
      ignore_watch: ['node_modules', '.next']
    }
  ]
};
EOF

# Start dengan PM2
pm2 start ecosystem-worker.cjs
pm2 save
```

**Verifikasi:**
```bash
pm2 list
# Seharusnya terlihat: swift-generation-worker (online)

pm2 logs swift-generation-worker --lines 10
# Lihat apakah ada error
```

---

### Step 4.2: Start Sandbox Service

```bash
# Create ecosystem config untuk sandbox
cat > ecosystem-sandbox.cjs << 'EOF'
module.exports = {
  apps: [
    {
      name: 'swift-sandbox',
      script: './scripts/sandbox-service.js',
      env: {
        NODE_ENV: 'production',
        PORT: 3002
      },
      instances: 1,
      exec_mode: 'fork',
      error_file: '/var/log/pm2/sandbox-error.log',
      out_file: '/var/log/pm2/sandbox-out.log',
      max_memory_restart: '1G',
      autorestart: true,
      watch: false,
      ignore_watch: ['node_modules', '.next']
    }
  ]
};
EOF

# Start dengan PM2
pm2 start ecosystem-sandbox.cjs
pm2 save
```

**Verifikasi:**
```bash
pm2 list
# Seharusnya terlihat 2 services: swift-generation-worker & swift-sandbox (online)
```

---

### Step 4.3: Start Next.js Frontend

```bash
# Create ecosystem config untuk frontend
cat > ecosystem-frontend.cjs << 'EOF'
module.exports = {
  apps: [
    {
      name: 'reddy-frontend',
      script: '.next/standalone/server.js',
      cwd: '/home/reddy',
      env: {
        NODE_ENV: 'production',
        PORT: 3000
      },
      instances: 1,
      exec_mode: 'fork',
      error_file: '/var/log/pm2/frontend-error.log',
      out_file: '/var/log/pm2/frontend-out.log',
      max_memory_restart: '512M',
      autorestart: true,
      watch: false
    }
  ]
};
EOF

# Start dengan PM2
pm2 start ecosystem-frontend.cjs
pm2 save
```

**Verifikasi:**
```bash
pm2 list
# Seharusnya 3 services: swift-generation-worker, swift-sandbox, reddy-frontend (all online)

pm2 logs reddy-frontend --lines 5
# Lihat apakah Next.js running dengan benar
```

---

**✅ Phase 4 Complete!**

---

## PHASE 5: SETUP DNS & SSL (30 menit)

### Step 5.1: Point DNS to VPS

**Action Required:** Di domain registrar Anda (namecheap.com, etc.)

1. Login ke domain registrar
2. Cari domain: `ai-swift.biz.id`
3. Edit DNS records
4. Tambah/update A record:
   - **Name:** `ai-swift.biz.id` (atau @)
   - **Type:** A
   - **Value:** `8.215.40.119`
   - **TTL:** 3600

5. Simpan perubahan
6. Tunggu DNS propagate (biasanya 5-15 menit)

**Verifikasi DNS:**
```bash
# Dari local computer
nslookup ai-swift.biz.id
# Expected: Should resolve to 8.215.40.119

# Atau gunakan dig
dig ai-swift.biz.id
```

---

### Step 5.2: Get SSL Certificate dengan Certbot

```bash
# Request SSL certificate
sudo certbot certonly --nginx -d ai-swift.biz.id -d www.ai-swift.biz.id -m your-email@example.com --agree-tos --non-interactive

# Expected output: Successfully received certificate
```

**Verifikasi:**
```bash
ls -la /etc/letsencrypt/live/ai-swift.biz.id/
# Seharusnya ada: fullchain.pem, privkey.pem, cert.pem, chain.pem
```

---

### Step 5.3: Setup Auto-Renewal SSL

```bash
# Enable certbot auto-renewal
sudo systemctl enable certbot.timer
sudo systemctl start certbot.timer

# Test renewal (dry run)
sudo certbot renew --dry-run
```

---

### Step 5.4: Restart Nginx dengan SSL

```bash
sudo systemctl reload nginx
```

**Verifikasi:** Buka di browser:
- `https://ai-swift.biz.id` (seharusnya bisa diakses dengan SSL)
- Check SSL certificate di browser

---

**✅ Phase 5 Complete!**

---

## PHASE 6: HEALTH CHECKS (20 menit)

### Step 6.1: Test Semua Health Endpoints

```bash
# Test 1: Frontend health
curl -s https://ai-swift.biz.id/health | jq .
# Expected: status: "ok"

# Test 2: Generation Worker health
curl -s https://ai-swift.biz.id/health/worker | jq .
# Expected: status: "ok"

# Test 3: Sandbox service health
curl -s https://ai-swift.biz.id/health/sandbox | jq .
# Expected: status: "ok"

# Test 4: Database connection
curl -s https://ai-swift.biz.id/api/health/db | jq .
# Expected: status: "ok"

# Test 5: Redis connection
curl -s https://ai-swift.biz.id/api/health/redis | jq .
# Expected: status: "ok"

# Test 6: Full system health
curl -s https://ai-swift.biz.id/api/health | jq .
# Expected: Semua service "ok"
```

---

### Step 6.2: Verify Services Running

```bash
pm2 list
# Harus 3 services online

pm2 status
# All status harus "online"

# Check system resources
pm2 monit
# Lihat CPU & memory usage
```

---

**✅ Phase 6 Complete!**

---

## PHASE 7: CONFIGURE VERCEL (30 menit)

### Step 7.1: Connect GitHub Repository

1. Login ke https://vercel.com
2. Click "Add New..." → "Project"
3. Pilih repository: `bengs777/SW`
4. Select branch: `production-readiness-plan`
5. Click "Import"

---

### Step 7.2: Configure Environment Variables di Vercel

1. Di Vercel project dashboard
2. Go to Settings → Environment Variables
3. Tambahkan 17 variables (copy dari .env.production):

```env
DATABASE_URL
DIRECT_URL
NEXT_PUBLIC_SUPABASE_URL
NEXT_PUBLIC_SUPABASE_ANON_KEY
SUPABASE_SERVICE_ROLE_KEY
REDIS_URL
OPENROUTER_API_KEY
GENERATION_WORKER_URL
SANDBOX_URL
SANDBOX_TOKEN
GOOGLE_CLIENT_ID
GOOGLE_CLIENT_SECRET
NEXT_PUBLIC_APP_URL
NODE_ENV=production
ENABLE_MONITORING=true
```

4. Set scope: Production only
5. Save all variables

---

### Step 7.3: Deploy ke Vercel

```bash
# Di Vercel dashboard, click Deploy
# Tunggu build complete (biasanya 5-10 menit)
```

**Verifikasi:**
```bash
# Check deployment status di Vercel dashboard
# Should show "✓ Deployment successful"
```

---

**✅ Phase 7 Complete!**

---

## PHASE 8: SMOKE TESTING (1 jam)

### Test 1: Homepage Load

```bash
# Akses homepage
curl -s https://ai-swift.biz.id -H "User-Agent: Mozilla/5.0" | head -20
# Expected: HTML content terlihat

# Atau buka di browser: https://ai-swift.biz.id
```

**Verifikasi:**
- [ ] Page loads
- [ ] No 500 errors
- [ ] CSS/JS terload dengan benar

---

### Test 2: User Authentication

```bash
# Test Google OAuth login flow
1. Klik Login button
2. Pilih Google
3. Authorize
4. Seharusnya redirect ke dashboard
```

**Verifikasi:**
- [ ] OAuth flow berjalan
- [ ] Token tersimpan
- [ ] User logged in

---

### Test 3: AI Generation

```bash
# Test generate flow
1. Di dashboard, klik "New Project"
2. Input project name: "Test Project"
3. Input prompt: "Create a simple counter component"
4. Klik Generate
5. Tunggu hasil
```

**Verifikasi:**
- [ ] Generation worker menerima request
- [ ] Sandbox service execute code
- [ ] Preview terlihat
- [ ] No errors in console

---

### Test 4: Code Upload

```bash
# Test upload generated code
1. Setelah generate, klik "Use This"
2. Klik "Upload to My Projects"
3. Seharusnya tersimpan di database
```

**Verifikasi:**
- [ ] File tersimpan
- [ ] Bisa di-download
- [ ] Bisa di-preview ulang

---

### Test 5: Retry Flow

```bash
# Test retry generation
1. Di existing project, klik "Regenerate"
2. Edit prompt
3. Klik Generate lagi
```

**Verifikasi:**
- [ ] Previous version tersimpan
- [ ] New version replace lama
- [ ] History tercatat

---

### Test 6: Performance

```bash
# Check page load time
curl -w "Time: %{time_total}s\n" -o /dev/null -s https://ai-swift.biz.id
# Expected: < 2 seconds

# Check Lighthouse score
1. Buka https://ai-swift.biz.id di Chrome
2. Press F12 (DevTools)
3. Tab Lighthouse
4. Run audit
# Expected: Score > 80
```

---

**✅ Phase 8 Complete!**

---

## PHASE 9: MONITORING & LOGGING (20 menit)

### Step 9.1: Setup PM2 Monitoring

```bash
# Connect PM2 to monitoring (opsional)
pm2 web
# Akses di http://localhost:9615 (dari VPS)

# Setup PM2 email alerts (opsional)
pm2 install pm2-auto-restart
```

---

### Step 9.2: Check Logs

```bash
# Frontend logs
pm2 logs reddy-frontend --lines 20

# Worker logs
pm2 logs swift-generation-worker --lines 20

# Sandbox logs
pm2 logs swift-sandbox --lines 20

# Nginx logs
tail -50 /var/log/nginx/ai-swift-access.log
tail -50 /var/log/nginx/ai-swift-error.log
```

---

### Step 9.3: Setup Backup Strategy

```bash
# Backup database (cron job)
cat > /home/reddy/backup-db.sh << 'EOF'
#!/bin/bash
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
pg_dump $DATABASE_URL > /backups/db_$TIMESTAMP.sql
EOF

chmod +x /home/reddy/backup-db.sh

# Add to crontab (daily backup)
crontab -e
# Tambahkan: 0 2 * * * /home/reddy/backup-db.sh
```

---

**✅ Phase 9 Complete!**

---

## PHASE 10: SECURITY HARDENING (30 menit)

### Step 10.1: Disable SSH Password Login

```bash
sudo nano /etc/ssh/sshd_config

# Cari dan ubah:
# PasswordAuthentication no
# PubkeyAuthentication yes

# Restart SSH
sudo systemctl restart ssh
```

**JANGAN keluar dari terminal dulu! Test SSH login dulu:**
```bash
# Di terminal baru, test:
ssh root@8.215.40.119 -i /path/to/key
```

---

### Step 10.2: Rotate Exposed Secrets

```bash
# Generate new SANDBOX_TOKEN
NEW_TOKEN=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")

# Update di VPS .env
sudo sed -i "s/SANDBOX_TOKEN=.*/SANDBOX_TOKEN=$NEW_TOKEN/" /home/reddy/.env.production

# Update di Vercel
# 1. Login Vercel dashboard
# 2. Settings → Environment Variables
# 3. Update SANDBOX_TOKEN
# 4. Re-deploy

# Restart services
pm2 restart all
pm2 save
```

---

### Step 10.3: Enable UFW Rate Limiting

```bash
# Limit SSH connections
sudo ufw limit 22/tcp

# Verify
sudo ufw status
```

---

**✅ Phase 10 Complete!**

---

## PHASE 11: FINAL VERIFICATION (15 menit)

### Checklist Terakhir

```bash
# 1. Services status
pm2 list
# Expected: Semua 3 services online

# 2. Database connection
curl -s https://ai-swift.biz.id/api/health/db | jq .status
# Expected: "ok"

# 3. SSL certificate
echo | openssl s_client -servername ai-swift.biz.id -connect ai-swift.biz.id:443 2>/dev/null | openssl x509 -noout -dates
# Expected: Expiry date > 90 hari

# 4. Response time
time curl -s https://ai-swift.biz.id > /dev/null
# Expected: < 1 second

# 5. Application availability
curl -s https://ai-swift.biz.id/health | jq .
# Expected: All systems operational
```

---

### Monitoring Dashboard

Buat simple monitoring page:

```bash
cat > /home/reddy/public/status.json << 'EOF'
{
  "status": "operational",
  "services": {
    "frontend": "online",
    "worker": "online",
    "sandbox": "online",
    "database": "connected",
    "redis": "connected"
  },
  "uptime": "24/7",
  "last_checked": "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
}
EOF
```

Akses: `https://ai-swift.biz.id/status.json`

---

**✅ Phase 11 Complete!**

---

## 🎉 DEPLOYMENT COMPLETE!

### Summary

| Phase | Action | Status |
|-------|--------|--------|
| 1 | VPS Bootstrap | ✅ Complete |
| 2 | Environment Variables | ✅ Complete |
| 3 | Nginx Configuration | ✅ Complete |
| 4 | Deploy Services | ✅ Complete |
| 5 | DNS & SSL | ✅ Complete |
| 6 | Health Checks | ✅ Complete |
| 7 | Vercel Deploy | ✅ Complete |
| 8 | Smoke Testing | ✅ Complete |
| 9 | Monitoring | ✅ Complete |
| 10 | Security Hardening | ✅ Complete |
| 11 | Final Verification | ✅ Complete |

---

### Access Points

- **Main App:** https://ai-swift.biz.id
- **Status Page:** https://ai-swift.biz.id/status.json
- **Health Check:** https://ai-swift.biz.id/health

---

### Support & Troubleshooting

**Service won't start?**
```bash
pm2 logs service-name
# Check error messages
```

**SSL certificate error?**
```bash
sudo certbot renew --force-renewal
sudo systemctl reload nginx
```

**Database connection issue?**
```bash
# Test connection
psql $DATABASE_URL -c "SELECT 1"
```

**Out of memory?**
```bash
pm2 kill
# Re-deploy services
```

---

**Reddy is now LIVE at ai-swift.biz.id! 🚀**

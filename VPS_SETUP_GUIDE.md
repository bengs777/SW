# VPS Setup and Hardening Guide

## Overview

This guide walks through setting up and hardening the VPS at **8.215.40.119** for production deployment of Swift (Reddy). The VPS runs two services:
- **Sandbox Runtime** (port 8080): Executes generated code in isolated environments
- **Generation Worker** (port 4000): Processes generation jobs from Redis queue

### Prerequisites

- VPS IP: `8.215.40.119`
- Domain: `sandbox.ai-swift.biz.id` (DNS must point to this IP)
- SSH access with `sudo` privileges
- Root password or SSH key available

## Phase 1: Initial VPS Setup (30-45 minutes)

### Step 1.1: Connect to VPS

```bash
# With password
ssh root@8.215.40.119
# Then enter password when prompted

# Or with SSH key
ssh -i /path/to/key.pem root@8.215.40.119
```

### Step 1.2: Update System

```bash
apt-get update
apt-get upgrade -y
```

### Step 1.3: Run Bootstrap Script

The Swift repository includes an automated bootstrap script that installs everything:

```bash
# Clone the repository (as root)
git clone https://github.com/bengs777/SW.git /root/swift-runtime
cd /root/swift-runtime

# Run bootstrap (handles Node, PM2, Nginx, firewall, SSL prep)
bash scripts/vps-production-bootstrap.sh
```

**What this script does:**
- Installs base packages (git, curl, jq, build-essential, etc.)
- Installs Node.js 22 and PM2
- Clones/updates the Swift repo
- Installs dependencies (npm ci)
- Creates placeholder `.env` and `.env.sandbox` files (mode 600)
- Creates sandbox storage directory (`/data/swift-sandbox`)
- Configures UFW firewall (SSH, HTTP, HTTPS only)
- Configures Nginx as reverse proxy
- Prepares for HTTPS certificate setup

**Expected output at end:**
```
[swift-bootstrap] bootstrap finished.

Next:
1. Fill /root/swift-runtime/.env and /root/swift-runtime/.env.sandbox...
2. Generate a fresh SANDBOX_SERVICE_TOKEN...
3. Run: bash scripts/vps-production-deploy.sh
```

## Phase 2: Security Hardening (20-30 minutes)

### Step 2.1: Create Non-Root User (Optional but Recommended)

While the bootstrap creates `swift` user automatically on some systems, ensure it exists:

```bash
# Create swift user if not exists
if ! id -u swift 2>/dev/null; then
  useradd -m -s /bin/bash swift
  # Add to sudoers
  echo "swift ALL=(ALL) NOPASSWD:ALL" >> /etc/sudoers.d/swift
fi

# Verify
id swift
```

### Step 2.2: SSH Hardening

Restrict SSH to key-based authentication (disable password login):

```bash
# Edit SSH config
nano /etc/ssh/sshd_config

# Find and change these lines:
# PermitRootLogin prohibit-password  (change to 'no')
# PasswordAuthentication no
# PubkeyAuthentication yes

# Apply:
systemctl reload sshd

# Verify connection works before closing SSH
# (open new terminal, test: ssh root@8.215.40.119)
```

### Step 2.3: Firewall Configuration

Verify UFW is enabled and configured correctly:

```bash
# Check status
ufw status

# Expected output:
# Status: active
#
# To                         Action      From
# --                         ------      ----
# OpenSSH                    ALLOW       Anywhere
# 80/tcp                     ALLOW       Anywhere
# 443/tcp                    ALLOW       Anywhere

# If not configured, run:
ufw default deny incoming
ufw default allow outgoing
ufw allow ssh
ufw allow 80/tcp
ufw allow 443/tcp
ufw enable
```

### Step 2.4: Enable Fail2ban (Brute-force Protection)

Prevent repeated failed SSH login attempts:

```bash
# Start Fail2ban
systemctl enable fail2ban
systemctl start fail2ban

# Verify
systemctl status fail2ban
fail2ban-client status sshd
```

### Step 2.5: Rotate Root Password

Change root password to something strong (since you now have key-based SSH):

```bash
# Only if using password, or for emergency recovery
passwd root
# Enter new password (16+ characters, mixed case + numbers + symbols)
```

## Phase 3: Certificate Setup (10-15 minutes)

### Step 3.1: DNS Verification

Ensure DNS points to this VPS before requesting certificate:

```bash
# Test DNS resolution
nslookup sandbox.ai-swift.biz.id
# Should return: 8.215.40.119

# Or use dig
dig sandbox.ai-swift.biz.id +short
# Should return: 8.215.40.119
```

Wait until DNS propagates (~5-15 minutes). Test from your local machine:

```bash
ping sandbox.ai-swift.biz.id
# Should resolve to 8.215.40.119
```

### Step 3.2: Request HTTPS Certificate

Once DNS is verified:

```bash
# Request Let's Encrypt certificate
certbot --nginx -d sandbox.ai-swift.biz.id \
  --non-interactive --agree-tos -m your-email@example.com

# Verify auto-renewal
certbot renew --dry-run

# Check certificate details
certbot certificates
```

**Expected output:**
```
Congratulations! Your certificate has been issued and installed.
Your new certificate expires on YYYY-MM-DD.
```

## Phase 4: Environment Configuration (20-30 minutes)

See separate `VPS_ENV_SETUP.md` for detailed environment variable configuration.

Quick summary:

```bash
# Edit main environment file
nano /root/swift-runtime/.env

# Add all production variables (database, Redis, OAuth, etc.)
# Permissions should be 600 (already set by bootstrap)
chmod 600 /root/swift-runtime/.env

# Edit sandbox-specific environment
nano /root/swift-runtime/.env.sandbox

# Add sandbox variables
chmod 600 /root/swift-runtime/.env.sandbox

# Verify no placeholder values
grep -i "example\|replace\|todo\|<.*>" /root/swift-runtime/.env
# Should return nothing
```

## Phase 5: Service Deployment (15-20 minutes)

### Step 5.1: Prepare Directory Permissions

```bash
# If services will run as swift user (recommended):
sudo chown -R swift:swift /root/swift-runtime
sudo chown -R swift:swift /data/swift-sandbox

# Or if as root (less recommended but working):
chmod 755 /root/swift-runtime
chmod 700 /data/swift-sandbox
```

### Step 5.2: Run Deployment Script

```bash
cd /root/swift-runtime

# Run deployment
bash scripts/vps-production-deploy.sh
```

**What this does:**
1. Validates all environment variables are set (no placeholders)
2. Pulls latest code from main branch
3. Installs/updates npm dependencies
4. Generates Prisma client
5. Starts/restarts PM2 services
6. Runs health checks on both services
7. Verifies deployment readiness

**Expected output:**
```
[swift-deploy] checking env files without printing secret values
[swift-deploy] pulling latest main
[swift-deploy] installing dependencies
[swift-deploy] starting/restarting PM2 services
[swift-deploy] checking local sandbox: http://127.0.0.1:8080/health
[swift-deploy] checking local worker: http://127.0.0.1:4000/health
[swift-deploy] checking public sandbox: https://sandbox.ai-swift.biz.id/health
[swift-deploy] checking public worker: https://sandbox.ai-swift.biz.id/worker/health
[swift-deploy] deploy finished
```

### Step 5.3: Verify Services are Running

```bash
# Check PM2 status
pm2 status

# Expected output:
# ┌─────────┬──────────┬──────────┬──────────┬─────────┐
# │ Name    │ id │ mode   │ status   │ uptime  │
# ├─────────┼──────────┼──────────┼──────────┼─────────┤
# │ swift-  │ 0  │ fork   │ online   │ 2m      │
# │ generat │    │        │          │         │
# │ swift-  │ 1  │ fork   │ online   │ 2m      │
# │ sandbox │    │        │          │         │
# └─────────┴──────────┴──────────┴──────────┴─────────┘

# View logs
pm2 logs swift-generation-worker --lines 20
pm2 logs swift-sandbox --lines 20
```

## Phase 6: Verification & Testing (15-20 minutes)

### Step 6.1: Local Health Checks

```bash
# Sandbox health (should return 200 JSON)
curl http://127.0.0.1:8080/health | jq .

# Worker health (should return 200 JSON)
curl http://127.0.0.1:4000/health | jq .

# Expected response structure:
# {
#   "status": "ok",
#   "service": "swift-sandbox",
#   "checkedAt": "2024-06-17T...",
#   "uptime": 123.45
# }
```

### Step 6.2: Public Health Checks

```bash
# Through Nginx reverse proxy
curl https://sandbox.ai-swift.biz.id/health
curl https://sandbox.ai-swift.biz.id/worker/health
```

### Step 6.3: Database Connectivity

```bash
# Test Neon PostgreSQL connection
psql "$DATABASE_URL" -c "SELECT version();"

# Should return PostgreSQL version info
```

### Step 6.4: Redis Connectivity

```bash
# Test Redis connection (if redis-cli installed)
redis-cli -u "$REDIS_URL" ping
# Should return: PONG

# Or test via Node
node -e "const Redis = require('ioredis'); const r = new Redis(process.env.REDIS_URL); r.ping().then(() => console.log('Redis OK')).catch(e => console.error('Redis failed:', e.message))"
```

### Step 6.5: PM2 Process Monitoring

```bash
# Enable PM2 autorestart on system boot
pm2 startup systemd -u root --hp /root
pm2 save

# Verify PM2 will start on reboot
systemctl status pm2-root

# Test restart
pm2 restart swift-generation-worker swift-sandbox
pm2 status
```

## Phase 7: Ongoing Maintenance

### Regular Monitoring

```bash
# Check service status
pm2 status

# Monitor resource usage (CPU, memory)
pm2 monit

# View logs in real-time
pm2 logs swift-generation-worker --follow

# List processes by memory usage
ps aux --sort=-%mem | head -10
```

### Certificate Renewal

Certbot automatically renews certificates 30 days before expiry:

```bash
# Verify renewal is working
certbot renew --dry-run

# Force renewal if needed
certbot renew --force-renewal

# Check next renewal date
certbot certificates
```

### Backup Environment Variables

Keep environment values in a secure location (password manager or encrypted backup):

```bash
# Create a backup of env file (NOT in Git!)
# Store offline in secure vault
# Do NOT email or share unencrypted
```

## Troubleshooting

### Services won't start

```bash
# Check PM2 error logs
pm2 logs swift-generation-worker --err
pm2 logs swift-sandbox --err

# Verify environment variables
cat /root/swift-runtime/.env | head -20
# (Should show values, not blank lines)

# Check permissions
ls -la /root/swift-runtime/.env /root/swift-runtime/.env.sandbox
# Should show: -rw------- (600)

# Try starting manually to see errors
cd /root/swift-runtime
node services/sandbox-runtime/dist/index.js
# (Ctrl+C to stop)
```

### Port already in use

```bash
# Find process using port 8080
lsof -i :8080

# Find process using port 4000
lsof -i :4000

# Kill if needed
kill -9 <PID>

# Or restart PM2
pm2 kill && pm2 startup && pm2 start ecosystem.config.cjs
```

### Certificate errors

```bash
# Check certificate validity
openssl s_client -connect sandbox.ai-swift.biz.id:443 -brief

# Check Nginx config
nginx -t

# View Certbot logs
tail -50 /var/log/letsencrypt/letsencrypt.log
```

### Database connection timeouts

```bash
# Test connection
psql "$DATABASE_URL" -c "SELECT 1"

# Check if Neon allows connections from VPS IP
# (May need to whitelist 8.215.40.119 in Neon console)

# Test with nc/telnet
nc -zv <neon-host> 5432
```

### High memory/CPU usage

```bash
# Check which process is consuming resources
top -b -n 1 | head -20

# Restart specific service
pm2 restart swift-generation-worker

# Check sandbox limits in .env.sandbox
grep SWIFT_SANDBOX_ /root/swift-runtime/.env.sandbox

# May need to lower limits if VPS is underpowered
```

## Security Checklist

After completing all steps:

- [ ] UFW firewall enabled, only SSH/HTTP/HTTPS open
- [ ] SSH key-based auth only (password login disabled)
- [ ] Root password rotated and secured
- [ ] Fail2ban enabled for brute-force protection
- [ ] HTTPS certificate installed and auto-renewal working
- [ ] Environment files have mode 600 (readable only by owner)
- [ ] PM2 startup enabled (survives reboot)
- [ ] Services verified with health checks
- [ ] Database connectivity tested
- [ ] Redis connectivity tested
- [ ] Backup of environment variables in secure vault
- [ ] No `.env` files in Git repository
- [ ] Monitoring/alerting configured (optional but recommended)

## Next Steps

1. ✅ VPS is now fully configured and hardened
2. Configure Vercel environment variables (see `VERCEL_ENV_SETUP.md`)
3. Set the same `SANDBOX_SERVICE_TOKEN` and sandbox URLs in Vercel
4. Deploy dashboard to Vercel
5. Run end-to-end smoke tests
6. Monitor production deployment

## Reference Commands

```bash
# Full status check
pm2 status && curl https://sandbox.ai-swift.biz.id/health && curl https://sandbox.ai-swift.biz.id/worker/health

# Full redeploy (after pulling updates)
cd /root/swift-runtime && bash scripts/vps-production-deploy.sh

# View all logs
pm2 logs

# Restart all services
pm2 restart all

# Stop all services
pm2 stop all

# Check certificate
certbot certificates && curl -I https://sandbox.ai-swift.biz.id

# System resource status
free -h && df -h && ps aux --sort=-%mem | head -5
```

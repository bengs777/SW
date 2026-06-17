# VPS Environment Variables Setup Guide

## Configuration for VPS Sandbox Runtime and Generation Worker

This guide covers setting up environment variables on your VPS at **8.215.40.119** for the Swift sandbox runtime and generation worker services.

### File Structure

Two separate environment files are required on the VPS:

```
/home/swift/
├── .env              # Shared configuration (generation worker + sandbox runtime)
└── .env.sandbox      # Sandbox-specific configuration
```

Both files must have restrictive permissions:
```bash
chmod 600 /home/swift/.env
chmod 600 /home/swift/.env.sandbox
```

### File 1: `/home/swift/.env` (Main Configuration)

This file is shared by both the generation worker and sandbox runtime services.

#### Database & Queue
```
NODE_ENV=production
DATABASE_URL=postgresql://user:password@host.neon.tech/dbname?sslmode=require&pooler_mode=transaction
REDIS_URL=redis://user:password@host:6379
```

#### NextAuth (matching Vercel)
```
NEXTAUTH_SECRET=<same as Vercel>
NEXTAUTH_URL=https://www.ai-swift.biz.id
```

#### OAuth
```
GOOGLE_CLIENT_ID=xxxxx.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=GOCSPX-xxxxxxxxxxxxx
```

#### Supabase (matching Vercel)
```
NEXT_PUBLIC_SUPABASE_URL=https://xxxx.supabase.co
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_DEFAULT_KEY=eyJ.....
SUPABASE_SERVICE_ROLE_KEY=eyJ.....
SUPABASE_STORAGE_BUCKET=swift-artifacts
```

#### OpenRouter AI
```
OPENROUTER_API_KEY=sk-or-v1-xxxxxxxxxxxxx
OPENROUTER_MODEL=google/gemma-4-31b-it:free
SWIFT_AI_PROVIDER_NAME=openrouter
```

#### Sandbox Service Configuration
```
SANDBOX_SERVICE_URL=https://sandbox.ai-swift.biz.id
SANDBOX_SERVICE_TOKEN=<same 64-char hex as Vercel>
SANDBOX_PUBLIC_BASE_URL=https://sandbox.ai-swift.biz.id
```

#### Generation Worker Configuration
```
SWIFT_GENERATION_EXECUTION_MODE=queue
SWIFT_DISABLE_SERVERLESS_GENERATION_FALLBACK=true
SWIFT_WORKER_HEALTH_URL=https://sandbox.ai-swift.biz.id/worker/health
```

#### Sandbox Runtime Tuning
```
SWIFT_SANDBOX_ROOT=/data/swift-sandbox
SWIFT_SANDBOX_MAX_PROJECTS=12
SWIFT_SANDBOX_MAX_FILES=240
SWIFT_SANDBOX_MAX_TOTAL_BYTES=6291456
SWIFT_SANDBOX_PROJECT_IDLE_TTL_MS=1800000
SWIFT_SANDBOX_PROCESS_MAX_UPTIME_MS=1200000
```

**Explanation of sandbox limits:**
- `SWIFT_SANDBOX_ROOT`: Directory for sandboxed project files (must exist, owned by `swift` user)
- `SWIFT_SANDBOX_MAX_PROJECTS`: Max concurrent projects in sandbox (12 = ~60 concurrent users @ 5 projects/user)
- `SWIFT_SANDBOX_MAX_FILES`: Max files per project (240 = typical Next.js app size)
- `SWIFT_SANDBOX_MAX_TOTAL_BYTES`: Max disk space per user (6MB = safe limit for web projects)
- `SWIFT_SANDBOX_PROJECT_IDLE_TTL_MS`: 30 minutes - kill project if idle
- `SWIFT_SANDBOX_PROCESS_MAX_UPTIME_MS`: 20 minutes - hard kill process to prevent resource leaks

#### Optional: Observability
```
SENTRY_DSN=https://xxxxx@sentry.io/xxxxx
LOG_LEVEL=info
```

### File 2: `/home/swift/.env.sandbox` (Sandbox-Only Configuration)

This file is read by the sandbox runtime service specifically.

```
PORT=8080
HOST=0.0.0.0
SANDBOX_PUBLIC_BASE_URL=https://sandbox.ai-swift.biz.id
SANDBOX_SERVICE_TOKEN=<same as .env>
NODE_ENV=production
```

Additionally, copy these from main `.env`:
```
NEXT_PUBLIC_SUPABASE_URL=https://xxxx.supabase.co
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_DEFAULT_KEY=eyJ.....
SUPABASE_SERVICE_ROLE_KEY=eyJ.....
```

### Setup Instructions

#### Step 1: Connect to VPS
```bash
ssh swift@8.215.40.119
# Or with key:
ssh -i /path/to/key.pem swift@8.215.40.119
```

#### Step 2: Create Sandbox Directory
```bash
sudo mkdir -p /data/swift-sandbox
sudo chown swift:swift /data/swift-sandbox
chmod 700 /data/swift-sandbox
```

#### Step 3: Create `.env` File
```bash
nano /home/swift/.env
```

Paste the complete `.env` content from above. Then:
```bash
chmod 600 /home/swift/.env
```

#### Step 4: Create `.env.sandbox` File
```bash
nano /home/swift/.env.sandbox
```

Paste the complete `.env.sandbox` content. Then:
```bash
chmod 600 /home/swift/.env.sandbox
```

#### Step 5: Verify Files
```bash
ls -la /home/swift/.env*
# Output should show: -rw------- (mode 600)

cat /home/swift/.env | grep SANDBOX_SERVICE_TOKEN
# Verify token is set (not blank)
```

#### Step 6: Test Environment
```bash
# SSH into VPS
ssh swift@8.215.40.119

# Load env and test connection
set -a; source /home/swift/.env; set +a
node -e "console.log('DATABASE_URL:', process.env.DATABASE_URL ? 'set' : 'missing')"
node -e "console.log('REDIS_URL:', process.env.REDIS_URL ? 'set' : 'missing')"
```

### Deployment with Environment

When using PM2 to start services, the environment files are automatically loaded:

```bash
# Generation worker
pm2 start ecosystem.config.js --only=swift-generation-worker

# Sandbox runtime
pm2 start ecosystem.config.js --only=swift-sandbox

# View loaded environment
pm2 describe swift-generation-worker | grep -A 20 "env:"
```

Verify services loaded environment:
```bash
# Check environment in running process
pm2 logs swift-generation-worker | head -20
# Should show messages with DATABASE_URL loaded

pm2 logs swift-sandbox | head -20
# Should show server listening on 8080
```

### Health Checks

Once services are running, verify environment is working:

```bash
# From VPS local network
curl http://127.0.0.1:8080/health
# Expected: {"status":"ok","timestamp":"..."}

curl http://127.0.0.1:4000/health
# Expected: {"status":"ok","workerCount":...}

# From production (requires DNS & HTTPS)
curl https://sandbox.ai-swift.biz.id/health
curl https://sandbox.ai-swift.biz.id/worker/health
```

### Troubleshooting

#### "REDIS_URL is required"
- Check `/home/swift/.env` has `REDIS_URL` set (not blank)
- Verify Redis server is running: `redis-cli ping`
- Test connection: `redis-cli -u "$REDIS_URL" ping`

#### "database connection failed"
- Verify `DATABASE_URL` is set and not placeholder
- Test from VPS: `psql "$DATABASE_URL" -c "SELECT 1"`
- Check if Neon allows connections from VPS IP

#### "SANDBOX_SERVICE_TOKEN is missing"
- Check `.env.sandbox` file has the token
- Verify it matches the token in Vercel environment variables
- Regenerate if needed: `openssl rand -hex 32`

#### "Services won't start"
```bash
# Check file permissions
ls -la /home/swift/.env /home/swift/.env.sandbox
# Should show: -rw------- (600)

# Check syntax
bash -n /home/swift/.env  # No errors = valid

# Check service logs
pm2 logs swift-generation-worker --err
pm2 logs swift-sandbox --err
```

#### "Port 8080 already in use"
```bash
# Find process using port 8080
lsof -i :8080
# Kill it if needed, or change SANDBOX_PORT in .env
```

### Security Practices

1. **Restrictive permissions**: Both files must be mode `600` (read/write owner only)
2. **No version control**: Never commit `.env` files to Git
3. **Separate accounts**: Services run as `swift` user (non-root)
4. **Secret rotation**: If any secret is exposed:
   ```bash
   # Update file
   nano /home/swift/.env
   # Restart services
   pm2 restart swift-generation-worker swift-sandbox
   ```
5. **Backup secrets securely**: Keep backup in password manager, never in Git

### Complete Example Files

#### `/home/swift/.env` (complete example)
```bash
NODE_ENV=production
DATABASE_URL=postgresql://user123:abcd1234@my-project.neon.tech/dbname?sslmode=require&pooler_mode=transaction
REDIS_URL=redis://default:mypassword@redis.example.com:6379
NEXTAUTH_SECRET=abcdefghijklmnopqrstuvwxyz123456
NEXTAUTH_URL=https://www.ai-swift.biz.id
GOOGLE_CLIENT_ID=123456789.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=GOCSPX-abcdefghijklmnopqrst
NEXT_PUBLIC_SUPABASE_URL=https://myproject.supabase.co
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_DEFAULT_KEY=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...
SUPABASE_SERVICE_ROLE_KEY=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...
SUPABASE_STORAGE_BUCKET=swift-artifacts
OPENROUTER_API_KEY=sk-or-v1-abcdefghijklmnopqrstuvwxyz
OPENROUTER_MODEL=google/gemma-4-31b-it:free
SWIFT_AI_PROVIDER_NAME=openrouter
SANDBOX_SERVICE_URL=https://sandbox.ai-swift.biz.id
SANDBOX_SERVICE_TOKEN=a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6q7r8s9t0u1v2w3x4y5z6a7b8c9d0e1f2
SANDBOX_PUBLIC_BASE_URL=https://sandbox.ai-swift.biz.id
SWIFT_GENERATION_EXECUTION_MODE=queue
SWIFT_DISABLE_SERVERLESS_GENERATION_FALLBACK=true
SWIFT_WORKER_HEALTH_URL=https://sandbox.ai-swift.biz.id/worker/health
SWIFT_SANDBOX_ROOT=/data/swift-sandbox
SWIFT_SANDBOX_MAX_PROJECTS=12
SWIFT_SANDBOX_MAX_FILES=240
SWIFT_SANDBOX_MAX_TOTAL_BYTES=6291456
SWIFT_SANDBOX_PROJECT_IDLE_TTL_MS=1800000
SWIFT_SANDBOX_PROCESS_MAX_UPTIME_MS=1200000
```

#### `/home/swift/.env.sandbox` (complete example)
```bash
PORT=8080
HOST=0.0.0.0
SANDBOX_PUBLIC_BASE_URL=https://sandbox.ai-swift.biz.id
SANDBOX_SERVICE_TOKEN=a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6q7r8s9t0u1v2w3x4y5z6a7b8c9d0e1f2
NODE_ENV=production
NEXT_PUBLIC_SUPABASE_URL=https://myproject.supabase.co
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_DEFAULT_KEY=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...
SUPABASE_SERVICE_ROLE_KEY=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...
```

### Verification Checklist

After setting up environment variables:

- [ ] Both files exist with mode `600`: `ls -la /home/swift/.env*`
- [ ] All required variables set: `grep -c "=" /home/swift/.env` (should be 30+)
- [ ] No placeholder values: `grep -i "example\|replace\|todo" /home/swift/.env`
- [ ] Services can read files: `sudo -u swift cat /home/swift/.env | head -5`
- [ ] Database connection works: `psql "$DATABASE_URL" -c "SELECT 1"`
- [ ] Redis connection works: `redis-cli -u "$REDIS_URL" ping`
- [ ] PM2 services start successfully: `pm2 status`
- [ ] Health endpoints respond: `curl https://sandbox.ai-swift.biz.id/health`

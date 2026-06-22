# Vercel Environment Variables Setup Guide

## Production Environment Variables for Vercel

This guide provides all required and recommended environment variables for deploying Swift (Reddy) to production on Vercel.

### Critical Required Variables (Must be set before deploy)

#### 1. Database Connection (Neon PostgreSQL)
```
DATABASE_URL=postgresql://user:password@host.neon.tech/dbname?sslmode=require&pooler_mode=transaction
DIRECT_DATABASE_URL=postgresql://user:password@host.neon.tech/dbname?sslmode=require
```

**Notes:**
- `DATABASE_URL`: Use the **pooled** connection string for serverless (Vercel Functions)
- `DIRECT_DATABASE_URL`: Use the **direct** (non-pooled) connection string for migrations only
- Both must include `sslmode=require` for secure TLS connections
- Get these from Neon console: https://console.neon.tech/

#### 2. NextAuth Configuration
```
NEXTAUTH_SECRET=<generate with: openssl rand -base64 32>
NEXTAUTH_URL=https://www.ai-swift.biz.id
```

**Notes:**
- Generate a strong random secret: `openssl rand -base64 32`
- Minimum 32 characters for production security
- URL must match your production domain exactly

#### 3. Google OAuth (Sign-in)
```
GOOGLE_CLIENT_ID=xxxxx.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=GOCSPX-xxxxxxxxxxxxx
```

**Notes:**
- Register at: https://console.cloud.google.com/
- Create OAuth 2.0 credential (Web application)
- Authorized Redirect URIs: `https://www.ai-swift.biz.id/api/auth/callback/google`
- Minimum 24 characters for client secret

#### 4. Supabase (File Storage & Auth)
```
NEXT_PUBLIC_SUPABASE_URL=https://xxxx.supabase.co
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_DEFAULT_KEY=eyJ.....
SUPABASE_SERVICE_ROLE_KEY=eyJ.....
SUPABASE_STORAGE_BUCKET=swift-artifacts
```

**Notes:**
- Create project at: https://supabase.com/
- Settings → API → Project URL & Keys
- Must differ: Service Role Key ≠ Anon Key (different permissions)
- Create storage bucket named `swift-artifacts`

#### 5. OpenRouter AI API
```
OPENROUTER_API_KEY=sk-or-v1-xxxxxxxxxxxxx
OPENROUTER_MODEL=google/gemma-4-31b-it:free
SWIFT_AI_PROVIDER_NAME=openrouter
```

**Notes:**
- Sign up at: https://openrouter.ai/
- Get API key from: https://openrouter.ai/keys
- Model must be available in your tier
- Minimum 20 characters for API key

#### 6. Redis (BullMQ Job Queue)
```
REDIS_URL=redis://user:password@host:6379
```

**Notes:**
- Must be **native Redis** protocol (`redis://` or `rediss://`)
- Cannot use REST HTTPS URLs (Upstash REST requires native client)
- For Upstash: Use Redis protocol endpoint, not REST
- Common options:
  - **Upstash Redis**: Use the Redis URL from Upstash console
  - **Self-hosted**: Your VPS Redis instance
  - **Managed**: AWS ElastiCache, Heroku Redis, etc.

#### 7. Sandbox Runtime Service
```
SANDBOX_SERVICE_URL=https://sandbox.ai-swift.biz.id
SANDBOX_SERVICE_TOKEN=<generate with: openssl rand -hex 32>
SWIFT_WORKER_HEALTH_URL=https://sandbox.ai-swift.biz.id/worker/health
```

**Notes:**
- `SANDBOX_SERVICE_URL`: Your VPS sandbox domain (must have HTTPS)
- `SANDBOX_SERVICE_TOKEN`: 64-character random hex token for API authentication
- `SWIFT_WORKER_HEALTH_URL`: For monitoring generation worker health
- Generate token: `openssl rand -hex 32`

### Optional Production Variables

#### Payment & Billing (Pakasir - Indonesian payments)
```
PAKASIR_SLUG=your-merchant-slug
PAKASIR_API_KEY=your-api-key
```

#### Crypto Payments (BNB/Base chains)
```
NEXT_PUBLIC_CRYPTO_PAYMENT_ADDRESS=0x.....
CRYPTO_PAYMENT_PRIVATE_KEY=0x.....
NEXT_PUBLIC_BNB_CHAIN_ID=56
NEXT_PUBLIC_BASE_CHAIN_ID=8453
```

#### AI Configuration (Tuning)
```
AI_TIMEOUT_MS=500000
AI_MAX_RETRIES=2
AI_MAX_OUTPUT_TOKENS=3000
AI_MAX_CONCURRENT_GENERATIONS=4
AI_QUEUE_TIMEOUT_MS=900000
PROVIDER_STATUS_CACHE_TTL_MS=86400000
```

#### Observability & Debugging
```
SENTRY_ORG=your-sentry-org
SENTRY_PROJECT=swift
SENTRY_AUTH_TOKEN=sntrys_xxxxx
DEV_OWNER_EMAIL=your-email@example.com
```

### Setup Instructions

#### Step 1: Gather All Secrets
1. **Neon**: Copy pooled & direct connection strings
2. **NextAuth**: Generate secret with `openssl rand -base64 32`
3. **Google OAuth**: Create credential, copy ID & secret
4. **Supabase**: Create project, copy API keys
5. **OpenRouter**: Sign up, copy API key
6. **Redis**: Set up instance, copy connection URL
7. **Sandbox Token**: Generate with `openssl rand -hex 32`

#### Step 2: Add to Vercel
1. Go to Vercel Project Settings: https://vercel.com/dashboard/settings
2. Select your project (Swift)
3. Go to **Settings** → **Environment Variables**
4. For each variable:
   - Name: Copy from guide
   - Value: Paste secret
   - Select environments: Production ✓, Preview ✓, Development ✓
   - Click **Save**

#### Step 3: Verify Configuration
After adding all variables, run:
```bash
npm run audit:production-env
```

Expected output:
```
✓ All production environment variables configured
✓ No validation errors
Ready for deployment
```

#### Step 4: Redeploy
1. Go to Vercel Dashboard
2. Find your Swift project
3. Click **Deployments** tab
4. Find latest deployment → Click menu → **Redeploy**
5. Or push to main branch to trigger auto-deploy

### Rotating Secrets

If any secret is exposed (e.g., visible in chat history):

1. **Immediately rotate** in the source system:
   - Google Cloud: Create new OAuth credential
   - Supabase: Regenerate keys
   - OpenRouter: Regenerate API key
   - Redis: Change password or use new instance
   - NextAuth: Generate new secret with `openssl rand -base64 32`

2. **Update Vercel** environment variables with new values

3. **Redeploy** production

4. **Delete old secrets** from source systems

### Troubleshooting

#### "DATABASE_URL not configured"
- Verify both `DATABASE_URL` and `DIRECT_DATABASE_URL` are set
- Check Neon connection strings include `sslmode=require`
- Test with: `npx prisma db push`

#### "Redis connection failed"
- Ensure URL is native protocol (`redis://` not HTTPS)
- If Upstash: Use Redis URL endpoint, not REST URL
- Test with: `npm run worker:health`

#### "OAuth callback failed"
- Verify `NEXTAUTH_URL` matches your production domain
- Check Google OAuth redirect URI includes callback path:
  `https://www.ai-swift.biz.id/api/auth/callback/google`

#### "Sandbox not responding"
- Check `SANDBOX_SERVICE_URL` has valid HTTPS certificate
- Verify VPS is running and accessible
- Check `SANDBOX_SERVICE_TOKEN` matches on VPS `.env`

#### Build fails with environment errors
- Run `npm run audit:production` locally with same variables
- Check for placeholder values like `<replace_with_xxx>`
- Ensure no trailing/leading spaces in values

### Security Best Practices

1. **Never commit `.env` files** - they're in `.gitignore` for a reason
2. **Rotate secrets regularly** - especially after team changes
3. **Use Vercel secrets for sensitive data** - not hardcoded
4. **Enable audit logs** - Vercel tracks all env var access
5. **Restrict access** - Only production maintainers should have Vercel access
6. **Monitor for exposure** - GitHub will scan if secrets accidentally pushed

### Production Checklist

- [ ] All 7 critical variables set (Database, NextAuth, OAuth, Supabase, OpenRouter, Redis, Sandbox)
- [ ] All secrets are strong (32+ characters, not placeholder text)
- [ ] Database URLs use `sslmode=require` for security
- [ ] Redis URL is native protocol, not REST
- [ ] Google OAuth callback URI registered
- [ ] Supabase storage bucket created (`swift-artifacts`)
- [ ] VPS sandbox domain has valid HTTPS certificate
- [ ] `npm run audit:production-env` passes
- [ ] Production deployment successful
- [ ] Health checks passing: `npm run postdeploy:health:prod`

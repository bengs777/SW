# Environment Variables Gathering Guide
## Swift AI Production Deployment

Complete guide to gather all 18 required environment variables for production deployment.

---

## CRITICAL VARIABLES (Must have - system won't start without these)

### 1. DATABASE_URL (Neon PostgreSQL - Connection Pooling)
**What it is**: PostgreSQL connection string with connection pooling
**Where to get it**: 
- Go to https://console.neon.tech
- Select your Swift AI project
- Click "Connection string" in the dashboard
- Copy the **pooled connection string** (ends with `?sslmode=require`)
- Make sure it includes the user, password, host, and database

**Format**: `postgresql://user:password@host.neon.tech:5432/dbname?sslmode=require`
**Example**: `postgresql://swift_user:abc123xyz@ep-cool-moon-12345.eu-west-1.neon.tech:5432/swift_ai?sslmode=require`

**Action**: Copy and save to text file temporarily

---

### 2. DIRECT_DATABASE_URL (Neon PostgreSQL - Direct Connection)
**What it is**: PostgreSQL connection string WITHOUT connection pooling (for migrations)
**Where to get it**:
- Same as DATABASE_URL but select "direct connection"
- Copy the **direct connection string** (NOT pooled)

**Format**: `postgresql://user:password@host.neon.tech:5432/dbname?sslmode=require`
**Example**: `postgresql://swift_user:abc123xyz@ep-cool-moon-12345.us-east-1.neon.tech:5432/swift_ai?sslmode=require`

**Note**: Will look similar to DATABASE_URL but uses different endpoint

**Action**: Copy and save to text file temporarily

---

### 3. NEXTAUTH_SECRET (Authentication - Generate New)
**What it is**: Secret key for NextAuth.js session encryption
**Where to get it**:
- Generate using OpenSSL command
- Run in terminal: `openssl rand -base64 32`
- This creates a cryptographic random string

**Format**: Random 44-character base64 string
**Example**: `AbCdEfGhIjKlMnOpQrStUvWxYz/1234567890==`

**Action**: Generate now with command above and save

---

### 4. NEXTAUTH_URL (Authentication - Your Domain)
**What it is**: Your application's public URL for OAuth callbacks
**Where to get it**:
- Your production domain: `https://www.ai-swift.biz.id`
- Must match your actual deployment domain exactly
- Must start with `https://`

**Format**: `https://yourdomain.com`
**Example**: `https://www.ai-swift.biz.id`

**Action**: Confirm your domain and format with https://

---

### 5. NEXT_PUBLIC_APP_URL (Client-side App URL)
**What it is**: Public app URL accessible from browsers (can be same as NEXTAUTH_URL)
**Where to get it**: Same as NEXTAUTH_URL
**Format**: `https://yourdomain.com`
**Example**: `https://www.ai-swift.biz.id`

**Action**: Use same value as NEXTAUTH_URL

---

### 6. GOOGLE_CLIENT_ID (OAuth - Google)
**What it is**: Google OAuth application client ID
**Where to get it**:
1. Go to https://console.cloud.google.com
2. Create new project or select existing: "Swift AI"
3. Enable Google+ API
4. Go to Credentials > Create OAuth 2.0 Client ID
5. Application type: Web application
6. Authorized redirect URIs: `https://www.ai-swift.biz.id/api/auth/callback/google`
7. Copy the "Client ID"

**Format**: Long alphanumeric string ending in `.apps.googleusercontent.com`
**Example**: `123456789-abcdefghijklmnopqrstuvwxyz.apps.googleusercontent.com`

**Action**: Create OAuth app in Google Cloud Console and copy Client ID

---

### 7. GOOGLE_CLIENT_SECRET (OAuth - Google)
**What it is**: Google OAuth application client secret (keep this secret!)
**Where to get it**: Same Google Cloud Console as GOOGLE_CLIENT_ID
- In the OAuth 2.0 Client ID details, copy the "Client secret"

**Format**: Long random alphanumeric string
**Example**: `GOCSPX-1234567890abcdefghijklmnop`

**Action**: Copy Client Secret from Google Cloud Console

---

### 8. OPENROUTER_API_KEY (AI Provider)
**What it is**: API key for OpenRouter (primary AI provider)
**Where to get it**:
1. Go to https://openrouter.ai
2. Create account if needed
3. Go to Dashboard > API Keys
4. Create new API key or copy existing
5. Copy the full key

**Format**: Long alphanumeric string
**Example**: `sk-or-v1-1234567890abcdefghijklmnopqrstuvwxyz`

**Action**: Get API key from OpenRouter dashboard

---

### 9. REDIS_URL (Queue System)
**What it is**: Redis connection string for job queue (BullMQ)
**Where to get it**:
1. Go to your Redis provider (e.g., upstash.com, redis.com)
2. Copy the connection URL
3. Should start with `redis://` or `rediss://`

**Format**: `rediss://username:password@host:port`
**Example**: `rediss://default:mytoken12345@us1-happy-foal-12345.upstash.io:6380`

**Action**: Get Redis URL from your provider

---

### 10. SANDBOX_SERVICE_URL (Sandbox Runtime)
**What it is**: URL of the sandbox runtime service
**Where to get it**:
- Your deployed sandbox service URL
- Should be accessible at: `https://sandbox.ai-swift.biz.id` or similar
- Ask your DevOps team or check Railway dashboard

**Format**: `https://sandbox.yourdomain.com`
**Example**: `https://sandbox.ai-swift.biz.id`

**Action**: Confirm sandbox deployment domain

---

### 11. SANDBOX_SERVICE_TOKEN (Sandbox Authentication)
**What it is**: Authentication token for sandbox service
**Where to get it**:
1. Go to Railway dashboard
2. Find the sandbox-runtime service
3. In settings, look for "SANDBOX_SERVICE_TOKEN"
4. Or generate a new one: `openssl rand -base64 32`

**Format**: Random 44-character base64 string
**Example**: `XyZ123AbCdEfGhIjKlMnOpQrStUvWxYz==`

**Action**: Check Railway for existing token or generate new one

---

## SUPABASE VARIABLES (Storage & Optional Auth)

### 12. NEXT_PUBLIC_SUPABASE_URL (Supabase Project)
**What it is**: Supabase project URL
**Where to get it**:
1. Go to https://supabase.com
2. Select your Swift AI project
3. Go to Settings > API
4. Copy "Project URL"

**Format**: `https://projectid.supabase.co`
**Example**: `https://abcdefg123456.supabase.co`

**Action**: Copy from Supabase dashboard

---

### 13. NEXT_PUBLIC_SUPABASE_PUBLISHABLE_DEFAULT_KEY (Supabase Public Key)
**What it is**: Supabase public/publishable API key
**Where to get it**: Same Settings > API in Supabase
- Copy "anon public" key (the longer one starting with `eyJ...`)

**Format**: JWT token (very long string)
**Example**: `eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFz...`

**Action**: Copy anon public key from Supabase API settings

---

### 14. SUPABASE_SERVICE_ROLE_KEY (Supabase Backend Key)
**What it is**: Supabase service role key (for server-side operations)
**Where to get it**: Same Settings > API in Supabase
- Copy "service_role" key (longer key, keep this secret)

**Format**: JWT token (very long string)
**Example**: `eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFz...`

**Action**: Copy service_role key from Supabase API settings

---

### 15. SUPABASE_STORAGE_BUCKET (Storage Bucket Name)
**What it is**: Name of storage bucket for generated artifacts
**Where to get it**:
1. In Supabase, go to Storage
2. Look at your bucket names
3. Common name: `generated-artifacts` or `projects`

**Format**: Lowercase alphanumeric with hyphens
**Example**: `generated-artifacts`

**Action**: Check your Supabase storage bucket name

---

## VERCEL & TEAM VARIABLES

### 16. VERDI_TEAM (Vercel Team ID - Optional but recommended)
**What it is**: Your Vercel team ID
**Where to get it**:
1. Go to https://vercel.com/dashboard
2. Settings > Team Settings (if you have a team)
3. Copy the team slug or ID
4. Or get from URL: vercel.com/teams/{TEAM_ID}

**Format**: Team slug (alphanumeric with hyphens)
**Example**: `bengs777s-projects` or `my-team`

**Action**: Get team ID from Vercel dashboard (optional)

---

## FEATURE FLAGS & SETTINGS

### 17. SWIFT_DISABLE_SERVERLESS_GENERATION_FALLBACK (Feature Flag)
**What it is**: Disable fallback when serverless generation fails
**Where to get it**: Generated value (controls behavior)
**Format**: `true` or `false`
**Recommended**: `true` (for production reliability)

**Action**: Set to `true` to require worker-based generation

---

### 18. SWIFT_AI_PROVIDER_NAME (Optional - AI Provider Selection)
**What it is**: Primary AI provider name
**Where to get it**: Generated value
**Format**: `openrouter` or provider name
**Recommended**: `openrouter`

**Action**: Set to match your chosen provider

---

## ENVIRONMENT VARIABLES CHECKLIST

Print this out or use as reference while gathering values:

```
[ ] 1. DATABASE_URL
    Source: Neon Console
    Format: postgresql://user:pass@host/db?sslmode=require
    Value: _________________________________

[ ] 2. DIRECT_DATABASE_URL
    Source: Neon Console (direct connection)
    Format: postgresql://user:pass@host/db?sslmode=require
    Value: _________________________________

[ ] 3. NEXTAUTH_SECRET
    Source: Generate with: openssl rand -base64 32
    Format: Base64 string (44 chars)
    Value: _________________________________

[ ] 4. NEXTAUTH_URL
    Source: Your domain
    Format: https://domain.com
    Value: https://www.ai-swift.biz.id

[ ] 5. NEXT_PUBLIC_APP_URL
    Source: Your domain (usually same as NEXTAUTH_URL)
    Format: https://domain.com
    Value: https://www.ai-swift.biz.id

[ ] 6. GOOGLE_CLIENT_ID
    Source: Google Cloud Console
    Format: xxx.apps.googleusercontent.com
    Value: _________________________________

[ ] 7. GOOGLE_CLIENT_SECRET
    Source: Google Cloud Console
    Format: Alphanumeric string
    Value: _________________________________

[ ] 8. OPENROUTER_API_KEY
    Source: OpenRouter Dashboard
    Format: sk-or-v1-xxxxx
    Value: _________________________________

[ ] 9. REDIS_URL
    Source: Redis provider (Upstash, etc.)
    Format: rediss://user:pass@host:port
    Value: _________________________________

[ ] 10. SANDBOX_SERVICE_URL
     Source: Your sandbox domain
     Format: https://sandbox.domain.com
     Value: https://sandbox.ai-swift.biz.id

[ ] 11. SANDBOX_SERVICE_TOKEN
     Source: Railway or generate with openssl rand -base64 32
     Format: Base64 string
     Value: _________________________________

[ ] 12. NEXT_PUBLIC_SUPABASE_URL
     Source: Supabase Console
     Format: https://projectid.supabase.co
     Value: _________________________________

[ ] 13. NEXT_PUBLIC_SUPABASE_PUBLISHABLE_DEFAULT_KEY
     Source: Supabase API Settings
     Format: JWT token
     Value: _________________________________

[ ] 14. SUPABASE_SERVICE_ROLE_KEY
     Source: Supabase API Settings
     Format: JWT token
     Value: _________________________________

[ ] 15. SUPABASE_STORAGE_BUCKET
     Source: Supabase Storage
     Format: bucket-name
     Value: _________________________________

[ ] 16. VERDI_TEAM (Optional)
     Source: Vercel Dashboard
     Format: team-slug
     Value: _________________________________

[ ] 17. SWIFT_DISABLE_SERVERLESS_GENERATION_FALLBACK
     Source: Set for production
     Format: true/false
     Value: true

[ ] 18. SWIFT_AI_PROVIDER_NAME (Optional)
     Source: Set to your provider
     Format: openrouter
     Value: openrouter
```

---

## NEXT STEPS

1. **Gather all values** using the checklist above
2. **Save securely** - Keep these in a secure location (password manager, encrypted file)
3. **Verify formats** - Make sure URLs start with https://, tokens are complete
4. **Proceed to Phase 1** - Follow the PHASE_1_DETAILED_CHECKLIST.md guide to enter these in Vercel

---

## SECURITY NOTES

- Never commit these values to Git
- Never share these in chat or emails (paste only as needed)
- Keep API keys and secrets secure
- Rotate tokens periodically (especially SANDBOX_SERVICE_TOKEN)
- Use Vercel's environment variable encryption

---

Generated: June 3, 2026
Status: Ready for gathering

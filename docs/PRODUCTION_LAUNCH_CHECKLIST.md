# Swift Production Launch Checklist

Swift is production-launchable only when the dashboard app and sandbox runtime are deployed as separate services.
Production generation also requires a dedicated queue worker; do not rely on Vercel serverless fallback for live generation.

## Required Services

- Vercel: Swift dashboard and API routes.
- Neon PostgreSQL: primary application database through Prisma.
- Supabase Storage: uploaded assets and prompt attachments.
- Redis: BullMQ generation queue and rate-limit scaling.
- VPS: dedicated generation worker service.
- VPS: external sandbox runtime service.

## Required Production Env

Dashboard app:

- `DATABASE_URL`
- `DIRECT_DATABASE_URL` for migrations and administrative scripts
- `NEXTAUTH_SECRET`
- `NEXTAUTH_URL`
- `NEXT_PUBLIC_APP_URL`
- `GOOGLE_CLIENT_ID`
- `GOOGLE_CLIENT_SECRET`
- `OPENROUTER_API_KEY`
- Optional OpenRouter gateway metadata: `OPENROUTER_BASE_URL`, `OPENROUTER_SITE_URL`, `OPENROUTER_APP_NAME`
- `OPENROUTER_MODEL`
- `SWIFT_AI_MODEL_CHAIN`
- `SWIFT_AI_PROVIDER_NAME=openrouter`
- `SWIFT_WORKER_HEALTH_URL`
- `REDIS_URL`
- `NEXT_PUBLIC_SUPABASE_URL`
- `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_DEFAULT_KEY`
- `SUPABASE_SERVICE_ROLE_KEY`
- `SUPABASE_STORAGE_BUCKET`
- `SANDBOX_SERVICE_URL`
- `SANDBOX_SERVICE_TOKEN`
- `VERDI_TEAM`

Generation worker:

- `DATABASE_URL`
- `DIRECT_DATABASE_URL`
- `REDIS_URL`
- `OPENROUTER_API_KEY`
- `OPENROUTER_BASE_URL`
- `OPENROUTER_MODEL`
- `SWIFT_AI_MODEL_CHAIN`
- `SWIFT_AI_PROVIDER_NAME=openrouter`
- `SWIFT_GENERATION_EXECUTION_MODE=queue`
- `SWIFT_DISABLE_SERVERLESS_GENERATION_FALLBACK=true`
- `SANDBOX_SERVICE_URL`
- `SANDBOX_SERVICE_TOKEN`

Sandbox runtime:

- `SANDBOX_SERVICE_TOKEN`
- `SANDBOX_PUBLIC_BASE_URL`
- `SWIFT_SANDBOX_DATABASE_URL` if generated previews need database-backed routes
- `SWIFT_SANDBOX_DIRECT_DATABASE_URL` if sandbox migration scripts are enabled
- `NEXT_PUBLIC_SUPABASE_URL`
- `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_DEFAULT_KEY`
- `SUPABASE_SERVICE_ROLE_KEY`
- `SUPABASE_STORAGE_BUCKET`

## Sandbox Safety Defaults

The sandbox runtime enforces:

- Bearer auth in production.
- Max active projects via `SWIFT_SANDBOX_MAX_PROJECTS`.
- Max files and payload size via `SWIFT_SANDBOX_MAX_FILES`, `SWIFT_SANDBOX_MAX_TOTAL_BYTES`, and `SWIFT_SANDBOX_MAX_FILE_BYTES`.
- Idle cleanup via `SWIFT_SANDBOX_PROJECT_IDLE_TTL_MS`.
- Dev server max uptime via `SWIFT_SANDBOX_PROCESS_MAX_UPTIME_MS`.
- `npm install --ignore-scripts` to reduce install-time execution risk.
- Package allowlist for generated dependencies; set `SWIFT_SANDBOX_ALLOWED_PACKAGES` to extend it.

Do not set `SWIFT_SANDBOX_ALLOW_UNSAFE_PACKAGE_INSTALL=1` in public production.

## Launch Gate

Before marketing Swift publicly:

1. Run `npm run build`.
2. Run `npm run db:push:prod`.
3. Deploy the dedicated generation worker to the locked-down VPS.
4. Deploy `services/sandbox-runtime` to the locked-down VPS.
5. Set `SWIFT_WORKER_HEALTH_URL`, `SANDBOX_SERVICE_URL`, and `SANDBOX_SERVICE_TOKEN` on Vercel.
6. Keep `OPENROUTER_MODEL` and `SWIFT_AI_MODEL_CHAIN` identical in Vercel Production and the generation worker.
7. Verify a prompt can generate, build, preview, upload an attachment, and deploy.
8. Verify production readiness reports no required missing env vars.

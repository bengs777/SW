# Swift Production Launch Checklist

Swift is production-launchable only when the dashboard app and sandbox runtime are deployed as separate services.

## Required Services

- Vercel: Swift dashboard and API routes.
- Turso: primary application database through Prisma/libSQL.
- Supabase Storage: uploaded assets and prompt attachments.
- Redis: BullMQ generation queue and rate-limit scaling.
- Railway or VPS: external sandbox runtime service.

## Required Production Env

Dashboard app:

- `DATABASE_URL`
- `TURSO_DATABASE_URL`
- `TURSO_AUTH_TOKEN`
- `NEXTAUTH_SECRET`
- `NEXTAUTH_URL`
- `NEXT_PUBLIC_APP_URL`
- `GOOGLE_CLIENT_ID`
- `GOOGLE_CLIENT_SECRET`
- `OPENROUTER_API_KEY`
- `REDIS_URL`
- `NEXT_PUBLIC_SUPABASE_URL`
- `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_DEFAULT_KEY`
- `SUPABASE_SERVICE_ROLE_KEY`
- `SUPABASE_STORAGE_BUCKET`
- `SANDBOX_SERVICE_URL`
- `SANDBOX_SERVICE_TOKEN`

Sandbox runtime:

- `SANDBOX_SERVICE_TOKEN`
- `SANDBOX_PUBLIC_BASE_URL`
- `TURSO_DATABASE_URL`
- `TURSO_AUTH_TOKEN`
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
3. Deploy `services/sandbox-runtime` to Railway or a locked-down VPS.
4. Set `SANDBOX_SERVICE_URL` and `SANDBOX_SERVICE_TOKEN` on Vercel.
5. Verify a prompt can generate, build, preview, upload an attachment, and deploy.
6. Verify production readiness reports no required missing env vars.

import { env } from "@/lib/env"
import { aiRateLimitConfig } from "@/lib/security/rate-limit"

type ReadinessCheck = {
  key: string
  label: string
  ok: boolean
  severity: "required" | "recommended"
  detail?: string
}

function hasValue(value: string | number | null | undefined) {
  return typeof value === "number" ? Number.isFinite(value) : Boolean(value && value.trim())
}

function isProductionUrl(value: string | null | undefined) {
  if (!value) return false
  return /^https:\/\//i.test(value) && !/localhost|127\.0\.0\.1|0\.0\.0\.0/i.test(value)
}

function isPostgresUrl(value: string | null | undefined) {
  return Boolean(value && /^postgres(?:ql)?:\/\//i.test(value))
}

function isNeonPooledUrl(value: string | null | undefined) {
  if (!isPostgresUrl(value)) return false

  try {
    return /pooler\./i.test(new URL(String(value)).hostname)
  } catch {
    return false
  }
}

function check(key: string, label: string, value: unknown, severity: ReadinessCheck["severity"], detail?: string): ReadinessCheck {
  return {
    key,
    label,
    ok: typeof value === "boolean" ? value : hasValue(value as string | number | null | undefined),
    severity,
    detail,
  }
}

export function getProductionReadiness() {
  const checks: ReadinessCheck[] = [
    check("DATABASE_URL", "Neon pooled PostgreSQL app URL", isPostgresUrl(env.databaseUrl), "required", env.databaseUrl ? "Must be a PostgreSQL URL." : undefined),
    check("DATABASE_URL_POOLING", "Neon pooled serverless connection", isNeonPooledUrl(env.databaseUrl), "recommended", env.databaseUrl ? "Use the Neon pooler host for app runtime traffic." : undefined),
    check("DIRECT_DATABASE_URL", "Neon direct migration URL", isPostgresUrl(env.directDatabaseUrl), "recommended", "Use for migrations and administrative scripts, not request traffic."),
    check("NEXTAUTH_SECRET", "NextAuth secret", env.nextAuthSecret, "required"),
    check("NEXTAUTH_URL", "NextAuth canonical URL", isProductionUrl(env.nextAuthUrl), "required", env.nextAuthUrl ? "Must be an https production URL, not localhost." : undefined),
    check("NEXT_PUBLIC_APP_URL", "Public app URL", isProductionUrl(env.appUrl), "required", env.appUrl ? "Must be an https production URL, not localhost." : undefined),
    check("GOOGLE_CLIENT_ID", "Google OAuth client ID", env.googleClientId, "required"),
    check("GOOGLE_CLIENT_SECRET", "Google OAuth client secret", env.googleClientSecret, "required"),
    check("OPENROUTER_API_KEY", "Swift AI OpenRouter gateway key", env.openRouterApiKey, "required"),
    check("OPENROUTER_BASE_URL", "OpenRouter compatible API base URL", env.openRouterBaseUrl, "recommended"),
    check("OPENROUTER_SITE_URL", "OpenRouter attribution site URL", env.openRouterSiteUrl, "recommended"),
    check("OPENROUTER_APP_NAME", "OpenRouter attribution app name", env.openRouterAppName, "recommended"),
    check(
      "REDIS_CONFIG",
      "Redis queue protection config",
      env.hasRedisConfig,
      "required",
      env.redisUrl
        ? "TCP Redis configured"
        : env.upstashRedisRestUrl && env.upstashRedisRestToken
          ? "Upstash REST configured"
          : "REDIS_URL or Upstash REST URL/token required"
    ),
    check("SANDBOX_SERVICE_URL", "External sandbox runtime service URL", env.sandboxServiceUrl, "required"),
    check("SANDBOX_SERVICE_TOKEN", "External sandbox runtime bearer token", env.sandboxServiceToken, "required"),
    check("NEXT_PUBLIC_SUPABASE_URL", "Supabase project URL", env.supabaseUrl, "required"),
    check("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_DEFAULT_KEY", "Supabase publishable key", env.supabasePublicAnonKey, "required"),
    check("SUPABASE_STORAGE_BUCKET", "Supabase asset storage bucket", env.supabaseStorageBucket, "required"),
    check("SUPABASE_SERVICE_ROLE_KEY", "Supabase asset storage service key", env.supabaseServiceRoleKey, "required"),
    check("PAKASIR_SLUG", "Pakasir merchant slug", env.pakasirSlug, "recommended"),
    check("PAKASIR_API_KEY", "Pakasir API key", env.pakasirApiKey, "recommended"),
    check("VERCEL_TEAM_ID", "Vercel team scope for generated deployments", env.vercelTeamId, "required"),
    check("verpro_akses_token", "Generated app deploy token", env.vercelAccessToken, "recommended"),
    check("DEV_OWNER_EMAIL", "Developer owner email", env.devOwnerEmail, "required"),
    check("AI_RATE_LIMIT_PER_MINUTE", "AI prompt rate limit per minute", aiRateLimitConfig.perMinute > 0, "required", `${aiRateLimitConfig.perMinute} prompts/minute`),
    check("AI_RATE_LIMIT_PER_DAY", "AI prompt rate limit per day", aiRateLimitConfig.perDay > 0, "required", `${aiRateLimitConfig.perDay} prompts/day`),
  ]

  const requiredMissing = checks.filter((item) => item.severity === "required" && !item.ok)
  const recommendedMissing = checks.filter((item) => item.severity === "recommended" && !item.ok)

  return {
    ok: requiredMissing.length === 0,
    environment: env.nodeEnv,
    appUrl: env.appUrl,
    checks,
    requiredMissing: requiredMissing.map((item) => item.key),
    recommendedMissing: recommendedMissing.map((item) => item.key),
    rateLimit: aiRateLimitConfig,
  }
}

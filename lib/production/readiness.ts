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
    check("DATABASE_URL", "Prisma datasource URL", env.databaseUrl, "required"),
    check("TURSO_DATABASE_URL", "Turso/libSQL database URL", env.tursoDatabaseUrl, "required"),
    check("NEXTAUTH_SECRET", "NextAuth secret", env.nextAuthSecret, "required"),
    check("NEXTAUTH_URL", "NextAuth canonical URL", env.nextAuthUrl, "required"),
    check("NEXT_PUBLIC_APP_URL", "Public app URL", env.appUrl, "required"),
    check("GOOGLE_CLIENT_ID", "Google OAuth client ID", env.googleClientId, "required"),
    check("GOOGLE_CLIENT_SECRET", "Google OAuth client secret", env.googleClientSecret, "required"),
    check("OPENROUTER_API_KEY", "Swift AI OpenRouter key", env.openRouterApiKey, "required", "Swift AI is locked to OpenRouter."),
    check("OPENROUTER_BASE_URL", "Swift AI OpenRouter base URL", env.openRouterApiUrl === "https://openrouter.ai/api/v1", "required"),
    check("PAKASIR_SLUG", "Pakasir merchant slug", env.pakasirSlug, "recommended"),
    check("PAKASIR_API_KEY", "Pakasir API key", env.pakasirApiKey, "recommended"),
    check("SUPABASE_STORAGE_BUCKET", "Asset storage bucket", env.supabaseStorageBucket, "recommended"),
    check("SUPABASE_SERVICE_ROLE_KEY", "Asset storage service key", env.supabaseServiceRoleKey, "recommended"),
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

import { env } from "@/lib/env"
import { aiRateLimitConfig } from "@/lib/security/rate-limit"
import { hasAnyPrimaryProviderKey } from "@/lib/ai/model-tiers"

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
  const hasPrimaryProvider = hasAnyPrimaryProviderKey()
  const checks: ReadinessCheck[] = [
    check("DATABASE_URL", "Prisma/libSQL database URL", env.databaseUrl, "required"),
    check("TURSO_DATABASE_URL", "Turso/libSQL runtime database URL", env.tursoDatabaseUrl, "required"),
    check("TURSO_AUTH_TOKEN", "Turso auth token", env.tursoAuthToken, "required"),
    check("NEXTAUTH_SECRET", "NextAuth secret", env.nextAuthSecret, "required"),
    check("NEXTAUTH_URL", "NextAuth canonical URL", env.nextAuthUrl, "required"),
    check("NEXT_PUBLIC_APP_URL", "Public app URL", env.appUrl, "required"),
    check("GOOGLE_CLIENT_ID", "Google OAuth client ID", env.googleClientId, "required"),
    check("GOOGLE_CLIENT_SECRET", "Google OAuth client secret", env.googleClientSecret, "required"),
    check("AI_PROVIDER_KEY", "Swift AI provider key", hasPrimaryProvider, "required", "Set OPENROUTER_API_KEY, GEMINI_API_KEY, DEEPSEEK_API_KEY, or OPENAI_API_KEY."),
    check("OPENROUTER_API_KEY", "Swift AI OpenRouter key", env.openRouterApiKey, "recommended"),
    check("GEMINI_API_KEY", "Swift AI Gemini key", env.geminiApiKey, "recommended"),
    check("DEEPSEEK_API_KEY", "Swift AI DeepSeek key", env.deepSeekApiKey, "recommended"),
    check("OPENAI_API_KEY", "Swift AI OpenAI key", env.openAiApiKey, "recommended"),
    check("AGENTROUTER_API_KEY", "Legacy AgentRouter key", env.agentRouterApiKey, "recommended"),
    check("REDIS_URL", "Redis/BullMQ queue URL", env.redisUrl, "required"),
    check("SANDBOX_SERVICE_URL", "External sandbox runtime service URL", env.sandboxServiceUrl, "required"),
    check("SANDBOX_SERVICE_TOKEN", "External sandbox runtime bearer token", env.sandboxServiceToken, "required"),
    check("NEXT_PUBLIC_SUPABASE_URL", "Supabase project URL", env.supabaseUrl, "required"),
    check("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_DEFAULT_KEY", "Supabase publishable key", env.supabasePublicAnonKey, "required"),
    check("SUPABASE_STORAGE_BUCKET", "Supabase asset storage bucket", env.supabaseStorageBucket, "required"),
    check("SUPABASE_SERVICE_ROLE_KEY", "Supabase asset storage service key", env.supabaseServiceRoleKey, "required"),
    check("PAKASIR_SLUG", "Pakasir merchant slug", env.pakasirSlug, "recommended"),
    check("PAKASIR_API_KEY", "Pakasir API key", env.pakasirApiKey, "recommended"),
    check("VERCEL_ACCESS_TOKEN", "Generated app deploy token", env.vercelAccessToken, "recommended"),
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

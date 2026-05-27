import { env } from "@/lib/env"
import { aiRateLimitConfig } from "@/lib/security/rate-limit"
import { getAuthRuntimeDiagnostic } from "@/lib/auth/runtime"
import { getDatabaseRuntimeDiagnostic, prisma } from "@/lib/db/client"
import { getDatabaseSchemaHealth, type DatabaseSchemaHealth } from "@/lib/db/schema-health"
import { getGenerationQueueHealth } from "@/lib/queue/generation-queue"

type ReadinessCheck = {
  key: string
  label: string
  ok: boolean
  severity: "critical" | "required" | "optional"
  category: "environment" | "database" | "auth" | "migration" | "preview" | "rollback" | "service"
  detail?: string
  degradedMode?: boolean
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

function check(
  key: string,
  label: string,
  value: unknown,
  severity: ReadinessCheck["severity"],
  category: ReadinessCheck["category"],
  detail?: string,
  degradedMode = false
): ReadinessCheck {
  return {
    key,
    label,
    ok: typeof value === "boolean" ? value : hasValue(value as string | number | null | undefined),
    severity,
    category,
    detail,
    degradedMode,
  }
}

export function getProductionReadiness() {
  const auth = getAuthRuntimeDiagnostic()
  const database = getDatabaseRuntimeDiagnostic()
  const isPreviewDeployment = process.env.VERCEL_ENV === "preview"
  const isVercel = process.env.VERCEL === "1"
  const generationExecutionMode = String(process.env.SWIFT_GENERATION_EXECUTION_MODE || "queue").toLowerCase()
  const serverlessFallbackEnabled = process.env.SWIFT_ALLOW_SERVERLESS_GENERATION_FALLBACK === "true"
  const generationExecutionReady = !generationExecutionMode || generationExecutionMode === "queue"
  const checks: ReadinessCheck[] = [
    check("DATABASE_URL", "PostgreSQL runtime URL", database.ok, "critical", "database", database.message),
    check("DATABASE_URL_POOLING", "Neon pooled serverless connection", isNeonPooledUrl(env.databaseUrl), "optional", "database", env.databaseUrl ? "Use the Neon pooler host for app runtime traffic." : undefined, true),
    check("DIRECT_DATABASE_URL", "Direct database URL for rollback-safe migrations", isPostgresUrl(env.directDatabaseUrl), "required", "rollback", "Use for migration status, rollback checks, and administrative scripts."),
    check("NEXTAUTH_SECRET", "Auth session signing secret", env.nextAuthSecret && env.nextAuthSecret.length >= 32, "critical", "auth", "Must be present and non-placeholder."),
    check("NEXTAUTH_URL", "Canonical auth URL", isProductionUrl(env.nextAuthUrl) || isPreviewDeployment, "required", "auth", env.nextAuthUrl ? "Must be an https production URL, not localhost." : undefined),
    check("NEXT_PUBLIC_APP_URL", "Public app URL", isProductionUrl(env.appUrl) || isPreviewDeployment, "required", "preview", env.appUrl ? "Must be an https URL for production and preview deployments." : undefined),
    check("GOOGLE_CLIENT_ID", "Google OAuth client ID", env.googleClientId, "critical", "auth"),
    check("GOOGLE_CLIENT_SECRET", "Google OAuth client secret", env.googleClientSecret, "critical", "auth"),
    check("AUTH_PROVIDER_HEALTH", "Auth provider runtime health", auth.ok, "critical", "auth", auth.issues.map((issue) => issue.message).join(" ") || "Auth provider configured."),
    check("OPENROUTER_API_KEY", "Swift AI OpenRouter gateway key", env.openRouterApiKey, "required", "service"),
    check("OPENROUTER_BASE_URL", "OpenRouter compatible API base URL", env.openRouterBaseUrl, "optional", "service", undefined, true),
    check("OPENROUTER_SITE_URL", "OpenRouter attribution site URL", env.openRouterSiteUrl, "optional", "service", undefined, true),
    check("OPENROUTER_APP_NAME", "OpenRouter attribution app name", env.openRouterAppName, "optional", "service", undefined, true),
    check(
      "REDIS_BULLMQ_CONFIG",
      "Native Redis config for BullMQ jobs and workers",
      env.hasNativeRedisConfig,
      "required",
      "service",
      env.redisUrl
        ? env.hasNativeRedisConfig
          ? "Native Redis configured"
          : "REDIS_URL must use redis:// or rediss://"
        : env.upstashRedisRestUrl && env.upstashRedisRestToken
          ? "Upstash REST is configured, but BullMQ workers still require native REDIS_URL"
          : "Set REDIS_URL to a native redis:// or rediss:// connection string"
    ),
    check(
      "UPSTASH_REDIS_REST",
      "Optional Upstash REST config for request rate-limit fallback",
      env.hasRedisRestConfig,
      "optional",
      "service",
      env.hasRedisRestConfig ? "REST Redis configured" : "Optional when native REDIS_URL is configured",
      true
    ),
    check("SANDBOX_SERVICE_URL", "External sandbox runtime service URL", env.sandboxServiceUrl, "required", "preview"),
    check("SANDBOX_SERVICE_TOKEN", "External sandbox runtime bearer token", env.sandboxServiceToken, "required", "preview"),
    check("PREVIEW_DEPLOYMENT_URL", "Preview deployment URL is HTTPS", !isPreviewDeployment || isProductionUrl(env.appUrl) || Boolean(process.env.VERCEL_URL), "required", "preview", "Preview deployments need an HTTPS Vercel URL or explicit app URL."),
    check("NEXT_PUBLIC_SUPABASE_URL", "Supabase project URL", env.supabaseUrl, "required", "service"),
    check("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_DEFAULT_KEY", "Supabase publishable key", env.supabasePublicAnonKey, "required", "service"),
    check("SUPABASE_STORAGE_BUCKET", "Supabase asset storage bucket", env.supabaseStorageBucket, "required", "service"),
    check("SUPABASE_SERVICE_ROLE_KEY", "Supabase asset storage service key", env.supabaseServiceRoleKey, "required", "service"),
    check("PAKASIR_SLUG", "Pakasir merchant slug", env.pakasirSlug, "optional", "service", undefined, true),
    check("PAKASIR_API_KEY", "Pakasir API key", env.pakasirApiKey, "optional", "service", undefined, true),
    check("VERDI_TEAM", "Vercel team scope for generated deployments", env.verdiTeamId, "required", "preview"),
    check("VERPRO_ACCES_TOKEN", "Generated app deploy token", env.verproAccessToken, "optional", "preview", undefined, true),
    check(
      "SWIFT_GENERATION_EXECUTION_MODE",
      "Generation execution mode",
      generationExecutionReady,
      isVercel ? "critical" : "required",
      "rollback",
      generationExecutionMode === "queue"
        ? "Queue mode configured."
        : generationExecutionMode === "serverless" && isVercel && serverlessFallbackEnabled
          ? "Serverless fallback is explicit, but production requires queue mode with a dedicated worker."
          : "Use queue mode in production with a dedicated worker."
    ),
    check("DEV_OWNER_EMAIL", "Developer owner email", env.devOwnerEmail, "required", "auth"),
    check("AI_RATE_LIMIT_PER_MINUTE", "AI prompt rate limit per minute", aiRateLimitConfig.perMinute > 0, "required", "service", `${aiRateLimitConfig.perMinute} prompts/minute`),
    check("AI_GENERATION_RATE_LIMIT_PER_HOUR", "AI generation rate limit per hour", aiRateLimitConfig.generationPerHour > 0, "required", "service", `${aiRateLimitConfig.generationPerHour} generations/hour`),
    check("AI_RATE_LIMIT_PER_DAY", "AI prompt rate limit per day", aiRateLimitConfig.perDay > 0, "required", "service", `${aiRateLimitConfig.perDay} prompts/day`),
    check("UPLOAD_RATE_LIMIT_PER_DAY", "Upload rate limit per day", aiRateLimitConfig.uploadPerDay > 0, "required", "service", `${aiRateLimitConfig.uploadPerDay} files/day`),
  ]

  const blocking = checks.filter((item) => (item.severity === "critical" || item.severity === "required") && !item.ok)
  const degraded = checks.filter((item) => item.severity === "optional" && !item.ok)

  return {
    ok: blocking.length === 0,
    status: blocking.length > 0 ? "blocked" : degraded.length > 0 ? "degraded" : "ready",
    environment: env.nodeEnv,
    vercelEnv: process.env.VERCEL_ENV || null,
    appUrl: env.appUrl,
    checks,
    missingEnvVars: checks.filter((item) => !item.ok && /URL|SECRET|KEY|TOKEN|TEAM|EMAIL|CONFIG/.test(item.key)).map((item) => item.key),
    invalidSecrets: checks.filter((item) => !item.ok && /SECRET|KEY|TOKEN/.test(item.key)).map((item) => item.key),
    blockingFailures: blocking.map((item) => item.key),
    degradedServices: degraded.map((item) => item.key),
    requiredMissing: blocking.map((item) => item.key),
    recommendedMissing: degraded.map((item) => item.key),
    rateLimit: aiRateLimitConfig,
    authProvider: auth,
    database,
  }
}

export async function getDeploymentRuntimeReadiness() {
  const base = getProductionReadiness()
  let dbConnectivity: { ok: boolean; latencyMs?: number; error?: string } = { ok: false }
  let migration: DatabaseSchemaHealth | { compatible: false; error: string } | null = null
  let queueSaturation: Awaited<ReturnType<typeof getGenerationQueueHealth>>["saturation"] | null = null

  if (base.database.ok) {
    try {
      const startedAt = Date.now()
      await prisma.$queryRaw`SELECT 1`
      dbConnectivity = { ok: true, latencyMs: Date.now() - startedAt }
    } catch (error) {
      dbConnectivity = { ok: false, error: error instanceof Error ? error.message : String(error) }
    }

    try {
      migration = await getDatabaseSchemaHealth()
    } catch (error) {
      migration = { compatible: false, error: error instanceof Error ? error.message : String(error) }
    }
  }

  try {
    const queueHealth = await getGenerationQueueHealth()
    queueSaturation = queueHealth.saturation
  } catch {
    queueSaturation = null
  }

  const migrationReady = migration ? migration.compatible : false
  const saturationDegraded = Boolean(queueSaturation?.heavy)
  const runtimeBlocking = [
    ...base.blockingFailures,
    ...(dbConnectivity.ok ? [] : ["DB_CONNECTIVITY"]),
    ...(migrationReady ? [] : ["MIGRATION_READINESS"]),
  ]

  return {
    ...base,
    ok: runtimeBlocking.length === 0,
    status: runtimeBlocking.length > 0 ? "blocked" : saturationDegraded ? "degraded" : base.status,
    blockingFailures: runtimeBlocking,
    degradedServices: Array.from(new Set([
      ...base.degradedServices,
      ...(saturationDegraded ? ["QUEUE_SATURATION"] : []),
    ])),
    dbConnectivity,
    migration,
    queueSaturation,
    migrationMismatch: migration && !migration.compatible ? migration : null,
  }
}

export function assertDeploymentEnvironmentReady() {
  if (env.nodeEnv !== "production") return getProductionReadiness()

  const readiness = getProductionReadiness()
  if (!readiness.ok) {
    throw new Error(`Deployment environment is not ready: ${readiness.blockingFailures.join(", ")}`)
  }
  return readiness
}

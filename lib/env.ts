import { z } from "zod"

const getEnv = (...keys: string[]) => {
  for (const key of keys) {
    const value = process.env[key]
    if (value && value.trim()) {
      return value
    }
  }

  return ""
}

const getEnvList = (...keys: string[]) => {
  const value = getEnv(...keys)

  if (!value) {
    return []
  }

  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
}

const getEnvNumber = (fallback: number, ...keys: string[]) => {
  const value = getEnv(...keys)
  if (!value) {
    return fallback
  }

  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

const getEnvBoolean = (fallback: boolean, ...keys: string[]) => {
  const value = getEnv(...keys)
  if (!value) {
    return fallback
  }

  return value === "true" || value === "1"
}

const normalizeTokenLimit = (value: number) => {
  const rounded = Math.round(value)
  if (!Number.isFinite(rounded)) {
    return 3000
  }

  return Math.min(32_000, Math.max(256, rounded))
}

const isPlaceholderEnvValue = (value: string) => {
  const trimmed = value.trim()
  if (!trimmed) return false

  return (
    /^<[^>]+>$/.test(trimmed) ||
    /<[^>]+>/.test(trimmed) ||
    /^(replace|replace_with|your|your_|your-|example|placeholder|todo)[\w-]*/i.test(trimmed)
  )
}

const normalizeUrl = (url: string) => {
  const trimmed = url.trim()
  if (!trimmed || isPlaceholderEnvValue(trimmed)) {
    return ""
  }

  return trimmed.replace(/\/+$/, "")
}

const normalizeWorkerHealthUrl = (url: string) => {
  const normalized = normalizeUrl(url)
  if (!normalized) return ""

  try {
    const hostname = new URL(normalized).hostname
    const legacyHostPattern = new RegExp("(^|\\.)up\\." + "rail" + "way" + "\\.app$", "i")
    if (legacyHostPattern.test(hostname)) {
      return ""
    }
  } catch {
    return normalized
  }

  return normalized
}

const normalizeAppUrl = (value: string) => {
  const normalized = normalizeUrl(value)
  if (!normalized) {
    return ""
  }

  if (/^https?:\/\//i.test(normalized)) {
    return normalized
  }

  return `https://${normalized}`
}

const DEV_OWNER_EMAIL = getEnv("DEV_OWNER_EMAIL")
const tursoDatabaseUrl = getEnv("TURSO_DATABASE_URL")
const tursoAuthToken = getEnv("TURSO_AUTH_TOKEN")
const supabaseUrl = getEnv("NEXT_PUBLIC_SUPABASE_URL")
const supabasePublicAnonKey = getEnv(
  "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_DEFAULT_KEY",
  "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY",
  "NEXT_PUBLIC_SUPABASE_ANON_KEY"
)
const supabaseServiceRoleKey = getEnv("SUPABASE_SERVICE_ROLE_KEY")
const supabaseStorageBucket = getEnv("SUPABASE_STORAGE_BUCKET")
const sandboxServiceUrl = normalizeUrl(getEnv("SANDBOX_API_URL", "SANDBOX_SERVICE_URL"))
const sandboxServiceToken = getEnv("SANDBOX_API_KEY", "SANDBOX_SERVICE_TOKEN")
const workerHealthUrl = normalizeWorkerHealthUrl(getEnv("SWIFT_WORKER_HEALTH_URL", "WORKER_HEALTH_URL"))
const redisUrl = getEnv("REDIS_URL", "UPSTASH_REDIS_URL")
const upstashRedisRestUrl = normalizeUrl(getEnv("UPSTASH_REDIS_REST_URL"))
const upstashRedisRestToken = getEnv("UPSTASH_REDIS_REST_TOKEN")
const verdiTeamId = getEnv("VERDI_TEAM")
const verproDeployToken = getEnv("VERPRO_ACCES_TOKEN", "VERCEL_TOKEN")
const aiGatewayDefaultBaseUrl = "https://openrouter.ai/api/v1"
const openRouterModel = getEnv("OPENROUTER_MODEL", "OPENROUTER_DEFAULT_MODEL") || "deepseek/deepseek-chat-v3.1:free"
const openRouterFallbackModels = getEnvList("OPENROUTER_FALLBACK_MODELS", "SWIFT_AI_MODEL_CHAIN")
const swiftAiProviderName = getEnv("SWIFT_AI_PROVIDER_NAME") || "openrouter"
const nativeRedisUrlPattern = /^rediss?:\/\//i
const hasNativeRedisConfig = nativeRedisUrlPattern.test(redisUrl)
const hasRedisRestConfig = Boolean(upstashRedisRestUrl && upstashRedisRestToken)
const hasRedisConfig = Boolean(hasNativeRedisConfig || hasRedisRestConfig)
const isServerRuntime = typeof window === "undefined"

const urlSchema = z.string().url()
const finiteNumberSchema = z.coerce.number().finite()

export type EnvValidationSeverity = "error" | "warning"

export type EnvValidationIssue = {
  key: string
  severity: EnvValidationSeverity
  message: string
}

export type EnvValidationReport = {
  ok: boolean
  environment: string
  isProduction: boolean
  missing: string[]
  issues: EnvValidationIssue[]
}

export const env = {
  nodeEnv: process.env.NODE_ENV || "development",

  // Database (Turso)
  tursoDatabaseUrl,
  tursoAuthToken,

  // Auth (Clerk)
  clerkPublishableKey: getEnv("NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY"),
  clerkSecretKey: getEnv("CLERK_SECRET_KEY"),
  clerkWebhookSecret: getEnv("CLERK_WEBHOOK_SECRET"),

  // GitHub
  githubClientId: getEnv("GITHUB_CLIENT_ID"),
  githubClientSecret: getEnv("GITHUB_CLIENT_SECRET"),
  githubToken: getEnv("GITHUB_TOKEN"),

  // Vercel
  vercelToken: getEnv("VERCEL_TOKEN"),
  vercelTeamId: getEnv("VERCEL_TEAM_ID"),

  // Domain
  rootDomain: getEnv("ROOT_DOMAIN") || "ai-swift.biz.id",
  defaultSubdomainSuffix: getEnv("DEFAULT_SUBDOMAIN_SUFFIX") || ".ai-swift.biz.id",

  // AI
  aiTimeoutMs: getEnvNumber(500_000, "AI_TIMEOUT_MS"),
  aiMaxRetries: Math.max(0, Math.round(getEnvNumber(2, "AI_MAX_RETRIES"))),
  aiMaxOutputTokens: normalizeTokenLimit(getEnvNumber(3000, "AI_MAX_OUTPUT_TOKENS", "OPENROUTER_MAX_TOKENS")),
  providerStatusCacheTtlMs: Math.max(
    60_000,
    Math.round(getEnvNumber(86_400_000, "PROVIDER_STATUS_CACHE_TTL_MS"))
  ),
  aiMaxConcurrentGenerations: Math.max(1, Math.round(getEnvNumber(4, "AI_MAX_CONCURRENT_GENERATIONS"))),
  aiQueueTimeoutMs: Math.max(900_000, Math.round(getEnvNumber(900_000, "AI_QUEUE_TIMEOUT_MS"))),
  openRouterApiKey: getEnv("OPENROUTER_API_KEY"),
  openRouterModel,
  openRouterFallbackModels,
  swiftAiProviderName,
  openRouterBaseUrl: normalizeUrl(getEnv("OPENROUTER_BASE_URL") || aiGatewayDefaultBaseUrl),
  openRouterSiteUrl: normalizeAppUrl(getEnv("OPENROUTER_SITE_URL", "NEXT_PUBLIC_APP_URL", "APP_URL") || "https://ai-swift.biz.id"),
  openRouterAppName: getEnv("OPENROUTER_APP_NAME") || "Swift AI",

  // Supabase
  supabaseServiceRoleKey,
  supabasePublicAnonKey,
  supabaseAnonKey: getEnv("SUPABASE_ANON_KEY"),
  supabaseUrl,
  supabaseStorageBucket,
  supabaseBucket: supabaseStorageBucket,

  // Redis
  redisUrl,
  upstashRedisRestUrl,
  upstashRedisRestToken,
  hasNativeRedisConfig,
  hasRedisRestConfig,
  hasRedisConfig,

  // Sandbox
  sandboxServiceUrl,
  sandboxServiceToken,
  sandboxPublicBaseUrl: normalizeUrl(getEnv("SANDBOX_PUBLIC_BASE_URL")),
  sandboxRoot: getEnv("SWIFT_SANDBOX_ROOT"),
  sandboxBasePort: getEnvNumber(4300, "SWIFT_SANDBOX_BASE_PORT"),
  sandboxDatabaseUrl: getEnv("SWIFT_SANDBOX_DATABASE_URL"),

  // App
  appName: getEnv("NEXT_PUBLIC_APP_NAME") || "Swift AI",
  appUrl: normalizeAppUrl(getEnv("NEXT_PUBLIC_APP_URL", "APP_URL") || "http://localhost:3000"),
  devOwnerEmail: DEV_OWNER_EMAIL,

  // Payment
  pakasirSlug: getEnv("PAKASIR_SLUG", "PAKASIR_MERCHANT_ID"),
  pakasirApiKey: getEnv("PAKASIR_API_KEY"),
  pakasirWebhookSecret: getEnv("PAKASIR_WEBHOOK_SECRET"),

  // Email
  resendApiKey: getEnv("RESEND_API_KEY"),
  emailFrom: getEnv("EMAIL_FROM") || "noreply@ai-swift.biz.id",

  // Deployment
  defaultFramework: getEnv("DEFAULT_FRAMEWORK") || "nextjs",
  defaultNodeVersion: getEnv("DEFAULT_NODE_VERSION") || "22",
  defaultPackageManager: getEnv("DEFAULT_PACKAGE_MANAGER") || "npm",
  buildTimeout: getEnvNumber(600, "BUILD_TIMEOUT"),

  // Cache
  cacheTtl: getEnvNumber(300, "CACHE_TTL"),

  // Rate Limit
  rateLimitPerMinute: getEnvNumber(30, "RATE_LIMIT_PER_MINUTE"),

  // Security
  encryptionKey: getEnv("ENCRYPTION_KEY"),
  cronSecret: getEnv("CRON_SECRET"),

  // Analytics
  enableAnalytics: getEnvBoolean(true, "NEXT_PUBLIC_ENABLE_ANALYTICS"),

  // Feature Flags
  enableAiGenerate: getEnvBoolean(true, "ENABLE_AI_GENERATE"),
  enableAiEdit: getEnvBoolean(true, "ENABLE_AI_EDIT"),
  enableAiChat: getEnvBoolean(true, "ENABLE_AI_CHAT"),
  enablePreview: getEnvBoolean(true, "ENABLE_PREVIEW"),
  enableDeploy: getEnvBoolean(true, "ENABLE_DEPLOY"),
  enableDownloadZip: getEnvBoolean(true, "ENABLE_DOWNLOAD_ZIP"),
  enableGithubSync: getEnvBoolean(true, "ENABLE_GITHUB_SYNC"),
  enableVersionHistory: getEnvBoolean(true, "ENABLE_VERSION_HISTORY"),
  enableCustomDomain: getEnvBoolean(true, "ENABLE_CUSTOM_DOMAIN"),
  enableTeams: getEnvBoolean(true, "ENABLE_TEAMS"),

  // Preview
  webcontainerEnabled: getEnvBoolean(true, "NEXT_PUBLIC_WEBCONTAINER_ENABLED"),

  // Logging
  logLevel: getEnv("LOG_LEVEL") || "info",

  // Worker
  workerHealthUrl,

  // Verdi/Verpro
  verproAccessToken: verproDeployToken,
  verdiTeamId,

  // Crypto Payment
  cryptoPaymentPrivateKey: getEnv("CRYPTO_PAYMENT_PRIVATE_KEY"),
  cryptoPaymentAddress: getEnv("NEXT_PUBLIC_CRYPTO_PAYMENT_ADDRESS"),
  bnbChainId: getEnvNumber(56, "NEXT_PUBLIC_BNB_CHAIN_ID"),
  bnbRpcUrl: getEnv("NEXT_PUBLIC_BNB_RPC_URL") || "https://bsc-dataseed.binance.org",
  baseChainId: getEnvNumber(8453, "NEXT_PUBLIC_BASE_CHAIN_ID"),
  baseRpcUrl: getEnv("NEXT_PUBLIC_BASE_RPC_URL") || "https://mainnet.base.org",
  cryptoPaymentMinAmount: getEnv("CRYPTO_PAYMENT_MIN_AMOUNT") || "0.00012",
  cryptoPaymentTimeoutMinutes: getEnvNumber(30, "CRYPTO_PAYMENT_TIMEOUT_MINUTES"),
  cryptoPaymentConfirmationsRequired: getEnvNumber(2, "CRYPTO_PAYMENT_CONFIRMATIONS_REQUIRED"),
}

export function getMissingProductionEnvVars() {
  const missing: string[] = []

  if (!env.tursoDatabaseUrl) missing.push("TURSO_DATABASE_URL")
  if (!env.tursoAuthToken) missing.push("TURSO_AUTH_TOKEN")
  if (!env.clerkPublishableKey) missing.push("NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY")
  if (!env.clerkSecretKey) missing.push("CLERK_SECRET_KEY")
  if (!env.supabaseUrl) missing.push("NEXT_PUBLIC_SUPABASE_URL")
  if (!env.supabasePublicAnonKey) {
    missing.push("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY or NEXT_PUBLIC_SUPABASE_ANON_KEY")
  }
  if (!env.supabaseServiceRoleKey) missing.push("SUPABASE_SERVICE_ROLE_KEY")
  if (!env.supabaseStorageBucket) missing.push("SUPABASE_STORAGE_BUCKET")
  if (!env.hasNativeRedisConfig) missing.push("REDIS_URL (native redis:// or rediss:// for BullMQ)")
  if (!env.sandboxServiceUrl) missing.push("SANDBOX_API_URL")
  if (!env.sandboxServiceToken) missing.push("SANDBOX_API_KEY")
  if (!env.vercelToken) missing.push("VERCEL_TOKEN")
  if (!env.vercelTeamId) missing.push("VERCEL_TEAM_ID")

  if (!env.openRouterApiKey) missing.push("OPENROUTER_API_KEY")

  return missing
}

function validateOptionalUrl(
  issues: EnvValidationIssue[],
  key: string,
  value: string,
  isProduction: boolean
) {
  if (!value) return

  const parsed = urlSchema.safeParse(value)
  if (parsed.success) return

  issues.push({
    key,
    severity: isProduction ? "error" : "warning",
    message: `${key} must be a valid absolute URL.`,
  })
}

function validateSecret(
  issues: EnvValidationIssue[],
  key: string,
  value: string,
  options: { minLength: number; isProduction: boolean }
) {
  if (!value) return

  const normalized = value.trim().toLowerCase()
  const placeholderPattern =
    /^(change-me|changeme|development-auth-secret|password|secret|example|placeholder|replace-me|replace_me|todo|your-secret|your_secret|your-key|your_key)$/
  const placeholderPrefixPattern = /^(your|replace|example|placeholder)[_-]/i
  if (
    value.length < options.minLength ||
    placeholderPattern.test(normalized) ||
    placeholderPrefixPattern.test(value)
  ) {
    issues.push({
      key,
      severity: options.isProduction ? "error" : "warning",
      message: `${key} must be a non-placeholder secret with at least ${options.minLength} characters.`,
    })
  }
}

function validateOptionalNumber(
  issues: EnvValidationIssue[],
  key: string,
  options: {
    min?: number
    integer?: boolean
    isProduction: boolean
  }
) {
  const raw = process.env[key]
  if (!raw || !raw.trim()) return

  const parsed = finiteNumberSchema.safeParse(raw)
  if (!parsed.success) {
    issues.push({
      key,
      severity: options.isProduction ? "error" : "warning",
      message: `${key} must be a finite number.`,
    })
    return
  }

  if (typeof options.min === "number" && parsed.data < options.min) {
    issues.push({
      key,
      severity: options.isProduction ? "error" : "warning",
      message: `${key} must be greater than or equal to ${options.min}.`,
    })
  }

  if (options.integer && !Number.isInteger(parsed.data)) {
    issues.push({
      key,
      severity: options.isProduction ? "error" : "warning",
      message: `${key} must be an integer.`,
    })
  }
}

function validateOptionalRedisUrl(
  issues: EnvValidationIssue[],
  key: string,
  value: string,
  isProduction: boolean
) {
  if (!value) return

  if (!nativeRedisUrlPattern.test(value)) {
    issues.push({
      key,
      severity: isProduction ? "error" : "warning",
      message: `${key} must be a native Redis URL using redis:// or rediss://. REST HTTPS URLs cannot be used by BullMQ workers.`,
    })
    return
  }

  const parsed = urlSchema.safeParse(value)
  if (!parsed.success) {
    issues.push({
      key,
      severity: isProduction ? "error" : "warning",
      message: `${key} must be a valid native Redis URL.`,
    })
  }
}

export function validateEnv(options: { nodeEnv?: string } = {}): EnvValidationReport {
  const environment = options.nodeEnv || env.nodeEnv
  const isProduction = environment === "production"
  const missing = isProduction ? getMissingProductionEnvVars() : []
  const issues: EnvValidationIssue[] = missing.map((key) => ({
    key,
    severity: "error",
    message: `${key} is required in production.`,
  }))

  validateSecret(issues, "CLERK_SECRET_KEY", env.clerkSecretKey, { minLength: 20, isProduction })
  validateSecret(issues, "SUPABASE_SERVICE_ROLE_KEY", env.supabaseServiceRoleKey, { minLength: 32, isProduction })
  validateSecret(issues, "OPENROUTER_API_KEY", env.openRouterApiKey, { minLength: 20, isProduction })
  validateSecret(issues, "GITHUB_CLIENT_SECRET", env.githubClientSecret, { minLength: 20, isProduction })
  validateSecret(issues, "VERCEL_TOKEN", env.vercelToken, { minLength: 20, isProduction })

  if (env.supabaseServiceRoleKey && env.supabasePublicAnonKey && env.supabaseServiceRoleKey === env.supabasePublicAnonKey) {
    issues.push({
      key: "SUPABASE_SERVICE_ROLE_KEY",
      severity: isProduction ? "error" : "warning",
      message: "SUPABASE_SERVICE_ROLE_KEY must not equal the public Supabase key.",
    })
  }

  validateOptionalUrl(issues, "NEXT_PUBLIC_APP_URL / APP_URL", env.appUrl, isProduction)
  validateOptionalUrl(issues, "OPENROUTER_BASE_URL", env.openRouterBaseUrl, isProduction)
  validateOptionalUrl(issues, "OPENROUTER_SITE_URL", env.openRouterSiteUrl, isProduction)
  validateOptionalUrl(issues, "NEXT_PUBLIC_SUPABASE_URL", env.supabaseUrl, isProduction)
  validateOptionalUrl(issues, "SANDBOX_API_URL", env.sandboxServiceUrl, isProduction)
  validateOptionalUrl(issues, "SANDBOX_PUBLIC_BASE_URL", env.sandboxPublicBaseUrl, isProduction)
  validateOptionalUrl(issues, "SWIFT_WORKER_HEALTH_URL / WORKER_HEALTH_URL", env.workerHealthUrl, isProduction)
  validateOptionalRedisUrl(issues, "REDIS_URL / UPSTASH_REDIS_URL", env.redisUrl, isProduction)

  if (!process.env.DEV_OWNER_EMAIL?.trim()) {
    issues.push({
      key: "DEV_OWNER_EMAIL",
      severity: isProduction ? "error" : "warning",
      message:
        "DEV_OWNER_EMAIL is not set. The developer/admin role is disabled until it is configured (no built-in fallback email).",
    })
  }

  if (!env.clerkWebhookSecret) {
    issues.push({
      key: "CLERK_WEBHOOK_SECRET",
      severity: "warning",
      message:
        "CLERK_WEBHOOK_SECRET is not set; the Clerk user sync webhook stays disabled and users are provisioned lazily on first sign-in.",
    })
  }

  validateOptionalNumber(issues, "AI_TIMEOUT_MS", { min: 1_000, integer: true, isProduction })
  validateOptionalNumber(issues, "AI_MAX_RETRIES", { min: 0, integer: true, isProduction })
  validateOptionalNumber(issues, "AI_MAX_OUTPUT_TOKENS", { min: 1, integer: true, isProduction })
  validateOptionalNumber(issues, "OPENROUTER_MAX_TOKENS", { min: 1, integer: true, isProduction })
  validateOptionalNumber(issues, "PROVIDER_STATUS_CACHE_TTL_MS", { min: 1_000, integer: true, isProduction })
  validateOptionalNumber(issues, "AI_MAX_CONCURRENT_GENERATIONS", { min: 1, integer: true, isProduction })
  validateOptionalNumber(issues, "AI_QUEUE_TIMEOUT_MS", { min: 1_000, integer: true, isProduction })
  validateOptionalNumber(issues, "SWIFT_EXECUTOR_HARD_TIMEOUT_MS", { min: 30_000, integer: true, isProduction })
  validateOptionalNumber(issues, "SWIFT_EXECUTOR_STUCK_OPERATION_MS", { min: 5_000, integer: true, isProduction })
  validateOptionalNumber(issues, "SWIFT_SANDBOX_BASE_PORT", { min: 1, integer: true, isProduction })
  validateOptionalNumber(issues, "NEXT_PUBLIC_BNB_CHAIN_ID", { min: 1, integer: true, isProduction })
  validateOptionalNumber(issues, "NEXT_PUBLIC_BASE_CHAIN_ID", { min: 1, integer: true, isProduction })
  validateOptionalNumber(issues, "CRYPTO_PAYMENT_TIMEOUT_MINUTES", { min: 1, integer: true, isProduction })
  validateOptionalNumber(issues, "CRYPTO_PAYMENT_CONFIRMATIONS_REQUIRED", { min: 0, integer: true, isProduction })

  return {
    ok: !issues.some((issue) => issue.severity === "error"),
    environment,
    isProduction,
    missing,
    issues,
  }
}

export const getEnvValidationReport = validateEnv

export function assertProductionEnvReady() {
  if (!isServerRuntime || env.nodeEnv !== "production") {
    return
  }

  const report = validateEnv()

  if (!report.ok) {
    throw new Error(
      `Invalid production environment: ${report.issues
        .filter((issue) => issue.severity === "error")
        .map((issue) => issue.message)
        .join(" ")}`
    )
  }
}

export { getEnv, getEnvList, getEnvNumber, getEnvBoolean }

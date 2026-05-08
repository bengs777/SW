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

const normalizeTokenLimit = (value: number) => {
  const rounded = Math.round(value)
  if (!Number.isFinite(rounded)) {
    return 3000
  }

  return Math.min(12_000, Math.max(256, rounded))
}

const normalizeUrl = (url: string) => url.replace(/\/+$/, "")
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

const DEV_OWNER_EMAIL = getEnv("DEV_OWNER_EMAIL") || "ibnualmugni1933@gmail.com"
const databaseUrl = getEnv("DATABASE_URL")
const tursoDatabaseUrl = getEnv("TURSO_DATABASE_URL")
const supabaseUrl = getEnv("NEXT_PUBLIC_SUPABASE_URL")
const supabasePublicAnonKey = getEnv(
  "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_DEFAULT_KEY",
  "NEXT_PUBLIC_SUPABASE_ANON_KEY"
)
const supabaseServiceRoleKey = getEnv("SUPABASE_SERVICE_ROLE_KEY")
const supabaseStorageBucket = getEnv("SUPABASE_STORAGE_BUCKET")

export const env = {
  nodeEnv: process.env.NODE_ENV || "development",
  databaseUrl,
  tursoDatabaseUrl,
  nextAuthSecret: getEnv("NEXTAUTH_SECRET"),
  nextAuthUrl: getEnv("NEXTAUTH_URL"),
  googleClientId: getEnv("GOOGLE_CLIENT_ID"),
  googleClientSecret: getEnv("GOOGLE_CLIENT_SECRET"),
  aiTimeoutMs: getEnvNumber(20_000, "AI_TIMEOUT_MS"),
  aiMaxRetries: Math.max(1, Math.round(getEnvNumber(2, "AI_MAX_RETRIES"))),
  aiMaxOutputTokens: normalizeTokenLimit(getEnvNumber(3000, "AI_MAX_OUTPUT_TOKENS", "OPENROUTER_MAX_TOKENS")),
  providerStatusCacheTtlMs: Math.max(
    60_000,
    Math.round(getEnvNumber(86_400_000, "PROVIDER_STATUS_CACHE_TTL_MS"))
  ),
  v0ApiKey: getEnv("V0_API_KEY"),
  openRouterApiKey: getEnv("OPENROUTER_API_KEY"),
  openRouterApiUrl: "https://openrouter.ai/api/v1",
  devOwnerEmail: DEV_OWNER_EMAIL,
  supabaseServiceRoleKey,
  supabasePublicAnonKey,
  supabaseAnonKey: getEnv("SUPABASE_ANON_KEY"),
  supabaseUrl,
  supabaseStorageBucket,
  supabaseBucket: supabaseStorageBucket,
  appUrl: normalizeAppUrl(getEnv("NEXT_PUBLIC_APP_URL", "APP_URL", "NEXTAUTH_URL", "VERCEL_URL") || "http://localhost:3000"),
  pakasirSlug: getEnv("PAKASIR_SLUG", "PAKASIR_MERCHANT_ID"),
  pakasirApiKey: getEnv("PAKASIR_API_KEY"),
  vercelAccessToken: getEnv("VERCEL_ACCESS_TOKEN"),
  tursoAuthToken: getEnv("TURSO_AUTH_TOKEN"),
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

if (env.nodeEnv === "production") {
  const missing: string[] = []

  if (!env.databaseUrl && !env.tursoDatabaseUrl) missing.push("DATABASE_URL or TURSO_DATABASE_URL")
  if (!env.nextAuthSecret) missing.push("NEXTAUTH_SECRET")
  if (!env.googleClientId) missing.push("GOOGLE_CLIENT_ID")
  if (!env.googleClientSecret) missing.push("GOOGLE_CLIENT_SECRET")
  if (!env.supabaseUrl) missing.push("NEXT_PUBLIC_SUPABASE_URL")
  if (!env.supabasePublicAnonKey) {
    missing.push("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_DEFAULT_KEY or NEXT_PUBLIC_SUPABASE_ANON_KEY")
  }
  if (!env.supabaseServiceRoleKey) missing.push("SUPABASE_SERVICE_ROLE_KEY")
  if (!env.supabaseStorageBucket) missing.push("SUPABASE_STORAGE_BUCKET")

  if (!env.openRouterApiKey) missing.push("OPENROUTER_API_KEY")

  if (missing.length > 0) {
    throw new Error(
      `Missing required environment variables: ${missing.join(", ")}`
    )
  }
}

export { getEnv, getEnvList, getEnvNumber }

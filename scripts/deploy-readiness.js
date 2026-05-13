const { loadEnvConfig } = require("@next/env")
const fs = require("fs")
const path = require("path")

loadEnvConfig(process.cwd(), process.env.NODE_ENV !== "production")

const explicitEnvFile =
  process.env.DEPLOY_ENV_FILE ||
  (process.env.NODE_ENV === "production" && fs.existsSync(path.join(process.cwd(), ".env.production"))
    ? ".env.production"
    : "")

if (explicitEnvFile) {
  loadEnvFile(explicitEnvFile)
}

function loadEnvFile(file) {
  const envPath = path.join(process.cwd(), file)
  if (!fs.existsSync(envPath)) return

  const lines = fs.readFileSync(envPath, "utf8").split(/\r?\n/)
  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith("#")) continue

    const separatorIndex = trimmed.indexOf("=")
    if (separatorIndex === -1) continue

    const key = trimmed.slice(0, separatorIndex).trim()
    const rawValue = trimmed.slice(separatorIndex + 1).trim()
    if (!key) continue

    process.env[key] = rawValue.replace(/^["']|["']$/g, "")
  }
}

function value(...keys) {
  for (const key of keys) {
    const current = process.env[key]
    if (current && current.trim()) {
      return current.trim()
    }
  }
  return ""
}

function normalizeUrl(input) {
  return String(input || "").replace(/\/+$/, "")
}

function isProductionUrl(input) {
  const current = normalizeUrl(input)
  return /^https:\/\//i.test(current) && !/localhost|127\.0\.0\.1|0\.0\.0\.0/i.test(current)
}

function isPostgresUrl(input) {
  return /^postgres(?:ql)?:\/\//i.test(String(input || ""))
}

function isNeonPooledUrl(input) {
  if (!isPostgresUrl(input)) return false
  try {
    return /pooler\./i.test(new URL(input).hostname)
  } catch {
    return false
  }
}

function isNativeRedisUrl(input) {
  return /^rediss?:\/\//i.test(String(input || ""))
}

const nextAuthUrl = value("NEXTAUTH_URL")
const appUrl = value("NEXT_PUBLIC_APP_URL", "APP_URL", "NEXTAUTH_URL", "VERCEL_URL")
const databaseUrl = value("DATABASE_URL")
const directDatabaseUrl = value("DIRECT_DATABASE_URL", "DIRECT_URL", "POSTGRES_URL_NON_POOLING")

const checks = [
  required("DATABASE_URL", "Neon pooled PostgreSQL app URL", isPostgresUrl(databaseUrl), databaseUrl ? "Must be a PostgreSQL URL." : "Set the Neon pooled connection string."),
  recommended("DATABASE_URL_POOLING", "Serverless pooled Neon host", isNeonPooledUrl(databaseUrl), "Use the Neon pooler host for app runtime traffic."),
  recommended("DIRECT_DATABASE_URL", "Direct Neon URL for migrations/admin scripts", isPostgresUrl(directDatabaseUrl), "Set DIRECT_DATABASE_URL, DIRECT_URL, or POSTGRES_URL_NON_POOLING."),
  required("NEXTAUTH_SECRET", "Auth session secret", value("NEXTAUTH_SECRET")),
  required("NEXTAUTH_URL", "Canonical auth URL", isProductionUrl(nextAuthUrl), "Must be an https production URL, not localhost."),
  required("NEXT_PUBLIC_APP_URL", "Public app URL", isProductionUrl(appUrl), "Must be an https production URL, not localhost."),
  required("GOOGLE_CLIENT_ID", "Google OAuth client ID", value("GOOGLE_CLIENT_ID")),
  required("GOOGLE_CLIENT_SECRET", "Google OAuth client secret", value("GOOGLE_CLIENT_SECRET")),
  required("OPENROUTER_API_KEY", "AI provider API key", value("OPENROUTER_API_KEY")),
  required(
    "REDIS_BULLMQ_CONFIG",
    "Native Redis config for BullMQ jobs and workers",
    isNativeRedisUrl(value("REDIS_URL", "UPSTASH_REDIS_URL")),
    isNativeRedisUrl(value("REDIS_URL", "UPSTASH_REDIS_URL"))
      ? "Native Redis configured"
      : value("REDIS_URL", "UPSTASH_REDIS_URL")
        ? "REDIS_URL must use redis:// or rediss://"
      : value("UPSTASH_REDIS_REST_URL") && value("UPSTASH_REDIS_REST_TOKEN")
        ? "Upstash REST is configured, but BullMQ workers still require native REDIS_URL."
        : "Set REDIS_URL to a native redis:// or rediss:// connection string"
  ),
  required("SANDBOX_SERVICE_URL", "External sandbox runtime URL", normalizeUrl(value("SANDBOX_SERVICE_URL"))),
  required("SANDBOX_SERVICE_TOKEN", "External sandbox bearer token", value("SANDBOX_SERVICE_TOKEN")),
  required("NEXT_PUBLIC_SUPABASE_URL", "Supabase project URL", value("NEXT_PUBLIC_SUPABASE_URL")),
  required(
    "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_DEFAULT_KEY",
    "Supabase public key",
    value("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_DEFAULT_KEY", "NEXT_PUBLIC_SUPABASE_ANON_KEY")
  ),
  required("SUPABASE_SERVICE_ROLE_KEY", "Supabase service role key", value("SUPABASE_SERVICE_ROLE_KEY")),
  required("SUPABASE_STORAGE_BUCKET", "Supabase storage bucket", value("SUPABASE_STORAGE_BUCKET")),
  required("VERCEL_TEAM_ID", "Vercel team scope for generated deployments", value("VERCEL_TEAM_ID")),
  recommended("verpro_akses_token", "Generated-app deploy token", value("verpro_akses_token")),
  recommended("PAKASIR_SLUG", "Payment merchant slug", value("PAKASIR_SLUG", "PAKASIR_MERCHANT_ID")),
  recommended("PAKASIR_API_KEY", "Payment API key", value("PAKASIR_API_KEY")),
  recommended("CRYPTO_PAYMENT_PRIVATE_KEY", "Crypto payment private key", value("CRYPTO_PAYMENT_PRIVATE_KEY")),
  recommended("NEXT_PUBLIC_CRYPTO_PAYMENT_ADDRESS", "Crypto payment receiving address", value("NEXT_PUBLIC_CRYPTO_PAYMENT_ADDRESS")),
]

const requiredMissing = checks.filter((check) => check.severity === "required" && !check.ok)
const recommendedMissing = checks.filter((check) => check.severity === "recommended" && !check.ok)

console.log("\nDeploy Readiness")
console.log("----------------")
for (const check of checks) {
  const state = check.ok ? "PASS" : check.severity === "required" ? "FAIL" : "WARN"
  console.log(`${state} ${check.key} - ${check.label}${check.detail ? ` (${check.detail})` : ""}`)
}

console.log("\nSummary")
console.log(`Required: ${checks.filter((check) => check.severity === "required" && check.ok).length}/${checks.filter((check) => check.severity === "required").length} passed`)
console.log(`Recommended missing: ${recommendedMissing.length}`)

if (requiredMissing.length > 0) {
  console.log(`NOT_READY_FOR_DEPLOY: ${requiredMissing.map((check) => check.key).join(", ")}`)
  process.exitCode = 1
} else {
  console.log("READY_FOR_DEPLOY")
}

function required(key, label, current, detail) {
  return check(key, label, current, "required", detail)
}

function recommended(key, label, current, detail) {
  return check(key, label, current, "recommended", detail)
}

function check(key, label, current, severity, detail) {
  return {
    key,
    label,
    ok: Boolean(current),
    severity,
    detail,
  }
}

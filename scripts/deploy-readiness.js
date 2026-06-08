const { loadEnvConfig } = require("@next/env")
const fs = require("fs")
const path = require("path")
const { execSync } = require("child_process")
const IORedis = require("ioredis")

const GENERATION_WORKER_HEARTBEAT_KEY = "swift:generation:worker:heartbeat"
const GENERATION_WORKER_HEARTBEAT_INDEX_KEY = "swift:generation:worker:heartbeats"
const GENERATION_WORKER_HEARTBEAT_MAX_AGE_MS = 90_000

const deployTarget = (process.env.DEPLOY_TARGET || process.env.SWIFT_DEPLOY_TARGET || "production").toLowerCase()
const isProductionDeployTarget = deployTarget === "production" || deployTarget === "prod"

loadEnvConfig(process.cwd(), !isProductionDeployTarget && process.env.NODE_ENV !== "production")

const explicitEnvFile =
  process.env.DEPLOY_ENV_FILE ||
  (isProductionDeployTarget && fs.existsSync(path.join(process.cwd(), ".env.production"))
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
  const current = String(input || "").trim()
  if (!current || isPlaceholderValue(current)) return ""
  return current.replace(/\/+$/, "")
}

function normalizeWorkerHealthUrl(input) {
  const normalized = normalizeUrl(input)
  if (!normalized) return ""

  try {
    const hostname = new URL(normalized).hostname
    const legacyHostPattern = new RegExp("(^|\\.)up\\." + "rail" + "way" + "\\.app$", "i")
    if (legacyHostPattern.test(hostname)) return ""
  } catch {
    return normalized
  }

  return normalized
}

function isPlaceholderValue(input) {
  const current = String(input || "").trim()
  if (!current) return false
  return (
    /^<[^>]+>$/.test(current) ||
    /<[^>]+>/.test(current) ||
    /^(replace|replace_with|your|your_|your-|example|placeholder|todo)[\w-]*/i.test(current)
  )
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

function parseHeartbeatPayload(rawHeartbeat, source) {
  if (!rawHeartbeat) return null
  try {
    const parsed = JSON.parse(rawHeartbeat)
    if (!parsed || typeof parsed !== "object") return null
    return {
      workerId: String(parsed.workerId || "unknown-worker"),
      pid: Number(parsed.pid || 0),
      at: String(parsed.at || ""),
      currentStage: parsed.currentStage || null,
      lastSuccessfulTransition: parsed.lastSuccessfulTransition || null,
      activeJobIds: Array.isArray(parsed.activeJobIds) ? parsed.activeJobIds.map(String) : [],
      idleTimeoutMs: typeof parsed.idleTimeoutMs === "number" ? parsed.idleTimeoutMs : null,
      stalledGenerationDetected: Boolean(parsed.stalledGenerationDetected),
      source,
    }
  } catch {
    return null
  }
}

function decorateHeartbeat(heartbeat, activeQueueJobs) {
  const parsedAt = Date.parse(String(heartbeat.at || ""))
  const ageMs = Number.isFinite(parsedAt) ? Math.max(0, Date.now() - parsedAt) : null
  const activeHeartbeatJobs = Array.isArray(heartbeat.activeJobIds) ? heartbeat.activeJobIds.length : 0
  const issues = [
    heartbeat.stalledGenerationDetected ? "stalled_generation_detected" : "",
    activeHeartbeatJobs > 0 && activeQueueJobs === 0 ? "heartbeat_active_jobs_without_queue_active_jobs" : "",
  ].filter(Boolean)

  return {
    ...heartbeat,
    ageMs,
    issues,
    healthy: ageMs !== null && ageMs <= GENERATION_WORKER_HEARTBEAT_MAX_AGE_MS && issues.length === 0,
  }
}

function compareHeartbeats(left, right) {
  if (left.healthy !== right.healthy) return left.healthy ? -1 : 1
  const leftAge = left.ageMs ?? Number.POSITIVE_INFINITY
  const rightAge = right.ageMs ?? Number.POSITIVE_INFINITY
  return leftAge - rightAge
}

async function getRedisWorkerHeartbeats(redis) {
  const indexedKeys = await redis.smembers(GENERATION_WORKER_HEARTBEAT_INDEX_KEY).catch(() => [])
  const indexed = indexedKeys.length > 0
    ? (await redis.mget(...indexedKeys).catch(() => [])).map((rawHeartbeat, index) =>
        parseHeartbeatPayload(rawHeartbeat, `redis:${indexedKeys[index] || GENERATION_WORKER_HEARTBEAT_KEY}`)
      ).filter(Boolean)
    : []

  if (indexed.length > 0) return indexed

  const legacy = parseHeartbeatPayload(
    await redis.get(GENERATION_WORKER_HEARTBEAT_KEY).catch(() => null),
    `redis:${GENERATION_WORKER_HEARTBEAT_KEY}`
  )
  return legacy ? [legacy] : []
}

async function getDatabaseWorkerHeartbeats() {
  try {
    const { PrismaClient } = require("@prisma/client")
    const prisma = new PrismaClient()
    try {
      const rows = await prisma.workerHeartbeat.findMany({
        where: {
          heartbeatAt: {
            gte: new Date(Date.now() - GENERATION_WORKER_HEARTBEAT_MAX_AGE_MS),
          },
        },
        orderBy: { heartbeatAt: "desc" },
        take: 20,
        select: {
          workerId: true,
          currentJobId: true,
          currentStage: true,
          lastSuccessfulTransition: true,
          heartbeatAt: true,
          runtimeInfoJson: true,
        },
      })

      return rows.map((row) => {
        let runtimeInfo = {}
        try {
          runtimeInfo = row.runtimeInfoJson ? JSON.parse(row.runtimeInfoJson) : {}
        } catch {
          runtimeInfo = {}
        }
        return {
          workerId: row.workerId,
          pid: Number(runtimeInfo.pid || 0),
          at: row.heartbeatAt.toISOString(),
          currentStage: row.currentStage || null,
          lastSuccessfulTransition: row.lastSuccessfulTransition || null,
          activeJobIds: Array.isArray(runtimeInfo.activeJobIds)
            ? runtimeInfo.activeJobIds.map(String)
            : row.currentJobId
              ? [row.currentJobId]
              : [],
          idleTimeoutMs: typeof runtimeInfo.idleTimeoutMs === "number" ? runtimeInfo.idleTimeoutMs : null,
          stalledGenerationDetected: Boolean(runtimeInfo.stalledGenerationDetected),
          source: "database:WorkerHeartbeat",
        }
      })
    } finally {
      await prisma.$disconnect().catch(() => {})
    }
  } catch {
    return []
  }
}

function isStrongSecret(input, minLength = 32) {
  const current = String(input || "")
  const normalized = current.trim().toLowerCase()
  const placeholderPattern =
    /^(change-me|changeme|development-auth-secret|password|secret|example|placeholder|replace-me|replace_me|todo|your-secret|your_secret|your-key|your_key)$/
  const placeholderPrefixPattern = /^(your|replace|example|placeholder)[_-]/i
  return current.length >= minLength && !placeholderPattern.test(normalized) && !placeholderPrefixPattern.test(current)
}

async function requestJson(url, label) {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 5000)

  try {
    const response = await fetch(url, {
      method: "GET",
      headers: {
        Accept: "application/json",
      },
      signal: controller.signal,
    })
    const text = await response.text()
    const body = text ? JSON.parse(text) : null
    return { ok: response.ok, statusCode: response.status, body }
  } catch (error) {
    return { ok: false, statusCode: 0, error: `${label} request failed: ${error instanceof Error ? error.message : String(error)}` }
  } finally {
    clearTimeout(timeout)
  }
}

function commandDiagnostic(command, options = {}) {
  try {
    const output = execSync(command, {
      cwd: process.cwd(),
      env: process.env,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: options.timeoutMs || 20_000,
    })
    return { ok: true, output: output.trim().slice(-2000) }
  } catch (error) {
    const output = [
      error.message,
      error.stdout,
      error.stderr,
      Array.isArray(error.output) ? error.output.join("\n") : "",
    ].filter(Boolean).join("\n")
    return { ok: false, output: output.trim().slice(-4000) }
  }
}

async function databaseConnectivityDiagnostic() {
  if (!isPostgresUrl(databaseUrl)) {
    return { ok: false, detail: "DATABASE_URL is missing or invalid." }
  }

  try {
    const { PrismaClient } = require("@prisma/client")
    const prisma = new PrismaClient()
    const startedAt = Date.now()
    await prisma.$queryRaw`SELECT 1`
    await prisma.$disconnect()
    return { ok: true, detail: `Connected in ${Date.now() - startedAt}ms.` }
  } catch (error) {
    return { ok: false, detail: error instanceof Error ? error.message : String(error) }
  }
}

async function generationWorkerHeartbeatDiagnostic() {
  const redisUrl = value("REDIS_URL", "UPSTASH_REDIS_URL")
  if (!isNativeRedisUrl(redisUrl)) {
    return { ok: false, detail: "Native REDIS_URL is missing, so worker heartbeat cannot be verified." }
  }

  let redis = null
  try {
    redis = new IORedis(redisUrl, {
      maxRetriesPerRequest: 1,
      enableReadyCheck: false,
      lazyConnect: true,
      connectTimeout: 5000,
      ...(redisUrl.startsWith("rediss://") ? { tls: {} } : {}),
    })
    await redis.connect()
    const ping = await redis.ping()
    const redisHeartbeats = await getRedisWorkerHeartbeats(redis)
    const activeQueueJobs = Number(await redis.llen("bull:swift-generation-v2:active").catch(() => 0))
    const redisCandidates = redisHeartbeats
      .map((heartbeat) => decorateHeartbeat(heartbeat, activeQueueJobs))
      .sort(compareHeartbeats)
    const redisHeartbeat = redisCandidates[0] || null
    const databaseCandidates = redisHeartbeat?.healthy
      ? []
      : (await getDatabaseWorkerHeartbeats())
          .map((heartbeat) => decorateHeartbeat(heartbeat, activeQueueJobs))
          .sort(compareHeartbeats)
    const databaseHeartbeat = databaseCandidates[0] || null
    const heartbeat = redisHeartbeat?.healthy ? redisHeartbeat : databaseHeartbeat?.healthy ? databaseHeartbeat : redisHeartbeat || databaseHeartbeat

    if (!heartbeat) {
      return { ok: false, detail: "Worker heartbeat key is missing in Redis. Start the dedicated worker service." }
    }

    const ok = ping === "PONG" && heartbeat.healthy

    return {
      ok,
      detail: ok
        ? `Heartbeat fresh at ${heartbeat.ageMs}ms (${heartbeat.workerId || "unknown-worker"}, ${heartbeat.source || "unknown-source"}).`
        : `Heartbeat unhealthy at ${heartbeat.ageMs ?? "unknown"}ms (${heartbeat.workerId || "unknown-worker"}, ${heartbeat.source || "unknown-source"}): ${heartbeat.issues.join(", ") || "stale_or_unreachable"}.`,
    }
  } catch (error) {
    return { ok: false, detail: error instanceof Error ? error.message : String(error) }
  } finally {
    if (redis) {
      await redis.quit().catch(() => {
        redis.disconnect()
      })
    }
  }
}

async function getRedisEvictionPolicy(redis) {
  try {
    const config = await redis.config("GET", "maxmemory-policy")
    const policy = Array.isArray(config) ? config[1] : ""
    if (policy) return String(policy).trim()
  } catch {
    // Some managed Redis providers disable CONFIG; fall back to INFO memory.
  }

  const info = await redis.info("memory")
  const line = info.split(/\r?\n/).find((item) => item.startsWith("maxmemory_policy:"))
  return line ? line.split(":")[1].trim() : "unknown"
}

async function redisEvictionPolicyDiagnostic() {
  const redisUrl = value("REDIS_URL", "UPSTASH_REDIS_URL")
  if (!isNativeRedisUrl(redisUrl)) {
    return { ok: false, detail: "Native REDIS_URL is missing, so Redis eviction policy cannot be verified." }
  }

  let redis = null
  try {
    redis = new IORedis(redisUrl, {
      maxRetriesPerRequest: 1,
      enableReadyCheck: false,
      lazyConnect: true,
      connectTimeout: 5000,
      ...(redisUrl.startsWith("rediss://") ? { tls: {} } : {}),
    })
    await redis.connect()
    let policy = await getRedisEvictionPolicy(redis)

    if (policy !== "noeviction" && value("SWIFT_REDIS_AUTO_SET_NOEVICTION") === "true") {
      try {
        await redis.config("SET", "maxmemory-policy", "noeviction")
        policy = await getRedisEvictionPolicy(redis)
      } catch {
        // Keep the original policy in the diagnostic below.
      }
    }

    return {
      ok: policy === "noeviction",
      detail: policy === "noeviction"
        ? "Redis maxmemory-policy is noeviction."
        : `Redis maxmemory-policy is ${policy}; set it to noeviction for BullMQ production safety.`,
    }
  } catch (error) {
    return { ok: false, detail: error instanceof Error ? error.message : String(error) }
  } finally {
    if (redis) {
      await redis.quit().catch(() => {
        redis.disconnect()
      })
    }
  }
}

async function sandboxRuntimeDiagnostic() {
  const sandboxUrl = normalizeUrl(value("SANDBOX_SERVICE_URL"))
  if (!sandboxUrl) {
    return { ok: false, detail: "SANDBOX_SERVICE_URL is missing." }
  }

  const response = await requestJson(`${sandboxUrl}/health`, "Sandbox health")
  if (!response.ok) {
    return {
      ok: false,
      detail: response.error || `Sandbox runtime returned HTTP ${response.statusCode}.`,
    }
  }

  const body = response.body && typeof response.body === "object" ? response.body : {}
  const runtime = body.runtime && typeof body.runtime === "object" ? body.runtime : {}
  const storage = runtime.storage && typeof runtime.storage === "object"
    ? runtime.storage
    : body.storage && typeof body.storage === "object"
      ? body.storage
      : null
  const hasStorageDetail = Boolean(storage)
  const rootReady = runtime.rootReady !== false
  const storageOk = Boolean(storage && storage.ok === true)
  const availableBytes = typeof storage?.availableBytes === "number" ? storage.availableBytes : null
  const minFreeBytes = typeof storage?.minFreeBytes === "number" ? storage.minFreeBytes : null
  const healthy =
    response.statusCode === 200 &&
    body.ok !== false &&
    hasStorageDetail &&
    rootReady &&
    storageOk &&
    (body.status === "healthy" || body.ok === true)

  return {
    ok: healthy,
    detail: healthy
      ? `Sandbox runtime health endpoint is healthy with storage available ${availableBytes ?? "unknown"} bytes.`
      : !hasStorageDetail
        ? "Sandbox runtime health endpoint is missing runtime.storage. Redeploy the sandbox runtime service and ensure storage health is exposed."
        : !rootReady
          ? `Sandbox runtime root is not ready: ${runtime.rootError || "unknown root error"}.`
          : !storageOk
            ? `Sandbox runtime storage is not ready: availableBytes=${availableBytes ?? "unknown"}, minFreeBytes=${minFreeBytes ?? "unknown"}.`
            : `Sandbox runtime returned status ${body.status || "unknown"}.`,
  }
}

async function workerRuntimeDiagnostic() {
  const workerHealthUrl = normalizeWorkerHealthUrl(value("SWIFT_WORKER_HEALTH_URL", "WORKER_HEALTH_URL"))
  if (!workerHealthUrl) {
    return { ok: true, status: "not_configured", detail: "SWIFT_WORKER_HEALTH_URL is not configured. Redis heartbeat will be used as the primary worker signal." }
  }

  const response = await requestJson(workerHealthUrl, "Worker health")
  if (!response.ok) {
    return {
      ok: false,
      detail: response.error || `Worker runtime returned HTTP ${response.statusCode}.`,
    }
  }

  const body = response.body && typeof response.body === "object" ? response.body : {}
  const healthy = response.statusCode === 200 && body.status === "healthy" && body.mode === "queue"

  return {
    ok: healthy,
    status: healthy ? "healthy" : "degraded_optional",
    detail: healthy
      ? "Dedicated worker runtime health endpoint is healthy."
      : `Worker runtime returned status ${body.status || "unknown"} in mode ${body.mode || "unknown"}.`,
  }
}

const nextAuthUrl = value("NEXTAUTH_URL")
const appUrl = value("NEXT_PUBLIC_APP_URL", "APP_URL", "NEXTAUTH_URL", "VERCEL_URL")
const databaseUrl = value("DATABASE_URL")
const directDatabaseUrl = value("DIRECT_DATABASE_URL", "DIRECT_URL", "POSTGRES_URL_NON_POOLING")
const generationExecutionMode = value("SWIFT_GENERATION_EXECUTION_MODE").toLowerCase()
const queueMode = !generationExecutionMode || generationExecutionMode === "queue"
const supabaseServiceRoleKey = value("SUPABASE_SERVICE_ROLE_KEY")
const supabasePublicKey = value("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_DEFAULT_KEY", "NEXT_PUBLIC_SUPABASE_ANON_KEY")
const metricsToken = value("SWIFT_METRICS_TOKEN")
const authProviderConfigured = Boolean(value("GOOGLE_CLIENT_ID") && value("GOOGLE_CLIENT_SECRET") && isStrongSecret(value("NEXTAUTH_SECRET")))
const migrationStatus = commandDiagnostic("npx prisma migrate status", { timeoutMs: 30_000 })
const schemaHealth = commandDiagnostic("node scripts/schema-health-check.js", { timeoutMs: 30_000 })

const checks = [
  required("DATABASE_URL", "Neon pooled PostgreSQL app URL", isPostgresUrl(databaseUrl), databaseUrl ? "Must be a PostgreSQL URL." : "Set the Neon pooled connection string."),
  recommended("DATABASE_URL_POOLING", "Serverless pooled Neon host", isNeonPooledUrl(databaseUrl), "Use the Neon pooler host for app runtime traffic."),
  recommended("DIRECT_DATABASE_URL", "Direct Neon URL for migrations/admin scripts", isPostgresUrl(directDatabaseUrl), "Set DIRECT_DATABASE_URL, DIRECT_URL, or POSTGRES_URL_NON_POOLING."),
  required("NEXTAUTH_SECRET", "Auth session secret", isStrongSecret(value("NEXTAUTH_SECRET")), "Must be at least 32 chars and not a placeholder."),
  required("NEXTAUTH_URL", "Canonical auth URL", isProductionUrl(nextAuthUrl), "Must be an https production URL, not localhost."),
  required("NEXT_PUBLIC_APP_URL", "Public app URL", isProductionUrl(appUrl), "Must be an https production URL, not localhost."),
  required("GOOGLE_CLIENT_ID", "Google OAuth client ID", value("GOOGLE_CLIENT_ID")),
  required("GOOGLE_CLIENT_SECRET", "Google OAuth client secret", isStrongSecret(value("GOOGLE_CLIENT_SECRET"), 24), "Must be present and non-placeholder."),
  required("AUTH_PROVIDER_HEALTH", "Auth provider health", authProviderConfigured, authProviderConfigured ? "Google OAuth and session secret configured." : "Missing or invalid Google OAuth/session env."),
  required("AGENTROUTER_API_KEY", "AI provider API key", isStrongSecret(value("AGENTROUTER_API_KEY", "OPENROUTER_API_KEY"), 20), "Must be present and non-placeholder."),
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
  required(
    "SWIFT_GENERATION_EXECUTION_MODE",
    "Queued generation execution for production",
    !generationExecutionMode || generationExecutionMode === "queue",
    generationExecutionMode
      ? "Use queue mode in production; serverless generation can hit platform execution limits."
      : "Defaults to queue mode."
  ),
  required(
    "SWIFT_DISABLE_SERVERLESS_GENERATION_FALLBACK",
    "Serverless generation fallback disabled in production",
    value("SWIFT_DISABLE_SERVERLESS_GENERATION_FALLBACK") === "true",
    "Set SWIFT_DISABLE_SERVERLESS_GENERATION_FALLBACK=true so production cannot silently bypass the dedicated worker."
  ),
  required("SANDBOX_SERVICE_URL", "External sandbox runtime URL", normalizeUrl(value("SANDBOX_SERVICE_URL"))),
  required("SANDBOX_SERVICE_TOKEN", "External sandbox bearer token", value("SANDBOX_SERVICE_TOKEN")),
  recommended("SWIFT_METRICS_TOKEN", "Internal observability bearer token", isStrongSecret(metricsToken, 32), "Set a random 32+ character token and pass it as Bearer token to metrics/monitoring health checks."),
  required("NEXT_PUBLIC_SUPABASE_URL", "Supabase project URL", value("NEXT_PUBLIC_SUPABASE_URL")),
  required(
    "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_DEFAULT_KEY",
    "Supabase public key",
    value("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_DEFAULT_KEY", "NEXT_PUBLIC_SUPABASE_ANON_KEY")
  ),
  required(
    "SUPABASE_SERVICE_ROLE_KEY",
    "Supabase service role key",
    isStrongSecret(supabaseServiceRoleKey, 32) && supabaseServiceRoleKey !== supabasePublicKey,
    supabaseServiceRoleKey === supabasePublicKey
      ? "Must not equal the public Supabase key."
      : "Must be present, non-placeholder, and at least 32 characters."
  ),
  required("SUPABASE_STORAGE_BUCKET", "Supabase storage bucket", value("SUPABASE_STORAGE_BUCKET")),
  required("VERDI_TEAM", "Vercel team scope for generated deployments", value("VERDI_TEAM")),
  recommended("VERPRO_ACCES_TOKEN", "Generated-app deploy token", value("VERPRO_ACCES_TOKEN")),
  recommended("PAKASIR_SLUG", "Payment merchant slug", value("PAKASIR_SLUG", "PAKASIR_MERCHANT_ID")),
  recommended("PAKASIR_API_KEY", "Payment API key", value("PAKASIR_API_KEY")),
  recommended("CRYPTO_PAYMENT_PRIVATE_KEY", "Crypto payment private key", value("CRYPTO_PAYMENT_PRIVATE_KEY")),
  recommended("NEXT_PUBLIC_CRYPTO_PAYMENT_ADDRESS", "Crypto payment receiving address", value("NEXT_PUBLIC_CRYPTO_PAYMENT_ADDRESS")),
  required("MIGRATION_STATUS", "Prisma migration status", migrationStatus.ok, migrationStatus.ok ? "No pending migration mismatch detected." : migrationStatus.output),
  required("SCHEMA_HEALTH", "Runtime schema compatibility", schemaHealth.ok, schemaHealth.ok ? "Runtime schema compatible." : schemaHealth.output),
]

async function main() {
  const dbConnectivity = await databaseConnectivityDiagnostic()
  const redisEvictionPolicy = await redisEvictionPolicyDiagnostic()
  const workerHeartbeat = queueMode
    ? await generationWorkerHeartbeatDiagnostic()
    : { ok: true, detail: "Queue mode disabled; worker heartbeat check skipped." }
  const workerRuntime = queueMode
    ? await workerRuntimeDiagnostic()
    : { ok: true, detail: "Queue mode disabled; worker runtime check skipped." }
  const sandboxRuntime = await sandboxRuntimeDiagnostic()
  checks.push(required("DB_CONNECTIVITY", "Database connectivity", dbConnectivity.ok, dbConnectivity.detail))
  checks.push(required("REDIS_EVICTION_POLICY", "Redis maxmemory policy for BullMQ", redisEvictionPolicy.ok, redisEvictionPolicy.detail))
  checks.push(required("GENERATION_WORKER_HEARTBEAT", "Dedicated worker heartbeat in Redis", workerHeartbeat.ok, workerHeartbeat.detail))
  checks.push(required("SANDBOX_RUNTIME_HEALTH", "Sandbox runtime /health endpoint", sandboxRuntime.ok, sandboxRuntime.detail))
  const workerHealthUrl = normalizeWorkerHealthUrl(value("SWIFT_WORKER_HEALTH_URL", "WORKER_HEALTH_URL"))
  checks.push(recommended("SWIFT_WORKER_HEALTH_URL", "Dedicated worker runtime health endpoint", workerHealthUrl, "Optional direct worker probe. Redis heartbeat is the primary production worker signal."))
  if (workerHealthUrl) {
    checks.push(recommended("GENERATION_WORKER_RUNTIME", "Dedicated worker /health endpoint", workerRuntime.ok, workerRuntime.detail))
  }

  const requiredMissing = checks.filter((check) => check.severity === "required" && !check.ok)
  const recommendedMissing = checks.filter((check) => check.severity === "recommended" && !check.ok)

  console.log("\nDeploy Readiness")
  console.log("----------------")
  console.log(`Target: ${isProductionDeployTarget ? "production" : deployTarget}`)
  console.log(`Env file: ${explicitEnvFile || "Next default env resolution"}`)
  for (const check of checks) {
    const state = check.ok ? "PASS" : check.severity === "required" ? "FAIL" : "WARN"
    console.log(`${state} ${check.key} - ${check.label}${check.detail ? ` (${check.detail})` : ""}`)
  }

  console.log("\nDeployment diagnostics")
  console.log(`missing env vars: ${checks.filter((check) => !check.ok && /URL|SECRET|KEY|TOKEN|TEAM|CONFIG/.test(check.key)).map((check) => check.key).join(", ") || "none"}`)
  console.log(`invalid secrets: ${checks.filter((check) => !check.ok && /SECRET|KEY|TOKEN/.test(check.key)).map((check) => check.key).join(", ") || "none"}`)
  console.log(`migration mismatch: ${migrationStatus.ok && schemaHealth.ok ? "none" : "detected"}`)
  console.log(`db connectivity: ${dbConnectivity.ok ? "ok" : "failed"}`)
  console.log(`auth provider health: ${authProviderConfigured ? "ok" : "failed"}`)

  console.log("\nSummary")
  console.log(`Required: ${checks.filter((check) => check.severity === "required" && check.ok).length}/${checks.filter((check) => check.severity === "required").length} passed`)
  console.log(`Recommended missing: ${recommendedMissing.length}`)

  if (requiredMissing.length > 0) {
    console.log(`NOT_READY_FOR_DEPLOY: ${requiredMissing.map((check) => check.key).join(", ")}`)
    process.exitCode = 1
  } else {
    console.log("READY_FOR_DEPLOY")
  }
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

main().catch((error) => {
  console.error("NOT_READY_FOR_DEPLOY:", error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})

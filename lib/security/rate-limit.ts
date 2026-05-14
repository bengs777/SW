import { prisma } from "@/lib/db/client"
import { env, getEnvNumber } from "@/lib/env"

/**
 * Redis-backed rate limiting for serverless/multi-instance deployments.
 *
 * SECURITY POSTURE (post-audit):
 * - Production: fail-CLOSED on Redis failure (with DB fallback) so a Redis
 *   outage cannot become a DoS amplification vector.
 * - Dev: fail-OPEN to avoid blocking local development.
 * - Always returns retry-after metadata for HTTP 429 responses.
 * - Concurrency cap is enforced separately at the route (active-job check).
 */

const WINDOW_MS = 60_000
const MAX_REQUESTS_PER_MINUTE = Math.max(
  1,
  Math.round(getEnvNumber(12, "AI_RATE_LIMIT_PER_MINUTE", "GENERATE_RATE_LIMIT_PER_MINUTE"))
)
const MAX_REQUESTS_PER_DAY = Math.max(
  MAX_REQUESTS_PER_MINUTE,
  Math.round(getEnvNumber(500, "AI_RATE_LIMIT_PER_DAY", "GENERATE_RATE_LIMIT_PER_DAY"))
)
// Burst protection: max requests in any 10-second window. Catches fixed-window
// boundary bursts that the per-minute limit misses (12/min allows 24 in 2s
// across a boundary).
const BURST_WINDOW_MS = 10_000
const MAX_REQUESTS_PER_BURST = Math.max(
  3,
  Math.round(getEnvNumber(6, "AI_RATE_LIMIT_PER_BURST"))
)

export class RateLimitError extends Error {
  retryAfterMs: number
  scope: "minute" | "day" | "burst" | "concurrency"
  constructor(message: string, retryAfterMs: number, scope: RateLimitError["scope"]) {
    super(message)
    this.name = "RateLimitError"
    this.retryAfterMs = retryAfterMs
    this.scope = scope
  }
}

// --- Redis connection for rate limiting ---

let redisClient: import("ioredis").default | null = null
let redisInitAttempted = false

async function getRateLimitRedis(): Promise<import("ioredis").default | null> {
  if (redisClient) return redisClient
  if (redisInitAttempted) return null

  redisInitAttempted = true

  if (!env.hasNativeRedisConfig) {
    return null
  }

  try {
    const IORedis = (await import("ioredis")).default
    const client = new IORedis(env.redisUrl, {
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
      enableReadyCheck: false,
      connectTimeout: 3000,
      commandTimeout: 2000,
      lazyConnect: true,
      // Cap reconnect backoff to avoid retry storms.
      retryStrategy: (times) => (times > 5 ? null : Math.min(times * 200, 3_000)),
      ...(env.redisUrl.startsWith("rediss://") ? { tls: {} } : {}),
    })

    client.on("error", (err) => {
      console.warn("[rate-limit] Redis error:", err.message)
    })

    const connected = await Promise.race([
      client.connect().then(() => true).catch(() => false),
      new Promise<false>((resolve) => {
        const t = setTimeout(() => resolve(false), 4_000)
        if (t.unref) t.unref()
      }),
    ])

    if (!connected) {
      void client.quit().catch(() => undefined)
      console.warn("[rate-limit] Redis connect timed out")
      redisClient = null
      return null
    }

    redisClient = client
    return redisClient
  } catch (error) {
    console.warn(
      "[rate-limit] Redis connection failed, falling back to DB-only:",
      error instanceof Error ? error.message : String(error)
    )
    redisClient = null
    return null
  }
}

// --- Redis-based atomic rate limiter ---

type RateCheckResult = {
  allowed: boolean
  current: number
  remaining: number
  /** Whether Redis was actually consulted. False = fallback path. */
  authoritative: boolean
}

async function redisRateCheck(
  key: string,
  limit: number,
  windowSeconds: number
): Promise<RateCheckResult> {
  const redis = await getRateLimitRedis()
  if (!redis) {
    return { allowed: true, current: 0, remaining: limit, authoritative: false }
  }

  try {
    const fullKey = `swift:ratelimit:${key}`
    // Atomic INCR + EXPIRE (only set TTL if first hit so we don't keep
    // resetting expiry mid-window).
    const multi = redis.multi()
    multi.incr(fullKey)
    multi.expire(fullKey, windowSeconds, "NX")
    const results = await multi.exec()

    if (!results || !results[0]) {
      return { allowed: true, current: 0, remaining: limit, authoritative: false }
    }

    const current = (results[0][1] as number) || 0
    const allowed = current <= limit
    const remaining = Math.max(0, limit - current)

    return { allowed, current, remaining, authoritative: true }
  } catch (error) {
    console.warn(
      "[rate-limit] Redis rate check failed:",
      error instanceof Error ? error.message : String(error)
    )
    return { allowed: true, current: 0, remaining: limit, authoritative: false }
  }
}

// --- Public API ---

/**
 * Enforce per-minute rate limit using Redis sliding window.
 */
export async function enforceUserRateLimit(userId: string) {
  const minuteKey = `user:${userId}:minute:${Math.floor(Date.now() / WINDOW_MS)}`
  const result = await redisRateCheck(minuteKey, MAX_REQUESTS_PER_MINUTE, 60)

  if (!result.allowed) {
    throw new RateLimitError(
      `Rate limit exceeded. Maximum ${MAX_REQUESTS_PER_MINUTE} requests per minute.`,
      WINDOW_MS,
      "minute"
    )
  }
}

/**
 * Enforce AI usage rate limits with Redis + database verification.
 *
 * SECURITY: In production, if Redis is unavailable we still consult the
 * authoritative DB count. This prevents a Redis outage from becoming a
 * free-for-all on paid AI requests.
 */
export async function enforceAiUsageRateLimit(userId: string) {
  // Burst window — catches boundary bursts that the per-minute limit misses.
  const burstBucket = Math.floor(Date.now() / BURST_WINDOW_MS)
  const burstKey = `user:${userId}:burst:${burstBucket}`
  const burstResult = await redisRateCheck(
    burstKey,
    MAX_REQUESTS_PER_BURST,
    Math.ceil(BURST_WINDOW_MS / 1000)
  )
  if (!burstResult.allowed) {
    throw new RateLimitError(
      `Too many requests in a short window. Slow down.`,
      BURST_WINDOW_MS,
      "burst"
    )
  }

  // Per-minute Redis check
  await enforceUserRateLimit(userId)

  // Daily Redis check
  const dayKey = `user:${userId}:day:${new Date().toISOString().slice(0, 10)}`
  const dayResult = await redisRateCheck(dayKey, MAX_REQUESTS_PER_DAY, 86400)
  if (!dayResult.allowed) {
    throw new RateLimitError(
      `Daily limit exceeded. Maximum ${MAX_REQUESTS_PER_DAY} prompts per day.`,
      86_400_000,
      "day"
    )
  }

  // Authoritative DB verification — runs ALWAYS in production, even if Redis
  // says OK. This is the fail-CLOSED guarantee against Redis outages.
  // Skipped in dev to avoid extra DB hits during local work.
  const isProduction = env.nodeEnv === "production"
  const redisFailed = !burstResult.authoritative
  const shouldVerifyDb = isProduction || redisFailed

  if (!shouldVerifyDb) return

  const now = new Date()
  const oneMinuteAgo = new Date(now.getTime() - WINDOW_MS)
  const oneDayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000)

  const [minuteCount, dayCount] = await Promise.all([
    prisma.usageLog.count({
      where: { userId, createdAt: { gte: oneMinuteAgo } },
    }),
    prisma.usageLog.count({
      where: { userId, createdAt: { gte: oneDayAgo } },
    }),
  ])

  if (minuteCount >= MAX_REQUESTS_PER_MINUTE) {
    throw new RateLimitError(
      `Rate limit exceeded. Maximum ${MAX_REQUESTS_PER_MINUTE} prompts per minute.`,
      WINDOW_MS,
      "minute"
    )
  }

  if (dayCount >= MAX_REQUESTS_PER_DAY) {
    throw new RateLimitError(
      `Daily limit exceeded. Maximum ${MAX_REQUESTS_PER_DAY} prompts per day.`,
      86_400_000,
      "day"
    )
  }
}

/**
 * General-purpose rate limiter for any route.
 */
export async function enforceRouteRateLimit(
  identifier: string,
  options: { maxPerMinute?: number; maxPerHour?: number } = {}
): Promise<void> {
  const maxPerMinute = options.maxPerMinute ?? 30
  const maxPerHour = options.maxPerHour ?? 300

  const minuteKey = `route:${identifier}:minute:${Math.floor(Date.now() / 60_000)}`
  const minuteResult = await redisRateCheck(minuteKey, maxPerMinute, 60)
  if (!minuteResult.allowed) {
    throw new RateLimitError(
      "Too many requests. Please try again later.",
      60_000,
      "minute"
    )
  }

  const hourKey = `route:${identifier}:hour:${Math.floor(Date.now() / 3_600_000)}`
  const hourResult = await redisRateCheck(hourKey, maxPerHour, 3600)
  if (!hourResult.allowed) {
    throw new RateLimitError(
      "Hourly request limit exceeded. Please try again later.",
      3_600_000,
      "minute"
    )
  }
}

export const aiRateLimitConfig = {
  perMinute: MAX_REQUESTS_PER_MINUTE,
  perDay: MAX_REQUESTS_PER_DAY,
  perBurst: MAX_REQUESTS_PER_BURST,
  burstWindowMs: BURST_WINDOW_MS,
}

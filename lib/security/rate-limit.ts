import { prisma } from "@/lib/db/client"
import { env, getEnvNumber } from "@/lib/env"

/**
 * Redis-backed rate limiting for serverless/multi-instance deployments.
 * Uses sliding window counter pattern with Redis INCR + EXPIRE.
 * Falls back to database count verification as defense-in-depth.
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
    redisClient = new IORedis(env.redisUrl, {
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
      enableReadyCheck: false,
      connectTimeout: 3000,
      commandTimeout: 2000,
      lazyConnect: true,
      ...(env.redisUrl.startsWith("rediss://") ? { tls: {} } : {}),
    })

    redisClient.on("error", (err) => {
      console.warn("[rate-limit] Redis error:", err.message)
    })

    await redisClient.connect()
    return redisClient
  } catch (error) {
    console.warn("[rate-limit] Redis connection failed, falling back to DB-only:", error instanceof Error ? error.message : String(error))
    redisClient = null
    return null
  }
}

// --- Redis-based sliding window rate limiter ---

async function redisRateCheck(
  key: string,
  limit: number,
  windowSeconds: number
): Promise<{ allowed: boolean; current: number; remaining: number }> {
  const redis = await getRateLimitRedis()
  if (!redis) {
    // If Redis unavailable, allow and rely on DB verification
    return { allowed: true, current: 0, remaining: limit }
  }

  try {
    const fullKey = `swift:ratelimit:${key}`
    const multi = redis.multi()
    multi.incr(fullKey)
    multi.expire(fullKey, windowSeconds)
    const results = await multi.exec()

    if (!results || !results[0]) {
      return { allowed: true, current: 0, remaining: limit }
    }

    const current = (results[0][1] as number) || 0
    const allowed = current <= limit
    const remaining = Math.max(0, limit - current)

    return { allowed, current, remaining }
  } catch (error) {
    console.warn("[rate-limit] Redis rate check failed:", error instanceof Error ? error.message : String(error))
    // Graceful degradation: allow on Redis failure
    return { allowed: true, current: 0, remaining: limit }
  }
}

// --- Public API ---

/**
 * Enforce per-minute rate limit using Redis sliding window.
 * Replaces the old in-memory Map-based approach that didn't work in serverless.
 */
export async function enforceUserRateLimit(userId: string) {
  const minuteKey = `user:${userId}:minute:${Math.floor(Date.now() / WINDOW_MS)}`
  const result = await redisRateCheck(minuteKey, MAX_REQUESTS_PER_MINUTE, 60)

  if (!result.allowed) {
    throw new Error(`Rate limit exceeded. Maximum ${MAX_REQUESTS_PER_MINUTE} requests per minute.`)
  }
}

/**
 * Enforce AI usage rate limits with Redis + database verification.
 * This provides defense-in-depth: Redis for fast rejection, DB for accurate counts.
 */
export async function enforceAiUsageRateLimit(userId: string) {
  // Fast path: Redis-based rate limiting
  await enforceUserRateLimit(userId)

  // Check daily limit via Redis
  const dayKey = `user:${userId}:day:${new Date().toISOString().slice(0, 10)}`
  const dayResult = await redisRateCheck(dayKey, MAX_REQUESTS_PER_DAY, 86400)

  if (!dayResult.allowed) {
    throw new Error(`Daily limit exceeded. Maximum ${MAX_REQUESTS_PER_DAY} paid prompts per day.`)
  }

  // Defense-in-depth: Verify against database for accurate billing counts
  // This catches any Redis failures/resets but only on borderline cases
  const now = new Date()
  const oneMinuteAgo = new Date(now.getTime() - WINDOW_MS)
  const oneDayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000)

  const [minuteCount, dayCount] = await Promise.all([
    prisma.usageLog.count({
      where: {
        userId,
        createdAt: {
          gte: oneMinuteAgo,
        },
      },
    }),
    prisma.usageLog.count({
      where: {
        userId,
        createdAt: {
          gte: oneDayAgo,
        },
      },
    }),
  ])

  if (minuteCount >= MAX_REQUESTS_PER_MINUTE) {
    throw new Error(`Rate limit exceeded. Maximum ${MAX_REQUESTS_PER_MINUTE} paid prompts per minute.`)
  }

  if (dayCount >= MAX_REQUESTS_PER_DAY) {
    throw new Error(`Daily limit exceeded. Maximum ${MAX_REQUESTS_PER_DAY} paid prompts per day.`)
  }
}

/**
 * General-purpose rate limiter for any route.
 * Can be used by other endpoints (billing, admin, etc.)
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
    throw new Error("Too many requests. Please try again later.")
  }

  const hourKey = `route:${identifier}:hour:${Math.floor(Date.now() / 3_600_000)}`
  const hourResult = await redisRateCheck(hourKey, maxPerHour, 3600)

  if (!hourResult.allowed) {
    throw new Error("Hourly request limit exceeded. Please try again later.")
  }
}

export const aiRateLimitConfig = {
  perMinute: MAX_REQUESTS_PER_MINUTE,
  perDay: MAX_REQUESTS_PER_DAY,
}

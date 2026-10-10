import { db } from "@/lib/db/client"
import { usageLogs } from "@/lib/db/schema"
import { eq, and, gte, inArray, sql } from "drizzle-orm"
import { env, getEnvNumber } from "@/lib/env"

/**
 * Redis-backed rate limiting for serverless/multi-instance deployments.
 * Uses a fixed window counter kept in Redis (admitted requests only) and
 * falls back to database count verification as defense-in-depth.
 * Failed generations are refunded and release their daily quota again.
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
const MAX_GENERATIONS_PER_HOUR = Math.max(
  1,
  Math.round(getEnvNumber(60, "AI_GENERATION_RATE_LIMIT_PER_HOUR", "GENERATION_RATE_LIMIT_PER_HOUR"))
)
const MAX_UPLOADS_PER_DAY = Math.max(
  1,
  Math.round(getEnvNumber(100, "UPLOAD_RATE_LIMIT_PER_DAY", "AI_UPLOAD_RATE_LIMIT_PER_DAY"))
)
const FREE_GENERATIONS_PER_DAY = Math.max(
  1,
  Math.round(getEnvNumber(3, "FREE_GENERATE_LIMIT_PER_DAY", "FREE_GENERATIONS_PER_DAY"))
)
const MAX_AI_CHAT_PER_DAY = Math.max(
  1,
  Math.round(getEnvNumber(100, "AI_CHAT_RATE_LIMIT_PER_DAY", "AI_ASSIST_RATE_LIMIT_PER_DAY"))
)

// Usage log states that consume a generation slot: an attempt that is still
// in flight or that finished successfully. Refunded/failed attempts are excluded
// so a provider outage never burns the free daily quota.
const QUOTA_CONSUMING_STATUSES = ["reserved", "pending", "completed", "direct"]

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

// --- Redis-based fixed window rate limiter ---

// Atomically admits a request only while the counter is below the limit.
// Rejected requests must not increment the counter and must not refresh the
// TTL: otherwise retries caused by a provider outage keep inflating the counter
// and sliding the block window forward.
const ADMIT_BELOW_LIMIT_SCRIPT = `
local limit = tonumber(ARGV[1])
local ttl = tonumber(ARGV[2])
local current = tonumber(redis.call("get", KEYS[1]) or "0")
if current >= limit then
  return -1
end
current = redis.call("incr", KEYS[1])
if current == 1 then
  redis.call("expire", KEYS[1], ttl)
end
return current
`

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
    const result = Number(
      await redis.eval(ADMIT_BELOW_LIMIT_SCRIPT, 1, fullKey, String(limit), String(windowSeconds))
    )

    if (result === -1) {
      return { allowed: false, current: limit, remaining: 0 }
    }

    const current = Number.isFinite(result) && result > 0 ? result : 0
    return {
      allowed: true,
      current,
      remaining: Math.max(0, limit - current),
    }
  } catch (error) {
    console.warn("[rate-limit] Redis rate check failed:", error instanceof Error ? error.message : String(error))
    // Graceful degradation: allow on Redis failure
    return { allowed: true, current: 0, remaining: limit }
  }
}

// --- Public API ---

/**
 * Enforce per-minute rate limit using a Redis fixed window counter.
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
  // Fast path: Redis-based rate limiting (per-minute and per-hour security rate limits)
  await enforceUserRateLimit(userId)
  await enforceGenerationHourlyRateLimit(userId)

  // Defense-in-depth: Verify against database for per-minute rate limit
  const now = new Date()
  const oneMinuteAgo = new Date(now.getTime() - WINDOW_MS)

  const minuteCount = await db.select({ count: sql<number>`count(*)` }).from(usageLogs).where(
    and(
      eq(usageLogs.userId, userId),
      gte(usageLogs.createdAt, oneMinuteAgo),
      inArray(usageLogs.status, QUOTA_CONSUMING_STATUSES)
    )
  ).then((rows) => rows[0]?.count ?? 0)

  if (minuteCount >= MAX_REQUESTS_PER_MINUTE) {
    throw new Error(`Rate limit exceeded. Maximum ${MAX_REQUESTS_PER_MINUTE} paid prompts per minute.`)
  }
}

/**
 * Daily cap for paid assistant endpoints (AI chat / auto-repair) that do not
 * reserve usage-log quota. Bounds provider spend when Redis is available.
 */
export async function enforceAiChatDailyRateLimit(userId: string) {
  const dayKey = `user:${userId}:ai-chat-day:${new Date().toISOString().slice(0, 10)}`
  const result = await redisRateCheck(dayKey, MAX_AI_CHAT_PER_DAY, 86400)

  if (!result.allowed) {
    throw new Error(
      `Daily AI assistant limit exceeded. Maximum ${MAX_AI_CHAT_PER_DAY} requests per day.`
    )
  }
}

export async function enforceGenerationHourlyRateLimit(userId: string) {
  const hourKey = `user:${userId}:generation-hour:${Math.floor(Date.now() / 3_600_000)}`
  const hourResult = await redisRateCheck(hourKey, MAX_GENERATIONS_PER_HOUR, 3600)

  if (!hourResult.allowed) {
    throw new Error(`Generation rate limit exceeded. Maximum ${MAX_GENERATIONS_PER_HOUR} generations per hour.`)
  }
}

/**
 * Give the daily generation quota back after a failed attempt is refunded.
 *
 * The day counter is incremented when the request starts, before the provider
 * is called, so the refund path must release it again. Otherwise a provider
 * outage silently burns the free daily quota of every user.
 *
 * Only the daily quota is released: the per-minute and per-hour counters are
 * abuse protection and must keep bounding how often the provider can be hit.
 * Best effort on purpose, a lost release only postpones the next attempt.
 */
export async function releaseAiUsageQuota(userId: string, attemptedAt: Date = new Date()) {
  const redis = await getRateLimitRedis()
  if (!redis) return

  const counter = `swift:ratelimit:user:${userId}:day:${attemptedAt.toISOString().slice(0, 10)}`

  try {
    const current = Number(await redis.get(counter))
    if (Number.isFinite(current) && current > 0) {
      await redis.decr(counter)
    }
  } catch (error) {
    console.warn("[rate-limit] Failed to release quota counter:", error instanceof Error ? error.message : String(error))
  }
}

export async function enforceUploadDailyRateLimit(userId: string, uploadCount = 1) {
  const dayKey = `user:${userId}:uploads-day:${new Date().toISOString().slice(0, 10)}`

  for (let index = 0; index < Math.max(1, uploadCount); index += 1) {
    const dayResult = await redisRateCheck(dayKey, MAX_UPLOADS_PER_DAY, 86400)
    if (!dayResult.allowed) {
      throw new Error(`Upload rate limit exceeded. Maximum ${MAX_UPLOADS_PER_DAY} uploaded files per day.`)
    }
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
  generationPerHour: MAX_GENERATIONS_PER_HOUR,
  perDay: MAX_REQUESTS_PER_DAY,
  uploadPerDay: MAX_UPLOADS_PER_DAY,
  freePerDay: FREE_GENERATIONS_PER_DAY,
  aiChatPerDay: MAX_AI_CHAT_PER_DAY,
}

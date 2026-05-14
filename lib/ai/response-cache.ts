import { createHash } from "node:crypto"
import { env } from "@/lib/env"

/**
 * AI response cache (Redis-backed) for cost reduction.
 *
 * Strategy:
 * - Cache deterministic AI responses (chat & inspect modes) by content hash.
 * - File-generation mode is NOT cached because outputs depend on existing project state
 *   that changes per request.
 * - Short TTL for chat (5 min) — same user often re-asks within a session.
 * - Longer TTL for inspect (30 min) — debug context tends to stay relevant.
 *
 * Why content hash, not user id?
 * - Maximizes cache hits across users for common questions ("apa itu JWT?", greeting, etc).
 * - Privacy-safe: prompts that include private data have unique hashes anyway.
 *
 * Falls back gracefully if Redis is unavailable — never blocks the request.
 */

type CacheableMode = "chat" | "inspect"

const CACHE_PREFIX = "swift:ai:cache"
const CACHE_TTL_BY_MODE: Record<CacheableMode, number> = {
  chat: 300, // 5 minutes
  inspect: 1800, // 30 minutes
}

let redisClient: import("ioredis").default | null = null
let redisInitAttempted = false

async function getCacheRedis(): Promise<import("ioredis").default | null> {
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
      connectTimeout: 2000,
      commandTimeout: 1500,
      lazyConnect: true,
      ...(env.redisUrl.startsWith("rediss://") ? { tls: {} } : {}),
    })

    redisClient.on("error", (err) => {
      // Soft-fail: log but don't block
      console.warn("[ai-cache] Redis error:", err.message)
    })

    await redisClient.connect()
    return redisClient
  } catch (error) {
    console.warn(
      "[ai-cache] Cache disabled (Redis unavailable):",
      error instanceof Error ? error.message : String(error)
    )
    redisClient = null
    return null
  }
}

/**
 * Hash the prompt + system prompt + temperature into a stable cache key.
 * Identical inputs produce identical keys, regardless of order or whitespace differences.
 */
export function buildCacheKey(input: {
  mode: CacheableMode
  modelId: string
  prompt: string
  systemPrompt: string
  temperature: number
}): string {
  const normalized = JSON.stringify({
    m: input.modelId,
    s: input.systemPrompt.trim(),
    p: input.prompt.trim().replace(/\s+/g, " "),
    t: Math.round(input.temperature * 100) / 100,
  })
  const hash = createHash("sha256").update(normalized).digest("hex").slice(0, 32)
  return `${CACHE_PREFIX}:${input.mode}:${hash}`
}

export type CachedAiResponse = {
  message: string
  tokenUsage?: {
    promptTokens?: number
    completionTokens?: number
    totalTokens?: number
  }
  cachedAt: string
}

export async function getCachedResponse(key: string): Promise<CachedAiResponse | null> {
  const redis = await getCacheRedis()
  if (!redis) return null

  try {
    const raw = await redis.get(key)
    if (!raw) return null
    return JSON.parse(raw) as CachedAiResponse
  } catch (error) {
    console.warn("[ai-cache] Cache read failed:", error instanceof Error ? error.message : String(error))
    return null
  }
}

export async function setCachedResponse(
  key: string,
  mode: CacheableMode,
  value: Omit<CachedAiResponse, "cachedAt">
): Promise<void> {
  const redis = await getCacheRedis()
  if (!redis) return

  const ttl = CACHE_TTL_BY_MODE[mode]
  try {
    const payload: CachedAiResponse = {
      ...value,
      cachedAt: new Date().toISOString(),
    }
    await redis.set(key, JSON.stringify(payload), "EX", ttl)
  } catch (error) {
    // Soft-fail: cache miss next time is acceptable
    console.warn("[ai-cache] Cache write failed:", error instanceof Error ? error.message : String(error))
  }
}

/**
 * Invalidate cache by key prefix (e.g., when AI behavior changes via deployment).
 */
export async function invalidateCachePrefix(prefix: string): Promise<number> {
  const redis = await getCacheRedis()
  if (!redis) return 0

  try {
    const keys = await redis.keys(`${CACHE_PREFIX}:${prefix}*`)
    if (keys.length === 0) return 0
    return await redis.del(...keys)
  } catch (error) {
    console.warn("[ai-cache] Cache invalidation failed:", error instanceof Error ? error.message : String(error))
    return 0
  }
}

/**
 * Warm the cache connection at startup so first request is not slowed down.
 */
export async function warmCacheConnection(): Promise<boolean> {
  const redis = await getCacheRedis()
  if (!redis) return false
  try {
    await redis.ping()
    return true
  } catch {
    return false
  }
}

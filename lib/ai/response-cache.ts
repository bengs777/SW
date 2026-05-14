import { createHash } from "node:crypto"
import { env } from "@/lib/env"

/**
 * AI response cache (Redis-backed) for cost reduction.
 *
 * Strategy:
 * - Cache deterministic AI responses (chat & inspect modes) by content hash.
 * - File-generation mode is NOT cached because outputs depend on existing
 *   project state that changes per request.
 * - Short TTL for chat (5 min) — same user often re-asks within a session.
 * - Longer TTL for inspect (30 min) — debug context tends to stay relevant.
 *
 * Privacy: prompts are hashed; identical inputs produce identical keys
 * regardless of user. Private prompt content is unique → unique hash → no
 * cross-user leakage.
 *
 * RELIABILITY POSTURE (post-audit):
 *   - Soft-fail on every failure mode. Cache miss / Redis outage / TLS hang
 *     never blocks generation.
 *   - Hard wall-clock on connect AND on every read/write — undici/ioredis
 *     have been observed to hang past `commandTimeout` in production.
 *   - Init backoff: a failed connect cools down for INIT_RETRY_AFTER_MS, then
 *     re-attempts. Previously a single startup blip disabled the cache for
 *     the entire lambda lifetime, producing the persistent `cacheOk:false`
 *     log spam from the warmup module.
 *   - Connection state is global-pinned so it survives Next.js dev HMR.
 */

type CacheableMode = "chat" | "inspect"

const CACHE_PREFIX = "swift:ai:cache"
const CACHE_TTL_BY_MODE: Record<CacheableMode, number> = {
  chat: 300, // 5 minutes
  inspect: 1800, // 30 minutes
}

const CONNECT_TIMEOUT_MS = 2_000
const CONNECT_WALL_CLOCK_MS = 3_000
const COMMAND_TIMEOUT_MS = 1_500
const COMMAND_WALL_CLOCK_MS = 2_000
const INIT_RETRY_AFTER_MS = 30_000

type IORedisClient = import("ioredis").default

type CacheState = {
  client: IORedisClient | null
  /** Promise of the in-flight connect attempt, so concurrent callers de-dup. */
  connecting: Promise<IORedisClient | null> | null
  /** Timestamp of the last failed connect; we won't retry until this + retry-after. */
  lastFailureAt: number
  /** True once we've logged the first disabled-cache message; prevents log spam. */
  loggedDisabled: boolean
}

const globalRef = globalThis as typeof globalThis & {
  __swiftAiCacheState?: CacheState
}

function getState(): CacheState {
  if (!globalRef.__swiftAiCacheState) {
    globalRef.__swiftAiCacheState = {
      client: null,
      connecting: null,
      lastFailureAt: 0,
      loggedDisabled: false,
    }
  }
  return globalRef.__swiftAiCacheState
}

function withWallClock<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  return new Promise<T>((resolve) => {
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      resolve(fallback)
    }, ms)
    if (timer.unref) timer.unref()
    promise.then(
      (value) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve(value)
      },
      () => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve(fallback)
      }
    )
  })
}

async function openClient(): Promise<IORedisClient | null> {
  const state = getState()

  if (!env.hasNativeRedisConfig) {
    if (!state.loggedDisabled) {
      state.loggedDisabled = true
      console.info("[ai-cache] Disabled: native REDIS_URL not configured")
    }
    return null
  }

  let client: IORedisClient
  try {
    const IORedis = (await import("ioredis")).default
    client = new IORedis(env.redisUrl, {
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
      enableReadyCheck: false,
      connectTimeout: CONNECT_TIMEOUT_MS,
      commandTimeout: COMMAND_TIMEOUT_MS,
      lazyConnect: true,
      // Cap reconnect backoff so a sick Redis doesn't produce unbounded retry
      // storms. After 3 failed reconnects we stop and let our re-init logic
      // open a fresh client on the next operation.
      retryStrategy: (times) => (times > 3 ? null : Math.min(times * 200, 2_000)),
      ...(env.redisUrl.startsWith("rediss://") ? { tls: {} } : {}),
    })
  } catch (error) {
    console.warn(
      "[ai-cache] Redis import failed:",
      error instanceof Error ? error.message : String(error)
    )
    state.lastFailureAt = Date.now()
    return null
  }

  client.on("error", (err) => {
    // Soft-fail: log but don't block. Surface only the message; ioredis
    // attaches verbose stack traces that drown real signals.
    console.warn("[ai-cache] Redis connection error:", err.message)
  })

  // Hard wall-clock on connect. ioredis.connect() can hang past
  // connectTimeout on TLS handshake failures.
  const connected = await withWallClock(
    client.connect().then(() => true).catch(() => false),
    CONNECT_WALL_CLOCK_MS,
    false
  )

  if (!connected) {
    void client.quit().catch(() => undefined)
    state.lastFailureAt = Date.now()
    if (!state.loggedDisabled) {
      state.loggedDisabled = true
      console.warn("[ai-cache] Cache disabled: connect timed out (will retry on next op)")
    }
    return null
  }

  // Successful connect — reset disabled-log so future failures log fresh.
  state.loggedDisabled = false
  state.lastFailureAt = 0
  return client
}

async function getCacheRedis(): Promise<IORedisClient | null> {
  const state = getState()

  // Fast path: existing healthy client.
  if (state.client) return state.client

  // Cool-down: a previous attempt failed recently. Don't retry yet.
  if (state.lastFailureAt && Date.now() - state.lastFailureAt < INIT_RETRY_AFTER_MS) {
    return null
  }

  // De-dup concurrent connect attempts.
  if (state.connecting) return state.connecting

  state.connecting = openClient()
    .then((client) => {
      state.client = client
      return client
    })
    .finally(() => {
      state.connecting = null
    })

  return state.connecting
}

/**
 * Hash the prompt + system prompt + temperature into a stable cache key.
 * Identical inputs produce identical keys, regardless of order or whitespace
 * differences.
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

/**
 * Drop a known-bad client and record a failure so the next caller will
 * cool-down before reconnecting. Important: we don't await `quit()` here —
 * that's a fire-and-forget cleanup. The state.lastFailureAt write is what
 * matters for the read-path.
 */
function dropClient(reason: string) {
  const state = getState()
  const previous = state.client
  state.client = null
  state.lastFailureAt = Date.now()
  if (previous) {
    void previous.quit().catch(() => undefined)
    console.warn(`[ai-cache] Dropped client: ${reason}`)
  }
}

export async function getCachedResponse(key: string): Promise<CachedAiResponse | null> {
  const redis = await getCacheRedis()
  if (!redis) return null

  try {
    const raw = await withWallClock(redis.get(key), COMMAND_WALL_CLOCK_MS, null)
    if (!raw) return null
    return JSON.parse(raw) as CachedAiResponse
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.warn("[ai-cache] Cache read failed:", message)
    // If the underlying connection is dead, drop it so the next call opens fresh.
    if (/closed|stream isn't writeable|connection/i.test(message)) {
      dropClient("read_error")
    }
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
    await withWallClock(
      redis.set(key, JSON.stringify(payload), "EX", ttl).then(() => undefined),
      COMMAND_WALL_CLOCK_MS,
      undefined
    )
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.warn("[ai-cache] Cache write failed:", message)
    if (/closed|stream isn't writeable|connection/i.test(message)) {
      dropClient("write_error")
    }
  }
}

/**
 * Invalidate cache by key prefix (e.g., when AI behavior changes via deployment).
 */
export async function invalidateCachePrefix(prefix: string): Promise<number> {
  const redis = await getCacheRedis()
  if (!redis) return 0

  try {
    const keys = await withWallClock(redis.keys(`${CACHE_PREFIX}:${prefix}*`), 5_000, [] as string[])
    if (keys.length === 0) return 0
    return await withWallClock(redis.del(...keys), 5_000, 0)
  } catch (error) {
    console.warn(
      "[ai-cache] Cache invalidation failed:",
      error instanceof Error ? error.message : String(error)
    )
    return 0
  }
}

/**
 * Warm the cache connection at startup so the first request is not slowed
 * down by the connect handshake. Safe to call multiple times.
 */
export async function warmCacheConnection(): Promise<boolean> {
  const redis = await getCacheRedis()
  if (!redis) return false
  try {
    const result = await withWallClock(
      redis.ping().then(() => true).catch(() => false),
      COMMAND_WALL_CLOCK_MS,
      false
    )
    if (!result) {
      dropClient("ping_failed")
    }
    return result
  } catch {
    dropClient("ping_threw")
    return false
  }
}

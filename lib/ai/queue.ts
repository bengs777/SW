import { env } from "@/lib/env"
import { USER_FRIENDLY_QUEUE_OVERLOAD_ERROR, getSwiftTierConfig, type SwiftTierKey } from "@/lib/ai/swift-tiers"

type IORedisClient = import("ioredis").default

type QueueLeaseInput = {
  userId: string
  projectId: string
  tierKey: SwiftTierKey
  requestKey: string
  timeoutMs?: number
}

type QueueLease = {
  queueWaitMs: number
  release: () => Promise<void>
}

export class SwiftQueueError extends Error {
  code: "duplicate" | "overloaded" | "timeout" | "config"
  status: number

  constructor(code: SwiftQueueError["code"], message: string, status = 429) {
    super(message)
    this.name = "SwiftQueueError"
    this.code = code
    this.status = status
  }
}

const memoryActive = new Map<string, number>()
const memoryDuplicates = new Set<string>()
let redisClient: IORedisClient | null = null

function getRedis() {
  const hasRedisConfig =
    !!env.redisUrl ||
    (
      !!env.upstashRedisRestUrl &&
      !!env.upstashRedisRestToken
    )

  if (
    env.nodeEnv === "production" &&
    !hasRedisConfig
  ) {
    throw new SwiftQueueError(
      "config",
      "Redis configuration is required for production AI queue protection.",
      500
    )
  }

  if (!env.redisUrl) {
    return null
  }

  if (!redisClient) {
    // Dynamic import resolved at first call — avoids pulling ioredis into the
    // webpack bundle graph during static analysis / build.
    const IORedis = require("ioredis") as typeof import("ioredis").default
    redisClient = new IORedis(env.redisUrl, {
      maxRetriesPerRequest: 2,
      enableReadyCheck: true,
      lazyConnect: true,
    })
  }

  return redisClient
}

async function evalQueueScript(
  script: string,
  keys: string[],
  args: string[]
): Promise<string[]> {
  if (!env.upstashRedisRestUrl || !env.upstashRedisRestToken) {
    throw new SwiftQueueError(
      "config",
      "Redis configuration is required for production AI queue protection.",
      500
    )
  }

  const response = await fetch(env.upstashRedisRestUrl, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.upstashRedisRestToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(["EVAL", script, String(keys.length), ...keys, ...args]),
  })
  const payload = await response.json().catch(() => null) as { result?: unknown; error?: string } | null

  if (!response.ok || payload?.error) {
    throw new SwiftQueueError(
      "config",
      payload?.error || "Upstash Redis REST command failed.",
      500
    )
  }

  return Array.isArray(payload?.result) ? payload.result.map(String) : []
}

const acquireScript = `
local activeKey = KEYS[1]
local depthKey = KEYS[2]
local duplicateKey = KEYS[3]
local queuedKey = KEYS[4]
local token = ARGV[1]
local concurrency = tonumber(ARGV[2])
local maxDepth = tonumber(ARGV[3])
local ttlMs = tonumber(ARGV[4])

local existing = redis.call("GET", duplicateKey)
if existing and existing ~= token then
  return {"duplicate", redis.call("GET", activeKey) or "0", redis.call("GET", depthKey) or "0"}
end

redis.call("SET", duplicateKey, token, "PX", ttlMs)
local active = tonumber(redis.call("GET", activeKey) or "0")
if active < concurrency then
  redis.call("INCR", activeKey)
  redis.call("PEXPIRE", activeKey, ttlMs)
  if redis.call("GET", queuedKey) == token then
    redis.call("DEL", queuedKey)
    local depth = tonumber(redis.call("GET", depthKey) or "0")
    if depth > 0 then redis.call("DECR", depthKey) end
  end
  return {"acquired", tostring(active + 1), redis.call("GET", depthKey) or "0"}
end

if redis.call("GET", queuedKey) ~= token then
  local depth = tonumber(redis.call("GET", depthKey) or "0")
  if depth >= maxDepth then
    redis.call("DEL", duplicateKey)
    return {"overloaded", tostring(active), tostring(depth)}
  end
  redis.call("SET", queuedKey, token, "PX", ttlMs)
  redis.call("INCR", depthKey)
  redis.call("PEXPIRE", depthKey, ttlMs)
end

return {"queued", tostring(active), redis.call("GET", depthKey) or "0"}
`

const releaseScript = `
local activeKey = KEYS[1]
local depthKey = KEYS[2]
local duplicateKey = KEYS[3]
local queuedKey = KEYS[4]
local token = ARGV[1]
local existing = redis.call("GET", duplicateKey)
if existing == token then redis.call("DEL", duplicateKey) end
if redis.call("GET", queuedKey) == token then
  redis.call("DEL", queuedKey)
  local depth = tonumber(redis.call("GET", depthKey) or "0")
  if depth > 0 then redis.call("DECR", depthKey) end
end
local active = tonumber(redis.call("GET", activeKey) or "0")
if active > 0 then redis.call("DECR", activeKey) end
return {"released"}
`

export async function acquireSwiftQueueSlot(input: QueueLeaseInput): Promise<QueueLease> {
  const tier = getSwiftTierConfig(input.tierKey)
  if (!tier) {
    throw new SwiftQueueError("config", "Selected Swift tier is not available.", 400)
  }

  const startedAt = Date.now()
  const timeoutMs = input.timeoutMs ?? env.aiQueueTimeoutMs
  const token = `${input.userId}:${input.projectId}:${Date.now()}:${Math.random().toString(36).slice(2)}`
  const duplicateKey = `swift:ai:duplicate:${input.requestKey}`

  const redis = getRedis()
  if (!redis) {
    if (env.upstashRedisRestUrl && env.upstashRedisRestToken) {
      return acquireRestSlot(input, tier.queue.concurrency, tier.queue.maxQueueDepth, startedAt, duplicateKey, timeoutMs, tier.timeoutMs)
    }

    return acquireMemorySlot(input, tier.queue.concurrency, startedAt, duplicateKey)
  }

  const keys = [
    `swift:ai:active:${tier.key}`,
    `swift:ai:queued:${tier.key}`,
    duplicateKey,
    `swift:ai:queued-token:${token}`,
  ]
  const ttlMs = Math.max(timeoutMs + tier.timeoutMs + 30_000, 120_000)

  while (Date.now() - startedAt < timeoutMs) {
    const result = await redis.eval(
      acquireScript,
      keys.length,
      ...keys,
      token,
      String(tier.queue.concurrency),
      String(tier.queue.maxQueueDepth),
      String(ttlMs)
    ) as string[]
    const status = result[0]

    if (status === "acquired") {
      return {
        queueWaitMs: Date.now() - startedAt,
        release: async () => {
          await redis.eval(releaseScript, keys.length, ...keys, token)
        },
      }
    }

    if (status === "duplicate") {
      throw new SwiftQueueError("duplicate", "Request yang sama sedang diproses. Swift membatalkan duplikasi agar saldo tidak terpakai dua kali.", 409)
    }

    if (status === "overloaded") {
      throw new SwiftQueueError("overloaded", USER_FRIENDLY_QUEUE_OVERLOAD_ERROR, 429)
    }

    await new Promise((resolve) => setTimeout(resolve, 250))
  }

  await redis.eval(releaseScript, keys.length, ...keys, token)
  throw new SwiftQueueError("timeout", USER_FRIENDLY_QUEUE_OVERLOAD_ERROR, 429)
}

async function acquireRestSlot(
  input: QueueLeaseInput,
  concurrency: number,
  maxQueueDepth: number,
  startedAt: number,
  duplicateKey: string,
  timeoutMs: number,
  tierTimeoutMs: number
): Promise<QueueLease> {
  const token = `${input.userId}:${input.projectId}:${Date.now()}:${Math.random().toString(36).slice(2)}`
  const keys = [
    `swift:ai:active:${input.tierKey}`,
    `swift:ai:queued:${input.tierKey}`,
    duplicateKey,
    `swift:ai:queued-token:${token}`,
  ]
  const ttlMs = Math.max(timeoutMs + tierTimeoutMs + 30_000, 120_000)

  while (Date.now() - startedAt < timeoutMs) {
    const result = await evalQueueScript(acquireScript, keys, [
      token,
      String(concurrency),
      String(maxQueueDepth),
      String(ttlMs),
    ])
    const status = result[0]

    if (status === "acquired") {
      return {
        queueWaitMs: Date.now() - startedAt,
        release: async () => {
          await evalQueueScript(releaseScript, keys, [token])
        },
      }
    }

    if (status === "duplicate") {
      throw new SwiftQueueError("duplicate", "Request yang sama sedang diproses. Swift membatalkan duplikasi agar saldo tidak terpakai dua kali.", 409)
    }

    if (status === "overloaded") {
      throw new SwiftQueueError("overloaded", USER_FRIENDLY_QUEUE_OVERLOAD_ERROR, 429)
    }

    await new Promise((resolve) => setTimeout(resolve, 250))
  }

  await evalQueueScript(releaseScript, keys, [token])
  throw new SwiftQueueError("timeout", USER_FRIENDLY_QUEUE_OVERLOAD_ERROR, 429)
}

function acquireMemorySlot(
  input: QueueLeaseInput,
  concurrency: number,
  startedAt: number,
  duplicateKey: string
): QueueLease {
  if (memoryDuplicates.has(duplicateKey)) {
    throw new SwiftQueueError("duplicate", "Request yang sama sedang diproses. Swift membatalkan duplikasi agar saldo tidak terpakai dua kali.", 409)
  }

  const active = memoryActive.get(input.tierKey) || 0
  if (active >= concurrency) {
    throw new SwiftQueueError("overloaded", USER_FRIENDLY_QUEUE_OVERLOAD_ERROR, 429)
  }

  memoryActive.set(input.tierKey, active + 1)
  memoryDuplicates.add(duplicateKey)

  return {
    queueWaitMs: Date.now() - startedAt,
    release: async () => {
      const next = Math.max(0, (memoryActive.get(input.tierKey) || 1) - 1)
      if (next === 0) {
        memoryActive.delete(input.tierKey)
      } else {
        memoryActive.set(input.tierKey, next)
      }
      memoryDuplicates.delete(duplicateKey)
    },
  }
}

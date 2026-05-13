// Centralized Redis connection manager for standalone workers
// Prevents connection storms through global singleton pattern
import IORedis from "ioredis"
import { env } from "@/lib/env"

const globalForRedis = globalThis as unknown as {
  __swiftRedisClient?: IORedis
}

let redisClient: IORedis | null = null

export function getRedisConnection(): IORedis {
  // Return existing connection if available and healthy
  if (globalForRedis.__swiftRedisClient?.status === "ready") {
    return globalForRedis.__swiftRedisClient
  }

  const redisUrl = env.redisUrl

  if (!env.hasNativeRedisConfig) {
    throw new Error("Native REDIS_URL using redis:// or rediss:// is required for worker processes")
  }

  redisClient = new IORedis(redisUrl, {
    maxRetriesPerRequest: null,
    enableOfflineQueue: false,
    enableReadyCheck: false,
    ...(redisUrl.startsWith("rediss://") ? { tls: {} } : {}),
    retryStrategy: (times) => {
      const delay = Math.min(times * 50, 2000)
      console.log(`[Redis] Retrying connection in ${delay}ms (attempt ${times})`)
      return delay
    },
    connectTimeout: 5000,
    lazyConnect: true,
  })

  redisClient.on("error", (err) => {
    console.error("[Redis] Connection error:", err.message)
  })

  redisClient.on("connect", () => {
    console.log("[Redis] Connected successfully")
  })

  redisClient.on("reconnecting", () => {
    console.log("[Redis] Reconnecting...")
  })

  globalForRedis.__swiftRedisClient = redisClient
  return redisClient
}

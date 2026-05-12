// Centralized Queue Factory for Next.js API routes
// This module should be imported by API routes, NOT by standalone workers
// Standalone workers use workers/queue.ts

import { Queue, QueueEvents, type JobsOptions } from "bullmq"
import IORedis from "ioredis"
import { env } from "@/lib/env"

// Type definitions
export type GenerationQueueJobName = "generation.execute" | "generation.plan"

export type GenerationQueuePayload = {
  jobId: string
  userId: string
  projectId: string
  prompt: string
  model: string
  provider: string
  collaborationMode?: string
  promptLanguage?: "id" | "en"
  idempotencyKey?: string
  previewContext?: unknown
  attachments?: unknown[]
}

// Queue names (must match workers/queue.ts)
const QUEUE_NAMES = {
  generation: "swift:generation:v2",
  repair: "swift:repair:v1",
  sandbox: "swift:sandbox:v1",
} as const

// Default job options
const DEFAULT_JOB_OPTIONS: JobsOptions = {
  attempts: 3,
  backoff: {
    type: "exponential",
    delay: 2000,
  },
  removeOnComplete: 100,
  removeOnFail: 200,
}

// Redis connection (for API routes only - workers have their own)
let redisConnection: IORedis | null = null
let generationQueue: Queue<GenerationQueuePayload, unknown, GenerationQueueJobName> | null = null
let generationQueueEvents: QueueEvents | null = null
let redisAvailable = false

function getRedisConnection(): IORedis | null {
  if (!env.redisUrl && !env.upstashRedisRestUrl) {
    console.warn("[Queue] Redis URL not configured")
    return null
  }

  if (redisConnection) {
    return redisConnection
  }

  // Build connection from available config
  let redisUrl = env.redisUrl

  if (!redisUrl && env.upstashRedisRestUrl && env.upstashRedisRestToken) {
    const match = env.upstashRedisRestUrl.match(/https?:\/\/([^\.]+)\.upstash\.io/)
    if (match) {
      const hostname = match[1]
      redisUrl = `redis://default:${env.upstashRedisRestToken}@${hostname}.upstash.io:31329`
    }
  }

  if (!redisUrl) {
    return null
  }

  try {
    redisConnection = new IORedis(redisUrl, {
      maxRetriesPerRequest: null,
      enableReadyCheck: false,
      retryStrategy: (times) => Math.min(times * 50, 2000),
      connectTimeout: 5000,
      lazyConnect: true,
    })

    redisConnection.on("connect", () => {
      console.log("[Queue] Redis connected")
      redisAvailable = true
    })

    redisConnection.on("error", (err) => {
      console.error("[Queue] Redis error:", err.message)
      redisAvailable = false
    })
  } catch (error) {
    console.warn("[Queue] Failed to initialize Redis:", error)
    return null
  }

  return redisConnection
}

export function getGenerationQueue() {
  if (!generationQueue) {
    const connection = getRedisConnection()

    if (connection && redisAvailable) {
      generationQueue = new Queue<GenerationQueuePayload, unknown, GenerationQueueJobName>(
        QUEUE_NAMES.generation,
        {
          connection,
          defaultJobOptions: DEFAULT_JOB_OPTIONS,
        }
      )
    }
  }

  return generationQueue
}

export function getGenerationQueueEvents() {
  if (!generationQueueEvents && redisAvailable) {
    const connection = getRedisConnection()
    if (connection) {
      generationQueueEvents = new QueueEvents(QUEUE_NAMES.generation, { connection })
    }
  }

  return generationQueueEvents
}

export function isGenerationQueueEnabled() {
  return env.hasRedisConfig && env.nodeEnv !== "development" ? true : true
}

export async function enqueueGenerationTask(
  payload: GenerationQueuePayload,
  options?: JobsOptions
) {
  try {
    const queue = getGenerationQueue()

    if (!queue) {
      console.log("[Queue] No Redis queue available, returning mock job")
      return {
        id: payload.jobId,
        name: "generation.execute",
        data: payload,
      } as any
    }

    return queue.add("generation.execute", payload, {
      ...DEFAULT_JOB_OPTIONS,
      ...options,
      jobId: payload.idempotencyKey || payload.jobId,
    })
  } catch (error) {
    console.error("[Queue] Failed to enqueue task:", error)
    return {
      id: payload.jobId,
      name: "generation.execute",
      data: payload,
    } as any
  }
}

// Export types for use in API routes
export { QUEUE_NAMES }
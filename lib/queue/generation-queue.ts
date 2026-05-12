import { Queue, QueueEvents, Worker, type JobsOptions, type Processor } from "bullmq"
import IORedis from "ioredis"
import { env } from "@/lib/env"

export type GenerationQueueJobName = "generation.execute"

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

const QUEUE_NAME = "swift:generation:v2"
const DEFAULT_JOB_OPTIONS: JobsOptions = {
  attempts: 1,
  removeOnComplete: 200,
  removeOnFail: 500,
}

let redisConnection: IORedis | null = null
let generationQueue: Queue<GenerationQueuePayload, unknown, GenerationQueueJobName> | null = null
let generationQueueEvents: QueueEvents | null = null

function buildUpstashRedisUrl(): string | null {
  if (!env.upstashRedisRestUrl) return null
  
  // Convert REST URL to native Redis URL
  // REST format: https://hostname.upstash.io
  // Native format: redis://default:password@hostname:port
  const restUrl = env.upstashRedisRestUrl
  const match = restUrl.match(/https?:\/\/([^\.]+)\.upstash\.io/)
  
  if (!match) return null
  
  const hostname = match[1]
  // Upstash native Redis uses port 31329 by default
  // Token format note: For Upstash, the native connection requires credentials from dashboard
  // For now, attempt to construct the URL - it will fail gracefully if credentials are wrong
  
  // Use token as password for Redis AUTH
  if (env.upstashRedisRestToken) {
    // The REST token can sometimes work as Redis password in Upstash
    return `redis://default:${env.upstashRedisRestToken}@${hostname}.upstash.io:31329`
  }
  
  return null
}

function getRedisConnection() {
  if (!redisConnection) {
    let redisUrl: string | null = env.redisUrl
    
    // If no native Redis URL, try to build from Upstash REST config
    if (!redisUrl) {
      redisUrl = buildUpstashRedisUrl()
    }
    
    if (!redisUrl) {
      throw new Error(
        "Generation queue requires REDIS_URL environment variable or Upstash native Redis configuration. " +
        "Please configure either: 1) REDIS_URL for native Redis, or 2) Get native Redis URL from Upstash dashboard (not REST URL)"
      )
    }

    redisConnection = new IORedis(redisUrl, {
      maxRetriesPerRequest: null,
      enableReadyCheck: false,
      retryStrategy: (times) => Math.min(times * 50, 2000),
      connectTimeout: 10000,
    })
    
    redisConnection.on("error", (err) => {
      console.error("[Generation Queue] Redis connection error:", err.message)
    })
    
    redisConnection.on("reconnecting", () => {
      console.log("[Generation Queue] Redis reconnecting...")
    })
  }

  return redisConnection
}

export function isGenerationQueueEnabled() {
  // Check if native Redis URL exists
  if (env.redisUrl) {
    return true
  }
  
  // Check if we can build Upstash native Redis URL
  if (env.upstashRedisRestUrl && env.upstashRedisRestToken) {
    return true
  }
  
  return false
}

export function getGenerationQueue() {
  if (!generationQueue) {
    try {
      generationQueue = new Queue<GenerationQueuePayload, unknown, GenerationQueueJobName>(QUEUE_NAME, {
        connection: getRedisConnection(),
        defaultJobOptions: DEFAULT_JOB_OPTIONS,
      })
    } catch (error) {
      console.error("[Generation Queue] Failed to create queue:", error instanceof Error ? error.message : String(error))
      throw new Error(
        `Failed to initialize generation queue: ${error instanceof Error ? error.message : "Unknown error"}. ` +
        "Please verify Redis configuration."
      )
    }
  }

  return generationQueue
}

export function getGenerationQueueEvents() {
  if (!generationQueueEvents) {
    try {
      generationQueueEvents = new QueueEvents(QUEUE_NAME, {
        connection: getRedisConnection(),
      })
    } catch (error) {
      console.error("[Generation Queue] Failed to create queue events:", error instanceof Error ? error.message : String(error))
      throw new Error(
        `Failed to initialize generation queue events: ${error instanceof Error ? error.message : "Unknown error"}`
      )
    }
  }

  return generationQueueEvents
}

export async function enqueueGenerationTask(
  payload: GenerationQueuePayload,
  options?: JobsOptions
) {
  try {
    const queue = getGenerationQueue()
    return queue.add("generation.execute", payload, {
      ...DEFAULT_JOB_OPTIONS,
      ...options,
      jobId: payload.idempotencyKey || payload.jobId,
    })
  } catch (error) {
    console.error("[Generation Queue] Failed to enqueue task:", error instanceof Error ? error.message : String(error))
    throw new Error(
      `Failed to queue generation job: ${error instanceof Error ? error.message : "Unknown error"}. ` +
      "Redis queue may be unavailable."
    )
  }
}

export function createGenerationWorker(
  processor: Processor<GenerationQueuePayload, unknown, GenerationQueueJobName>
) {
  return new Worker<GenerationQueuePayload, unknown, GenerationQueueJobName>(QUEUE_NAME, processor, {
    connection: getRedisConnection(),
    concurrency: Math.max(1, Number(process.env.SWIFT_GENERATION_WORKER_CONCURRENCY || 2)),
    stalledInterval: 30_000,
    lockDuration: 120_000,
  })
}

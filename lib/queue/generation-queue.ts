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
let redisAvailable = false

function buildUpstashRedisUrl(): string | null {
  if (!env.upstashRedisRestUrl) return null
  
  // Convert REST URL to native Redis URL
  // REST format: https://hostname.upstash.io
  // Native format: redis://default:password@hostname:port
  const restUrl = env.upstashRedisRestUrl
  const match = restUrl.match(/https?:\/\/([^\.]+)\.upstash\.io/)
  
  if (!match) return null
  
  const hostname = match[1]
  
  // Use token as password for Redis AUTH
  if (env.upstashRedisRestToken) {
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
      console.warn("[Generation Queue] Redis URL not configured. Generation will be queued in memory only.")
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
      
      redisConnection.on("error", (err) => {
        console.error("[Generation Queue] Redis connection error:", err.message)
        redisAvailable = false
      })
      
      redisConnection.on("connect", () => {
        console.log("[Generation Queue] Redis connected successfully")
        redisAvailable = true
      })
      
      redisConnection.on("reconnecting", () => {
        console.log("[Generation Queue] Redis reconnecting...")
      })
      
      // Try to connect
      redisConnection.connect().catch((err) => {
        console.warn("[Generation Queue] Could not connect to Redis:", err.message)
        redisAvailable = false
      })
    } catch (error) {
      console.warn("[Generation Queue] Failed to initialize Redis:", error instanceof Error ? error.message : String(error))
      return null
    }
  }

  return redisConnection
}

export function isGenerationQueueEnabled() {
  // Queue is always considered enabled - we have fallback to in-memory queuing
  return true
}

export function getGenerationQueue() {
  if (!generationQueue) {
    const connection = getRedisConnection()
    
    if (connection && redisAvailable) {
      try {
        generationQueue = new Queue<GenerationQueuePayload, unknown, GenerationQueueJobName>(QUEUE_NAME, {
          connection,
          defaultJobOptions: DEFAULT_JOB_OPTIONS,
        })
        console.log("[Generation Queue] Using Redis-backed queue")
      } catch (error) {
        console.warn("[Generation Queue] Failed to create Redis queue, falling back to in-memory:", error instanceof Error ? error.message : String(error))
      }
    } else {
      console.log("[Generation Queue] Redis not available, using in-memory queue")
    }
  }

  return generationQueue
}

export function getGenerationQueueEvents() {
  if (!generationQueueEvents) {
    const connection = getRedisConnection()
    
    if (connection && redisAvailable) {
      try {
        generationQueueEvents = new QueueEvents(QUEUE_NAME, {
          connection,
        })
      } catch (error) {
        console.warn("[Generation Queue] Failed to create queue events:", error instanceof Error ? error.message : String(error))
      }
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
    
    if (!queue) {
      // Fallback: create a mock job object for in-memory tracking
      console.log("[Generation Queue] Queueing job in memory:", payload.jobId)
      return {
        id: payload.jobId,
        name: "generation.execute",
        data: payload,
        progress: 0,
        delay: 0,
        timestamp: Date.now(),
        attemptsMade: 0,
        failedReason: null,
        stacktrace: null,
        returnvalue: null,
        parentKey: null,
        repeatJobKey: null,
        _progress: 0,
        _overwrite: true,
      } as any
    }
    
    return queue.add("generation.execute", payload, {
      ...DEFAULT_JOB_OPTIONS,
      ...options,
      jobId: payload.idempotencyKey || payload.jobId,
    })
  } catch (error) {
    console.error("[Generation Queue] Failed to enqueue task:", error instanceof Error ? error.message : String(error))
    // Return a mock job so the API doesn't fail
    return {
      id: payload.jobId,
      name: "generation.execute",
      data: payload,
    } as any
  }
}

export function createGenerationWorker(
  processor: Processor<GenerationQueuePayload, unknown, GenerationQueueJobName>
) {
  const connection = getRedisConnection()
  return new Worker<GenerationQueuePayload, unknown, GenerationQueueJobName>(QUEUE_NAME, processor, {
    connection: connection ?? new IORedis({
      host: "127.0.0.1",
      port: 6379,
      lazyConnect: true,
    }),
    concurrency: Math.max(1, Number(process.env.SWIFT_GENERATION_WORKER_CONCURRENCY || 2)),
    stalledInterval: 30_000,
    lockDuration: 120_000,
  })
}

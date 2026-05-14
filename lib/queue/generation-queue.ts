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
  usageLogId: string
  reservedCost: number
  modelConfigId: string
  collaborationMode?: string
  promptLanguage?: "id" | "en"
  idempotencyKey?: string
  requestHash?: string
  previewContext?: unknown
  attachments?: unknown[]
}

const QUEUE_NAME = "swift-generation-v2"
const GENERATION_WORKER_HEARTBEAT_KEY = "swift:generation:worker:heartbeat"

// RELIABILITY: lockDuration MUST exceed the longest legitimate generation.
// Previous value (120_000) was shorter than executeGenerationJob's worst case
// (~5 min), causing BullMQ to mark in-flight jobs stalled, requeue them, and
// produce DUPLICATE billing + duplicate file writes. Set to 7 min with a
// stalledInterval that probes well within the lock window.
const LOCK_DURATION_MS = 7 * 60_000
const STALLED_INTERVAL_MS = 30_000
const MAX_STALLED_COUNT = 1 // give up after 1 stall — don't infinite-retry

const DEFAULT_JOB_OPTIONS: JobsOptions = {
  // RELIABILITY: 1 attempt = no retries on transient failures (network blips,
  // Redis flap). Bump to 2 with exponential backoff so a single transient
  // failure doesn't lose a paid job. Idempotency on jobId prevents duplicates.
  attempts: 2,
  backoff: { type: "exponential", delay: 5_000 },
  removeOnComplete: { count: 200, age: 24 * 3600 },
  removeOnFail: { count: 500, age: 7 * 24 * 3600 },
}

let redisConnection: IORedis | null = null
let generationQueue: Queue<GenerationQueuePayload, unknown, GenerationQueueJobName> | null = null
let generationQueueEvents: QueueEvents | null = null

function getRedisConnection() {
  if (!redisConnection) {
    const redisUrl = env.redisUrl

    if (!env.hasNativeRedisConfig) {
      console.warn("[Generation Queue] Native REDIS_URL is not configured. BullMQ requires redis:// or rediss://; REST URLs are not supported.")
      return null
    }

    try {
      redisConnection = new IORedis(redisUrl, {
        maxRetriesPerRequest: null,
        enableReadyCheck: false,
        ...(redisUrl.startsWith("rediss://") ? { tls: {} } : {}),
        retryStrategy: (times) => Math.min(times * 50, 2000),
        connectTimeout: 5000,
        lazyConnect: true,
      })
      
      redisConnection.on("error", (err) => {
        console.error("[Generation Queue] Redis connection error:", err.message)
      })
      
      redisConnection.on("connect", () => {
        console.log("[Generation Queue] Redis connected successfully")
      })
      
      redisConnection.on("reconnecting", () => {
        console.log("[Generation Queue] Redis reconnecting...")
      })
      
      // Connection will be established on first command (lazyConnect: true).
      // Do NOT call .connect() eagerly — it can fire during module resolution at build time.
    } catch (error) {
      console.warn("[Generation Queue] Failed to initialize Redis:", error instanceof Error ? error.message : String(error))
      return null
    }
  }

  return redisConnection
}

export function isGenerationQueueEnabled() {
  return Boolean(getRedisConnection())
}

export function getGenerationQueue() {
  if (!generationQueue) {
    const connection = getRedisConnection()
    
    if (connection) {
      try {
        generationQueue = new Queue<GenerationQueuePayload, unknown, GenerationQueueJobName>(QUEUE_NAME, {
          connection,
          defaultJobOptions: DEFAULT_JOB_OPTIONS,
        })
        console.log("[Generation Queue] Using Redis-backed queue")
      } catch (error) {
        console.warn("[Generation Queue] Failed to create Redis queue:", error instanceof Error ? error.message : String(error))
      }
    } else {
      console.log("[Generation Queue] Redis not available")
    }
  }

  return generationQueue
}

export function getGenerationQueueEvents() {
  if (!generationQueueEvents) {
    const connection = getRedisConnection()
    
    if (connection) {
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
      console.warn("[Generation Queue] Redis queue unavailable for:", payload.jobId)
      return null
    }

    const dedupeJobId = options?.jobId || (payload.idempotencyKey
      ? ["generation", payload.userId, payload.projectId, payload.idempotencyKey].join("__")
      : payload.jobId)
    
    return queue.add("generation.execute", payload, {
      ...DEFAULT_JOB_OPTIONS,
      ...options,
      jobId: dedupeJobId,
    })
  } catch (error) {
    console.error("[Generation Queue] Failed to enqueue task:", error instanceof Error ? error.message : String(error))
    return null
  }
}

export async function recordGenerationWorkerHeartbeat(workerId: string) {
  const connection = getRedisConnection()
  if (!connection) return null

  const payload = JSON.stringify({
    workerId,
    pid: process.pid,
    at: new Date().toISOString(),
  })

  await connection.set(GENERATION_WORKER_HEARTBEAT_KEY, payload, "PX", 120_000)
  return payload
}

export async function getGenerationQueueHealth() {
  const queue = getGenerationQueue()
  if (!queue) {
    return {
      enabled: false,
      status: "disabled",
      counts: null,
      workerHeartbeat: null,
    }
  }

  const counts = await queue.getJobCounts("waiting", "active", "delayed", "failed", "completed", "paused")
  const connection = getRedisConnection()
  const rawHeartbeat = connection ? await connection.get(GENERATION_WORKER_HEARTBEAT_KEY).catch(() => null) : null
  const workerHeartbeat = rawHeartbeat
    ? (() => {
        try {
          return JSON.parse(rawHeartbeat) as { workerId: string; pid: number; at: string }
        } catch {
          return null
        }
      })()
    : null
  const heartbeatAgeMs = workerHeartbeat ? Date.now() - Date.parse(workerHeartbeat.at) : null

  return {
    enabled: true,
    status: heartbeatAgeMs === null ? "degraded" : heartbeatAgeMs > 90_000 ? "stale" : "healthy",
    counts,
    workerHeartbeat: workerHeartbeat
      ? {
          ...workerHeartbeat,
          ageMs: heartbeatAgeMs,
        }
      : null,
  }
}

export function createGenerationWorker(
  processor: Processor<GenerationQueuePayload, unknown, GenerationQueueJobName>
) {
  const connection = getRedisConnection()
  if (!connection) {
    throw new Error("Generation worker requires native REDIS_URL using redis:// or rediss://")
  }

  return new Worker<GenerationQueuePayload, unknown, GenerationQueueJobName>(QUEUE_NAME, processor, {
    connection,
    concurrency: Math.max(1, Number(process.env.SWIFT_GENERATION_WORKER_CONCURRENCY || 2)),
    stalledInterval: STALLED_INTERVAL_MS,
    lockDuration: LOCK_DURATION_MS,
    maxStalledCount: MAX_STALLED_COUNT,
    // Drain in flight jobs gracefully on SIGTERM rather than letting BullMQ
    // forcefully release locks.
    drainDelay: 5,
  })
}

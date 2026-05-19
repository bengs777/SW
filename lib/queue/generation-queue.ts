import { Queue, QueueEvents, Worker, type JobsOptions, type Processor } from "bullmq"
import IORedis from "ioredis"
import { env } from "@/lib/env"
import { log } from "@/lib/logging"

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
  traceId?: string
  previewContext?: unknown
  attachments?: unknown[]
}

const QUEUE_NAME = "swift-generation-v2"
const DEAD_LETTER_QUEUE_NAME = "swift-generation-dead-letter-v1"
const GENERATION_WORKER_HEARTBEAT_KEY = "swift:generation:worker:heartbeat"
const DEFAULT_JOB_OPTIONS: JobsOptions = {
  attempts: 3,
  backoff: {
    type: "exponential",
    delay: 2000,
  },
  removeOnComplete: 200,
  removeOnFail: 500,
}

export type GenerationDeadLetterPayload = {
  failedAt: string
  queueName: string
  queueJobId: string | number | null
  jobId: string
  userId: string
  projectId: string
  promptHash?: string | null
  requestHash?: string | null
  idempotencyKey?: string | null
  traceId?: string | null
  error: string
  stack?: string
  attemptsMade?: number
  payload: GenerationQueuePayload
}

let redisConnection: IORedis | null = null
let generationQueue: Queue<GenerationQueuePayload, unknown, GenerationQueueJobName> | null = null
let generationDeadLetterQueue: Queue<GenerationDeadLetterPayload, unknown, "generation.dead_letter"> | null = null
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
        log("error", "redis_generation_queue_error", {
          error: err.message,
          status: redisConnection?.status,
        })
      })
      
      redisConnection.on("connect", () => {
        log("info", "redis_generation_queue_connected", {
          status: redisConnection?.status,
        })
      })
      
      redisConnection.on("ready", () => {
        log("info", "redis_generation_queue_ready", {
          status: redisConnection?.status,
        })
      })

      redisConnection.on("reconnecting", (delayMs: number) => {
        log("warn", "redis_generation_queue_reconnecting", {
          delayMs,
          status: redisConnection?.status,
        })
      })

      redisConnection.on("end", () => {
        log("warn", "redis_generation_queue_connection_ended")
      })
      
      // Try to connect
      redisConnection.connect().catch((err) => {
        log("warn", "redis_generation_queue_connect_failed", {
          error: err.message,
        })
      })
    } catch (error) {
      log("warn", "redis_generation_queue_init_failed", {
        error: error instanceof Error ? error.message : String(error),
      })
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
        log("info", "generation_queue_initialized", {
          queueName: QUEUE_NAME,
        })
      } catch (error) {
        log("warn", "generation_queue_init_failed", {
          queueName: QUEUE_NAME,
          error: error instanceof Error ? error.message : String(error),
        })
      }
    } else {
      log("warn", "generation_queue_redis_unavailable", {
        hasNativeRedisConfig: env.hasNativeRedisConfig,
      })
    }
  }

  return generationQueue
}

export function getGenerationDeadLetterQueue() {
  if (!generationDeadLetterQueue) {
    const connection = getRedisConnection()

    if (connection) {
      generationDeadLetterQueue = new Queue<GenerationDeadLetterPayload, unknown, "generation.dead_letter">(
        DEAD_LETTER_QUEUE_NAME,
        {
          connection,
          defaultJobOptions: {
            attempts: 1,
            removeOnComplete: 1_000,
            removeOnFail: 2_000,
          },
        }
      )
      log("info", "generation_dead_letter_queue_initialized", {
        queueName: DEAD_LETTER_QUEUE_NAME,
      })
    }
  }

  return generationDeadLetterQueue
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
      log("warn", "generation_queue_enqueue_unavailable", {
        jobId: payload.jobId,
        projectId: payload.projectId,
        userId: payload.userId,
      })
      return null
    }

    const dedupeJobId = options?.jobId || (payload.idempotencyKey
      ? ["generation", payload.userId, payload.projectId, payload.idempotencyKey].join("__")
      : payload.jobId)
    
    const queued = await queue.add("generation.execute", payload, {
      ...DEFAULT_JOB_OPTIONS,
      ...options,
      jobId: dedupeJobId,
    })
    log("info", "generation_queue_enqueued", {
      jobId: payload.jobId,
      queueJobId: queued.id,
      dedupeJobId,
      projectId: payload.projectId,
      userId: payload.userId,
    })
    return queued
  } catch (error) {
    log("error", "generation_queue_enqueue_failed", {
      jobId: payload.jobId,
      projectId: payload.projectId,
      userId: payload.userId,
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    })
    return null
  }
}

export async function moveGenerationJobToDeadLetter(input: {
  payload: GenerationQueuePayload
  queueJobId?: string | number | null
  error: unknown
  attemptsMade?: number
}) {
  const queue = getGenerationDeadLetterQueue()
  if (!queue) return null

  const errorMessage = input.error instanceof Error ? input.error.message : String(input.error)
  const deadLetterPayload: GenerationDeadLetterPayload = {
    failedAt: new Date().toISOString(),
    queueName: QUEUE_NAME,
    queueJobId: input.queueJobId ?? null,
    jobId: input.payload.jobId,
    userId: input.payload.userId,
    projectId: input.payload.projectId,
    requestHash: input.payload.requestHash || null,
    idempotencyKey: input.payload.idempotencyKey || null,
    traceId: input.payload.traceId || null,
    error: errorMessage,
    stack: input.error instanceof Error ? input.error.stack : undefined,
    attemptsMade: input.attemptsMade,
    payload: input.payload,
  }

  const dlqJob = await queue.add("generation.dead_letter", deadLetterPayload, {
    jobId: `dlq:${input.payload.jobId}:${Date.now()}`,
  })
  log("error", "generation_dead_letter_written", {
    jobId: input.payload.jobId,
    queueJobId: input.queueJobId ?? null,
    deadLetterJobId: dlqJob.id,
    error: errorMessage,
  })
  return dlqJob
}

export async function getGenerationDeadLetterPayload(deadLetterJobId: string) {
  const deadLetterQueue = getGenerationDeadLetterQueue()
  if (!deadLetterQueue) {
    throw new Error("Generation dead-letter queue is unavailable.")
  }

  const deadLetterJob = await deadLetterQueue.getJob(deadLetterJobId)
  if (!deadLetterJob) {
    throw new Error("Dead-letter job not found.")
  }

  return deadLetterJob.data.payload
}

export async function replayGenerationDeadLetterJob(input: {
  deadLetterJobId: string
  queueJobId?: string
  removeDeadLetter?: boolean
}) {
  const deadLetterQueue = getGenerationDeadLetterQueue()
  const queue = getGenerationQueue()
  if (!deadLetterQueue || !queue) {
    throw new Error("Generation queue or dead-letter queue is unavailable.")
  }

  const deadLetterJob = await deadLetterQueue.getJob(input.deadLetterJobId)
  if (!deadLetterJob) {
    throw new Error("Dead-letter job not found.")
  }

  const payload = deadLetterJob.data.payload
  const queueJobId = input.queueJobId || `replay:${payload.jobId}:${Date.now()}`
  const queued = await queue.add("generation.execute", payload, {
    ...DEFAULT_JOB_OPTIONS,
    jobId: queueJobId,
  })

  if (input.removeDeadLetter) {
    await deadLetterJob.remove()
  }

  log("warn", "generation_dead_letter_replayed", {
    deadLetterJobId: input.deadLetterJobId,
    jobId: payload.jobId,
    queueJobId: queued.id,
    projectId: payload.projectId,
    userId: payload.userId,
    traceId: payload.traceId,
    removeDeadLetter: Boolean(input.removeDeadLetter),
  })

  return {
    deadLetterJobId: input.deadLetterJobId,
    queueJobId: queued.id,
    payload,
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
  const connection = getRedisConnection()
  const redisStartedAt = Date.now()
  let redisPing: string | null = null
  let redisError: string | null = null
  if (connection) {
    redisPing = await connection.ping().catch((error) => {
      redisError = error instanceof Error ? error.message : String(error)
      return null
    })
  }
  const redisLatencyMs = Date.now() - redisStartedAt

  if (!queue) {
    return {
      enabled: false,
      status: "disabled",
      counts: null,
      deadLetter: null,
      workerHeartbeat: null,
      redis: {
        configured: env.hasNativeRedisConfig,
        status: connection?.status || "unavailable",
        ping: redisPing,
        error: redisError,
        latencyMs: redisLatencyMs,
      },
    }
  }

  const counts = await queue.getJobCounts("waiting", "active", "delayed", "failed", "completed", "paused")
  const rawHeartbeat = connection ? await connection.get(GENERATION_WORKER_HEARTBEAT_KEY).catch(() => null) : null
  const deadLetterQueue = getGenerationDeadLetterQueue()
  const deadLetterCounts = deadLetterQueue
    ? await deadLetterQueue.getJobCounts("waiting", "active", "delayed", "failed", "completed", "paused").catch(() => null)
    : null
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
    status:
      redisError
        ? "degraded"
        : heartbeatAgeMs === null
          ? "degraded"
          : heartbeatAgeMs > 90_000
            ? "stale"
            : "healthy",
    counts,
    deadLetter: {
      queueName: DEAD_LETTER_QUEUE_NAME,
      counts: deadLetterCounts,
    },
    workerHeartbeat: workerHeartbeat
      ? {
          ...workerHeartbeat,
          ageMs: heartbeatAgeMs,
        }
      : null,
    redis: {
      configured: env.hasNativeRedisConfig,
      status: connection?.status || "unavailable",
      ping: redisPing,
      error: redisError,
      latencyMs: redisLatencyMs,
    },
  }
}

export async function cleanupGenerationQueue(options: {
  completedGraceMs?: number
  failedGraceMs?: number
  limit?: number
} = {}) {
  const queue = getGenerationQueue()
  const deadLetterQueue = getGenerationDeadLetterQueue()
  if (!queue) {
    return { enabled: false, cleaned: null }
  }

  const completedGraceMs = options.completedGraceMs ?? 24 * 60 * 60 * 1000
  const failedGraceMs = options.failedGraceMs ?? 7 * 24 * 60 * 60 * 1000
  const limit = options.limit ?? 500
  const [completed, failed, dlqCompleted] = await Promise.all([
    queue.clean(completedGraceMs, limit, "completed"),
    queue.clean(failedGraceMs, limit, "failed"),
    deadLetterQueue ? deadLetterQueue.clean(failedGraceMs, limit, "completed") : Promise.resolve([]),
  ])

  return {
    enabled: true,
    cleaned: {
      completed: completed.length,
      failed: failed.length,
      deadLetterCompleted: dlqCompleted.length,
    },
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
    stalledInterval: 30_000,
    lockDuration: 120_000,
  })
}

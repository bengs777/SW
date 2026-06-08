import { Queue, QueueEvents, Worker, type JobsOptions, type Processor } from "bullmq"
import IORedis from "ioredis"
import { env } from "@/lib/env"
import { log } from "@/lib/logging"
import { warnIfSlow } from "@/lib/observability/performance-monitor"
import { recordRedisLatency, recordWorkerUtilization } from "@/lib/observability/runtime-metrics"
import { OrchestrationRuntimeService } from "@/lib/services/orchestration-runtime.service"
import type { CollaborationMode } from "@/lib/ai/collaboration-mode"

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
  collaborationMode?: CollaborationMode
  promptLanguage?: "id" | "en"
  idempotencyKey?: string
  requestHash?: string
  correlationId?: string
  traceId?: string
  executionChainId?: string
  previewContext?: unknown
  attachments?: unknown[]
  priority?: GenerationQueuePriority
}

export type GenerationQueuePriority = "normal" | "retry" | "recovery" | "admin"

const QUEUE_NAME = "swift-generation-v2"
const DEAD_LETTER_QUEUE_NAME = "swift-generation-dead-letter-v1"
const GENERATION_WORKER_HEARTBEAT_KEY = "swift:generation:worker:heartbeat"
const QUEUE_SATURATION_LIMITS = {
  maxBacklogDepth: Math.max(1, Number(process.env.SWIFT_QUEUE_MAX_BACKLOG_DEPTH || 30)),
  maxBacklogAgeMs: Math.max(5_000, Number(process.env.SWIFT_QUEUE_MAX_BACKLOG_AGE_MS || 120_000)),
  maxAverageWaitMs: Math.max(5_000, Number(process.env.SWIFT_QUEUE_MAX_AVERAGE_WAIT_MS || 60_000)),
  maxWorkerUtilizationPct: Math.max(1, Math.min(100, Number(process.env.SWIFT_QUEUE_MAX_WORKER_UTILIZATION_PCT || 90))),
  heavySaturationPct: Math.max(100, Number(process.env.SWIFT_QUEUE_HEAVY_SATURATION_PCT || 150)),
  waitSampleSize: Math.max(1, Math.min(200, Number(process.env.SWIFT_QUEUE_WAIT_SAMPLE_SIZE || 50))),
}
const DEFAULT_JOB_OPTIONS: JobsOptions = {
  attempts: 3,
  backoff: {
    type: "exponential",
    delay: 2000,
  },
  removeOnComplete: 200,
  removeOnFail: 500,
}
export const GENERATION_QUEUE_PRIORITY: Record<GenerationQueuePriority, number> = {
  admin: 1,
  recovery: 2,
  retry: 3,
  normal: 4,
}

export function resolveGenerationQueuePriority(payload: Pick<GenerationQueuePayload, "priority">, options?: JobsOptions) {
  if (typeof options?.priority === "number") return options.priority
  return GENERATION_QUEUE_PRIORITY[payload.priority || "normal"]
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

function pct(value: number, limit: number) {
  if (!Number.isFinite(value) || !Number.isFinite(limit) || limit <= 0) return 0
  return Math.round((value / limit) * 1000) / 10
}

async function getQueueSaturation(input: {
  queue: Queue<GenerationQueuePayload, unknown, GenerationQueueJobName>
  counts: Record<string, number>
  workerConcurrency: number
}) {
  const waiting = Number(input.counts.waiting || 0)
  const delayed = Number(input.counts.delayed || 0)
  const active = Number(input.counts.active || 0)
  const backlogDepth = waiting + delayed
  const workerUtilizationPct = pct(active, input.workerConcurrency)
  const sampleSize = QUEUE_SATURATION_LIMITS.waitSampleSize
  const sampledJobs = backlogDepth > 0
    ? await input.queue.getJobs(["waiting", "delayed"], 0, sampleSize - 1, true).catch(() => [])
    : []
  const now = Date.now()
  const waitDurations = sampledJobs
    .map((job) => Math.max(0, now - Number(job.timestamp || now)))
    .filter((duration) => Number.isFinite(duration))
  const backlogAgeMs = waitDurations.length > 0 ? Math.max(...waitDurations) : 0
  const averageWaitDurationMs = waitDurations.length > 0
    ? Math.round(waitDurations.reduce((sum, duration) => sum + duration, 0) / waitDurations.length)
    : 0
  const pressure = {
    backlogDepthPct: pct(backlogDepth, QUEUE_SATURATION_LIMITS.maxBacklogDepth),
    backlogAgePct: pct(backlogAgeMs, QUEUE_SATURATION_LIMITS.maxBacklogAgeMs),
    averageWaitPct: pct(averageWaitDurationMs, QUEUE_SATURATION_LIMITS.maxAverageWaitMs),
    workerUtilizationPct,
  }
  const saturationPct = Math.max(
    pressure.backlogDepthPct,
    pressure.backlogAgePct,
    pressure.averageWaitPct,
    pressure.workerUtilizationPct
  )
  const reasons = [
    backlogDepth > QUEUE_SATURATION_LIMITS.maxBacklogDepth ? "backlog_depth" : "",
    backlogAgeMs > QUEUE_SATURATION_LIMITS.maxBacklogAgeMs ? "backlog_age" : "",
    averageWaitDurationMs > QUEUE_SATURATION_LIMITS.maxAverageWaitMs ? "average_wait" : "",
    workerUtilizationPct >= QUEUE_SATURATION_LIMITS.maxWorkerUtilizationPct ? "worker_utilization" : "",
  ].filter(Boolean)

  return {
    saturated: reasons.length > 0,
    heavy: saturationPct >= QUEUE_SATURATION_LIMITS.heavySaturationPct || reasons.length >= 2,
    saturationPct,
    reasons,
    backlogDepth,
    backlogAgeMs,
    averageWaitDurationMs,
    workerUtilizationPct,
    activeJobs: active,
    sampledJobs: waitDurations.length,
    limits: QUEUE_SATURATION_LIMITS,
    pressure,
  }
}

async function getRedisMemoryHealth(connection: IORedis | null) {
  if (!connection) {
    return {
      evictionPolicy: "unknown",
      targetEvictionPolicy: "noeviction",
      evictionPolicyOk: false,
      usedMemoryBytes: 0,
      maxMemoryBytes: 0,
      memoryPressurePct: 0,
      warning: "Redis connection unavailable.",
    }
  }

  let evictionPolicy = "unknown"
  let warning: string | null = null
  try {
    const config = await connection.config("GET", "maxmemory-policy") as string[]
    evictionPolicy = config?.[1] || "unknown"
    if (evictionPolicy !== "noeviction" && process.env.SWIFT_REDIS_AUTO_SET_NOEVICTION === "true") {
      await connection.config("SET", "maxmemory-policy", "noeviction")
      evictionPolicy = "noeviction"
    }
  } catch (error) {
    warning = error instanceof Error ? error.message : String(error)
  }

  let usedMemoryBytes = 0
  let maxMemoryBytes = 0
  try {
    const info = await connection.info("memory")
    for (const line of info.split(/\r?\n/)) {
      const [key, value] = line.split(":")
      if (key === "used_memory") usedMemoryBytes = Number(value || 0)
      if (key === "maxmemory") maxMemoryBytes = Number(value || 0)
      if (key === "maxmemory_policy" && evictionPolicy === "unknown") evictionPolicy = String(value || "unknown").trim()
    }
  } catch (error) {
    warning = warning || (error instanceof Error ? error.message : String(error))
  }

  const memoryPressurePct = maxMemoryBytes > 0 ? Math.round((usedMemoryBytes / maxMemoryBytes) * 1000) / 10 : 0
  return {
    evictionPolicy,
    targetEvictionPolicy: "noeviction",
    evictionPolicyOk: evictionPolicy === "noeviction",
    usedMemoryBytes,
    maxMemoryBytes,
    memoryPressurePct,
    warning,
  }
}

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
  const startedAt = Date.now()
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
      priority: resolveGenerationQueuePriority(payload, options),
    })
    const latencyMs = Date.now() - startedAt
    recordRedisLatency(latencyMs, { operation: "enqueueGenerationTask", jobId: payload.jobId })
    warnIfSlow("redis", latencyMs, { operation: "enqueueGenerationTask", jobId: payload.jobId })
    log("info", "generation_queue_enqueued", {
      jobId: payload.jobId,
      queueJobId: queued.id,
      dedupeJobId,
      projectId: payload.projectId,
      userId: payload.userId,
      correlationId: payload.correlationId,
      traceId: payload.traceId,
      executionChainId: payload.executionChainId,
      latencyMs,
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

export async function recordGenerationWorkerHeartbeat(
  workerId: string,
  details?: {
    alive?: boolean
    currentStage?: string | null
    lastSuccessfulTransition?: string | null
    activeJobIds?: string[]
    idleTimeoutMs?: number | null
    stalledGenerationDetected?: boolean
  }
) {
  const connection = getRedisConnection()
  if (!connection) return null
  const startedAt = Date.now()

  const payload = JSON.stringify({
    workerId,
    pid: process.pid,
    alive: details?.alive ?? true,
    currentStage: details?.currentStage || "idle",
    lastSuccessfulTransition: details?.lastSuccessfulTransition || null,
    activeJobIds: details?.activeJobIds || [],
    idleTimeoutMs: details?.idleTimeoutMs ?? null,
    stalledGenerationDetected: Boolean(details?.stalledGenerationDetected),
    at: new Date().toISOString(),
  })

  await connection.set(GENERATION_WORKER_HEARTBEAT_KEY, payload, "PX", 120_000)
  await OrchestrationRuntimeService.recordWorkerHeartbeat({
    workerId,
    currentJobId: details?.activeJobIds?.[0] || null,
    currentStage: details?.currentStage || "idle",
    lastSuccessfulTransition: details?.lastSuccessfulTransition || null,
    leaseOwner: details?.activeJobIds?.[0] ? workerId : null,
    runtimeInfo: {
      pid: process.pid,
      activeJobIds: details?.activeJobIds || [],
      idleTimeoutMs: details?.idleTimeoutMs ?? null,
      stalledGenerationDetected: Boolean(details?.stalledGenerationDetected),
    },
    metadata: {
      source: "bullmq_worker_heartbeat",
    },
  }).catch((error) => {
    log("warn", "worker_heartbeat_persist_failed", {
      workerId,
      error: error instanceof Error ? error.message : String(error),
    })
  })
  const latencyMs = Date.now() - startedAt
  recordRedisLatency(latencyMs, { operation: "workerHeartbeat", workerId })
  warnIfSlow("redis", latencyMs, { operation: "workerHeartbeat", workerId })
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
  recordRedisLatency(redisLatencyMs, { operation: "queueHealth" })
  warnIfSlow("redis", redisLatencyMs, { operation: "queueHealth" })

  if (!queue) {
    const memory = await getRedisMemoryHealth(connection)
    return {
      enabled: false,
      status: "disabled",
      counts: null,
      saturation: {
        saturated: false,
        heavy: false,
        saturationPct: 0,
        reasons: ["queue_disabled"],
        backlogDepth: 0,
        backlogAgeMs: 0,
        averageWaitDurationMs: 0,
        workerUtilizationPct: 0,
        activeJobs: 0,
        sampledJobs: 0,
        limits: QUEUE_SATURATION_LIMITS,
        pressure: {
          backlogDepthPct: 0,
          backlogAgePct: 0,
          averageWaitPct: 0,
          workerUtilizationPct: 0,
        },
      },
      deadLetter: null,
      workerHeartbeat: null,
      redis: {
        configured: env.hasNativeRedisConfig,
        status: connection?.status || "unavailable",
        ping: redisPing,
        error: redisError,
        latencyMs: redisLatencyMs,
        memory,
      },
    }
  }

  const counts = await queue.getJobCounts("waiting", "active", "delayed", "failed", "completed", "paused")
  const workerConcurrency = Math.max(1, Number(process.env.SWIFT_GENERATION_WORKER_CONCURRENCY || 2))
  recordWorkerUtilization(Number(counts.active || 0), workerConcurrency, {
    queueName: QUEUE_NAME,
  })
  const rawHeartbeat = connection ? await connection.get(GENERATION_WORKER_HEARTBEAT_KEY).catch(() => null) : null
  const deadLetterQueue = getGenerationDeadLetterQueue()
  const deadLetterCounts = deadLetterQueue
    ? await deadLetterQueue.getJobCounts("waiting", "active", "delayed", "failed", "completed", "paused").catch(() => null)
    : null
  const workerHeartbeat = rawHeartbeat
    ? (() => {
        try {
          return JSON.parse(rawHeartbeat) as {
            workerId: string
            pid: number
            at: string
            alive?: boolean
            currentStage?: string | null
            lastSuccessfulTransition?: string | null
            activeJobIds?: string[]
            idleTimeoutMs?: number | null
            stalledGenerationDetected?: boolean
          }
        } catch {
          return null
        }
      })()
    : null
  const heartbeatAgeMs = workerHeartbeat ? Date.now() - Date.parse(workerHeartbeat.at) : null
  const memory = await getRedisMemoryHealth(connection)
  const saturation = await getQueueSaturation({ queue, counts, workerConcurrency })
  const heartbeatActiveJobCount = workerHeartbeat?.activeJobIds?.length || 0
  const activeQueueJobs = Number(counts.active || 0)
  const heartbeatActiveJobDrift = heartbeatActiveJobCount > 0 && activeQueueJobs === 0
  const heartbeatStalled = Boolean(workerHeartbeat?.stalledGenerationDetected)
  const workerHeartbeatIssues = [
    heartbeatStalled ? "stalled_generation_detected" : "",
    heartbeatActiveJobDrift ? "heartbeat_active_jobs_without_queue_active_jobs" : "",
  ].filter(Boolean)

  return {
    enabled: true,
    status:
      redisError
        ? "degraded"
        : saturation.heavy
          ? "degraded"
        : !memory.evictionPolicyOk
          ? "degraded"
        : heartbeatAgeMs === null
          ? "degraded"
          : heartbeatAgeMs > 90_000
            ? "stale"
            : workerHeartbeatIssues.length > 0
              ? "stale"
            : "healthy",
    counts,
    saturation,
    deadLetter: {
      queueName: DEAD_LETTER_QUEUE_NAME,
      counts: deadLetterCounts,
    },
    workerHeartbeat: workerHeartbeat
      ? {
          ...workerHeartbeat,
          ageMs: heartbeatAgeMs,
          issues: workerHeartbeatIssues,
        }
      : null,
    redis: {
      configured: env.hasNativeRedisConfig,
      status: connection?.status || "unavailable",
      ping: redisPing,
      error: redisError,
      latencyMs: redisLatencyMs,
      memory,
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

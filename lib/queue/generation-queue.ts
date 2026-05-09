import { Queue, Worker, type JobsOptions, type Processor } from "bullmq"
import IORedis from "ioredis"

type GenerationJobName = "generate" | "repair" | "sandbox"

type GenerationJobPayload = {
  projectId: string
  prompt?: string
  idempotencyKey?: string
  taskType?: "generation" | "repair" | "sandbox"
}

const QUEUE_NAME = "swift:generation"
const DEFAULT_JOB_OPTIONS: JobsOptions = {
  attempts: 3,
  backoff: {
    type: "exponential",
    delay: 1000,
  },
  removeOnComplete: 100,
  removeOnFail: 250,
}

let redisConnection: IORedis | null = null
let generationQueue: Queue<GenerationJobPayload, unknown, GenerationJobName> | null = null

function getRedisUrl() {
  return process.env.REDIS_URL || process.env.UPSTASH_REDIS_URL || ""
}

export function isGenerationQueueEnabled() {
  return Boolean(getRedisUrl())
}

function getRedisConnection() {
  if (!redisConnection) {
    const redisUrl = getRedisUrl()
    if (!redisUrl) {
      throw new Error("REDIS_URL is required to use the Swift generation queue")
    }

    redisConnection = new IORedis(redisUrl, {
      maxRetriesPerRequest: null,
      enableReadyCheck: false,
    })
  }

  return redisConnection
}

export function getGenerationQueue() {
  if (!generationQueue) {
    generationQueue = new Queue<GenerationJobPayload, unknown, GenerationJobName>(QUEUE_NAME, {
      connection: getRedisConnection(),
      defaultJobOptions: DEFAULT_JOB_OPTIONS,
    })
  }

  return generationQueue
}

export async function enqueueGenerationTask(
  name: GenerationJobName,
  payload: GenerationJobPayload,
  options?: JobsOptions
) {
  const queue = getGenerationQueue()
  return queue.add(name, payload, {
    ...DEFAULT_JOB_OPTIONS,
    ...options,
    jobId: payload.idempotencyKey || `${name}:${payload.projectId}:${Date.now()}`,
  })
}

export function createGenerationWorker(
  processor: Processor<GenerationJobPayload, unknown, GenerationJobName>
) {
  return new Worker<GenerationJobPayload, unknown, GenerationJobName>(QUEUE_NAME, processor, {
    connection: getRedisConnection(),
    concurrency: Math.max(1, Number(process.env.SWIFT_GENERATION_WORKER_CONCURRENCY || 2)),
  })
}

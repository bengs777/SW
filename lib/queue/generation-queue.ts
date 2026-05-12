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

function getRedisConnection() {
  if (!redisConnection) {
    if (!env.redisUrl) {
      throw new Error("REDIS_URL is required to use the Swift generation queue")
    }

    redisConnection = new IORedis(env.redisUrl, {
      maxRetriesPerRequest: null,
      enableReadyCheck: false,
    })
  }

  return redisConnection
}

export function isGenerationQueueEnabled() {
  return Boolean(env.redisUrl)
}

export function getGenerationQueue() {
  if (!generationQueue) {
    generationQueue = new Queue<GenerationQueuePayload, unknown, GenerationQueueJobName>(QUEUE_NAME, {
      connection: getRedisConnection(),
      defaultJobOptions: DEFAULT_JOB_OPTIONS,
    })
  }

  return generationQueue
}

export function getGenerationQueueEvents() {
  if (!generationQueueEvents) {
    generationQueueEvents = new QueueEvents(QUEUE_NAME, {
      connection: getRedisConnection(),
    })
  }

  return generationQueueEvents
}

export async function enqueueGenerationTask(
  payload: GenerationQueuePayload,
  options?: JobsOptions
) {
  const queue = getGenerationQueue()
  return queue.add("generation.execute", payload, {
    ...DEFAULT_JOB_OPTIONS,
    ...options,
    jobId: payload.idempotencyKey || payload.jobId,
  })
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

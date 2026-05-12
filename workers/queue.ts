// Centralized BullMQ Queue Factory
// All queues use the same Redis connection for efficiency
import { Queue, QueueEvents, Worker, type JobsOptions, type Processor } from "bullmq"
import { getRedisConnection } from "./redis"

export type GenerationJobName = "generation.execute" | "generation.plan"
export type RepairJobName = "repair.targeted"
export type SandboxJobName = "sandbox.start" | "sandbox.stop" | "sandbox.reset"

// Queue names with versioning for safe deployments
export const QUEUE_NAMES = {
  generation: "swift:generation:v2",
  repair: "swift:repair:v1",
  sandbox: "swift:sandbox:v1",
} as const

// Default job options with conservative retries
const DEFAULT_JOB_OPTIONS: JobsOptions = {
  attempts: 3,
  backoff: {
    type: "exponential",
    delay: 2000,
  },
  removeOnComplete: 100,
  removeOnFail: 200,
}

// Lazy queue initialization
let _generationQueue: Queue | null = null
let _repairQueue: Queue | null = null
let _sandboxQueue: Queue | null = null
let _generationEvents: QueueEvents | null = null
let _repairEvents: QueueEvents | null = null

export function getGenerationQueue() {
  if (!_generationQueue) {
    _generationQueue = new Queue(QUEUE_NAMES.generation, {
      connection: getRedisConnection(),
      defaultJobOptions: DEFAULT_JOB_OPTIONS,
    })
  }
  return _generationQueue
}

export function getRepairQueue() {
  if (!_repairQueue) {
    _repairQueue = new Queue(QUEUE_NAMES.repair, {
      connection: getRedisConnection(),
      defaultJobOptions: DEFAULT_JOB_OPTIONS,
    })
  }
  return _repairQueue
}

export function getSandboxQueue() {
  if (!_sandboxQueue) {
    _sandboxQueue = new Queue(QUEUE_NAMES.sandbox, {
      connection: getRedisConnection(),
      defaultJobOptions: {
        ...DEFAULT_JOB_OPTIONS,
        attempts: 2,
      },
    })
  }
  return _sandboxQueue
}

export function getGenerationQueueEvents() {
  if (!_generationEvents) {
    _generationEvents = new QueueEvents(QUEUE_NAMES.generation, {
      connection: getRedisConnection(),
    })
  }
  return _generationEvents
}

export function getRepairQueueEvents() {
  if (!_repairEvents) {
    _repairEvents = new QueueEvents(QUEUE_NAMES.repair, {
      connection: getRedisConnection(),
    })
  }
  return _repairEvents
}

// Typed worker factories
export function createGenerationWorker<T = unknown>(
  processor: Processor<T, unknown, GenerationJobName>
) {
  const connection = getRedisConnection()
  return new Worker<T, unknown, GenerationJobName>(QUEUE_NAMES.generation, processor, {
    connection,
    concurrency: Number(process.env.SWIFT_GENERATION_WORKER_CONCURRENCY || 2),
    stalledInterval: 30_000,
    lockDuration: 120_000,
  })
}

export function createRepairWorker<T = unknown>(
  processor: Processor<T, unknown, RepairJobName>
) {
  const connection = getRedisConnection()
  return new Worker<T, unknown, RepairJobName>(QUEUE_NAMES.repair, processor, {
    connection,
    concurrency: Number(process.env.SWIFT_REPAIR_WORKER_CONCURRENCY || 3),
    stalledInterval: 30_000,
    lockDuration: 90_000,
  })
}

export function createSandboxWorker<T = unknown>(
  processor: Processor<T, unknown, SandboxJobName>
) {
  const connection = getRedisConnection()
  return new Worker<T, unknown, SandboxJobName>(QUEUE_NAMES.sandbox, processor, {
    connection,
    concurrency: Number(process.env.SWIFT_SANDBOX_WORKER_CONCURRENCY || 1),
    stalledInterval: 60_000,
    lockDuration: 300_000,
  })
}

// Graceful shutdown helper
export async function closeQueues() {
  await Promise.all([
    _generationQueue?.close(),
    _repairQueue?.close(),
    _sandboxQueue?.close(),
    _generationEvents?.close(),
    _repairEvents?.close(),
  ])
}
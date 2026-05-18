import type { Job } from "bullmq"
import { env } from "@/lib/env"
import { timeoutConfig } from "@/lib/timeouts"
import {
  createGenerationWorker,
  getGenerationQueue,
  moveGenerationJobToDeadLetter,
  recordGenerationWorkerHeartbeat,
  type GenerationQueuePayload,
} from "@/lib/queue/generation-queue"
import { registerGenerationAbortController } from "@/lib/ai/generation-job-runtime"
import { executeGenerationJob } from "@/lib/services/generation-orchestrator.service"
import { prisma } from "@/lib/db/client"
import { BillingService } from "@/lib/services/billing.service"
import { GenerationJobCancelledError, GenerationJobService } from "@/lib/services/generation-job.service"
import { ProjectFilesystemService } from "@/lib/services/project-filesystem.service"
import { reconcileStaleGenerationJobs } from "@/lib/services/stale-generation-reconciliation.service"
import { log } from "@/lib/logging"
import { captureException } from "@/lib/observability"

const GENERATION_JOB_TIMEOUT_MS = Math.max(
  10_000,
  Math.round(timeoutConfig.generationJobMs || env.aiQueueTimeoutMs)
)

class GenerationJobTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`Generation timed out after ${Math.round(timeoutMs / 1000)}s`)
    this.name = "GenerationJobTimeoutError"
  }
}

async function loadProjectFiles(projectId: string) {
  return ProjectFilesystemService.readFiles(projectId)
}

async function loadGenerationHistoryCount(projectId: string) {
  return prisma.generationHistory.count({
    where: { projectId },
  })
}

export async function processGenerationPayload(payload: GenerationQueuePayload, queueJobId?: string | number) {
  const abortController = new AbortController()
  const unregisterAbort = registerGenerationAbortController(payload.jobId, abortController)
  const startedAt = Date.now()
  const startedAtIso = new Date(startedAt).toISOString()
  const resolvedQueueJobId = queueJobId ? String(queueJobId) : payload.jobId
  let timeoutTriggered = false
  let timeoutHandle: ReturnType<typeof setTimeout> | null = null

  try {
    console.log("worker_started")
    log("info", "Generation worker started", {
      jobId: payload.jobId,
      queueJobId: resolvedQueueJobId,
      projectId: payload.projectId,
      userId: payload.userId,
      requestHash: payload.requestHash,
      traceId: payload.traceId,
    })
    log("info", "worker_started", {
      jobId: payload.jobId,
      queueJobId: resolvedQueueJobId,
      projectId: payload.projectId,
      userId: payload.userId,
      traceId: payload.traceId,
    })

    const execution = executeGenerationJob(
      {
        jobId: payload.jobId,
        projectId: payload.projectId,
        prompt: payload.prompt,
        selectedModel: payload.model,
        promptLanguage: payload.promptLanguage,
        collaborationMode: payload.collaborationMode,
        previewContext: payload.previewContext,
        persistenceKey: payload.idempotencyKey || payload.requestHash || payload.jobId,
        signal: abortController.signal,
      },
      {
        loadProjectFiles,
        loadGenerationHistoryCount,
      }
    )

    await Promise.race([
      execution,
      new Promise<never>((_resolve, reject) => {
        timeoutHandle = setTimeout(() => {
          timeoutTriggered = true
          abortController.abort()
          reject(new GenerationJobTimeoutError(GENERATION_JOB_TIMEOUT_MS))
        }, GENERATION_JOB_TIMEOUT_MS)
      }),
    ])
    console.log("generation_finished")
    await BillingService.markCompleted(payload.usageLogId, {
      provider: payload.provider,
      model: payload.model,
    }).catch((billingError) => {
      log("error", "Generation billing completion failed", {
        jobId: payload.jobId,
        usageLogId: payload.usageLogId,
        error: billingError instanceof Error ? billingError.message : String(billingError),
      })
      captureException(billingError, {
        jobId: payload.jobId,
        usageLogId: payload.usageLogId,
        source: "billing_completion",
      })
    })
    log("info", "Generation worker finished", {
      jobId: payload.jobId,
      queueJobId: resolvedQueueJobId,
      projectId: payload.projectId,
      userId: payload.userId,
      traceId: payload.traceId,
      durationMs: Date.now() - startedAt,
    })
    log("info", "worker_completed", {
      event: "worker_completed",
      jobId: payload.jobId,
      queueJobId: resolvedQueueJobId,
      projectId: payload.projectId,
      userId: payload.userId,
      traceId: payload.traceId,
      startedAt: startedAtIso,
      endedAt: new Date().toISOString(),
      durationMs: Date.now() - startedAt,
      executionMode: String(resolvedQueueJobId).startsWith("serverless:") ? "serverless_fallback" : "queue",
    })
  } catch (error) {
    const isTimeout = timeoutTriggered || error instanceof GenerationJobTimeoutError
    const timeoutMessage = `Generation timed out after ${Math.round(GENERATION_JOB_TIMEOUT_MS / 1000)}s`
    const errorMessage = isTimeout
      ? timeoutMessage
      : error instanceof Error
        ? error.message
        : String(error)
    const isCancelled =
      error instanceof GenerationJobCancelledError ||
      (error instanceof Error && error.message === "GENERATION_JOB_CANCELLED")

    await BillingService.refundReservation(
      payload.usageLogId,
      payload.userId,
      payload.reservedCost,
      errorMessage
    ).catch((refundError) => {
      log("error", "Generation billing refund failed", {
        jobId: payload.jobId,
        usageLogId: payload.usageLogId,
        error: refundError instanceof Error ? refundError.message : String(refundError),
      })
      captureException(refundError, {
        jobId: payload.jobId,
        usageLogId: payload.usageLogId,
        source: "billing_refund",
      })
    })

    if (isTimeout) {
      await GenerationJobService.markFailed(payload.jobId, timeoutMessage, "timeout").catch(() => null)
    }

    if (!isCancelled) {
      log("error", "Generation worker failed", {
        jobId: payload.jobId,
        queueJobId: resolvedQueueJobId,
        projectId: payload.projectId,
        error: errorMessage,
        durationMs: Date.now() - startedAt,
        timeoutMs: GENERATION_JOB_TIMEOUT_MS,
        timeoutTriggered: isTimeout,
        traceId: payload.traceId,
      })
      log("error", "worker_failed", {
        event: "worker_failed",
        jobId: payload.jobId,
        queueJobId: resolvedQueueJobId,
        projectId: payload.projectId,
        userId: payload.userId,
        error: errorMessage,
        startedAt: startedAtIso,
        endedAt: new Date().toISOString(),
        durationMs: Date.now() - startedAt,
        timeoutMs: GENERATION_JOB_TIMEOUT_MS,
        timeoutTriggered: isTimeout,
        traceId: payload.traceId,
      })
      captureException(error, {
        jobId: payload.jobId,
        queueJobId: resolvedQueueJobId,
        projectId: payload.projectId,
        userId: payload.userId,
        source: "generation_worker",
      })
    }
    throw error
  } finally {
    if (timeoutHandle) {
      clearTimeout(timeoutHandle)
    }
    unregisterAbort()
  }
}

export async function processGenerationQueueJob(job: Job<GenerationQueuePayload>) {
  return processGenerationPayload(job.data, job.id)
}

export function startGenerationWorker() {
  const bootStartedAt = Date.now()
  const worker = createGenerationWorker(processGenerationQueueJob)
  const workerId = `generation:${process.env.VERCEL_REGION || "local"}:${process.pid}`

  log("info", "generation_worker_booted", {
    workerId,
    pid: process.pid,
    concurrency: Number(process.env.SWIFT_GENERATION_WORKER_CONCURRENCY || 2),
    timeoutMs: GENERATION_JOB_TIMEOUT_MS,
  })
  log("info", "worker_boot", {
    event: "worker_boot",
    workerId,
    jobId: null,
    pid: process.pid,
    concurrency: Number(process.env.SWIFT_GENERATION_WORKER_CONCURRENCY || 2),
    timeoutMs: GENERATION_JOB_TIMEOUT_MS,
    startedAt: new Date(bootStartedAt).toISOString(),
    endedAt: new Date().toISOString(),
    durationMs: Date.now() - bootStartedAt,
    error: null,
  })

  void reconcileStaleGenerationJobs().catch((error) => {
    log("error", "Stale generation reconciliation failed", {
      error: error instanceof Error ? error.message : String(error),
    })
    captureException(error, { source: "stale_generation_reconcile_startup" })
  })

  const heartbeat = () => {
    recordGenerationWorkerHeartbeat(workerId).catch((error) => {
      log("warn", "Generation worker heartbeat failed", {
        workerId,
        error: error instanceof Error ? error.message : String(error),
      })
    })
  }
  heartbeat()
  const heartbeatTimer = setInterval(heartbeat, 30_000)
  worker.on("closed", () => clearInterval(heartbeatTimer))

  worker.on("active", async (job) => {
    if (!job) return
    const endedAt = job.processedOn || Date.now()
    const startedAt = job.timestamp || endedAt
    await GenerationJobService.attachQueueJob(job.data.jobId, job.id || job.data.jobId)
    log("info", "generation_worker_job_active", {
      workerId,
      jobId: job.data.jobId,
      queueJobId: job.id,
      attemptsMade: job.attemptsMade,
      projectId: job.data.projectId,
      userId: job.data.userId,
      traceId: job.data.traceId,
    })
    log("info", "worker_active", {
      event: "worker_active",
      workerId,
      jobId: job.data.jobId,
      queueJobId: job.id,
      projectId: job.data.projectId,
      userId: job.data.userId,
      attemptsMade: job.attemptsMade,
      startedAt: new Date(startedAt).toISOString(),
      endedAt: new Date(endedAt).toISOString(),
      durationMs: endedAt - startedAt,
      queueWaitMs: job.processedOn && job.timestamp ? job.processedOn - job.timestamp : null,
      error: null,
      traceId: job.data.traceId,
    })
  })

  worker.on("failed", async (job, error) => {
    if (!job) return
    if (error instanceof GenerationJobCancelledError || error.message === "GENERATION_JOB_CANCELLED") return
    const current = await GenerationJobService.findById(job.data.jobId)
    if (current && current.status !== "failed" && current.status !== "cancelled") {
      await GenerationJobService.markFailed(job.data.jobId, error.message || "Generation worker failed")
    }
    captureException(error, {
      jobId: job.data.jobId,
      queueJobId: job.id,
      source: "generation_worker_failed_event",
    })
    log("error", "worker_failed", {
      event: "worker_failed",
      workerId,
      jobId: job.data.jobId,
      queueJobId: job.id,
      projectId: job.data.projectId,
      userId: job.data.userId,
      attemptsMade: job.attemptsMade,
      error: error.message,
      startedAt: job.processedOn ? new Date(job.processedOn).toISOString() : null,
      endedAt: job.finishedOn ? new Date(job.finishedOn).toISOString() : new Date().toISOString(),
      durationMs: job.finishedOn && job.processedOn ? job.finishedOn - job.processedOn : null,
      traceId: job.data.traceId,
    })
    await moveGenerationJobToDeadLetter({
      payload: job.data,
      queueJobId: job.id,
      attemptsMade: job.attemptsMade,
      error,
    }).catch((deadLetterError) => {
      log("error", "generation_dead_letter_write_failed", {
        jobId: job.data.jobId,
        queueJobId: job.id,
        error: deadLetterError instanceof Error ? deadLetterError.message : String(deadLetterError),
      })
    })
  })

  worker.on("completed", async (job) => {
    if (!job) return
    log("info", "Generation worker completed", {
      workerId,
      jobId: job.data.jobId,
      queueJobId: job.id,
      attemptsMade: job.attemptsMade,
      finishedOn: job.finishedOn,
      processedOn: job.processedOn,
      latencyMs: job.finishedOn && job.processedOn ? job.finishedOn - job.processedOn : null,
      traceId: job.data.traceId,
    })
    log("info", "worker_completed", {
      event: "worker_completed",
      workerId,
      jobId: job.data.jobId,
      queueJobId: job.id,
      projectId: job.data.projectId,
      userId: job.data.userId,
      attemptsMade: job.attemptsMade,
      startedAt: job.processedOn ? new Date(job.processedOn).toISOString() : null,
      endedAt: job.finishedOn ? new Date(job.finishedOn).toISOString() : new Date().toISOString(),
      durationMs: job.finishedOn && job.processedOn ? job.finishedOn - job.processedOn : null,
      latencyMs: job.finishedOn && job.processedOn ? job.finishedOn - job.processedOn : null,
      error: null,
      traceId: job.data.traceId,
    })
  })

  worker.on("stalled", async (jobId) => {
    const queue = getGenerationQueue()
    const stalledJob = queue ? await queue.getJob(String(jobId)).catch(() => null) : null
    const payload = stalledJob?.data
    log("warn", "generation_worker_job_stalled", {
      workerId,
      queueJobId: jobId,
    })
    log("warn", "worker_stalled", {
      event: "worker_stalled",
      workerId,
      jobId: payload?.jobId || String(jobId),
      queueJobId: jobId,
      projectId: payload?.projectId || null,
      userId: payload?.userId || null,
      startedAt: stalledJob?.processedOn ? new Date(stalledJob.processedOn).toISOString() : null,
      endedAt: new Date().toISOString(),
      durationMs: null,
      error: null,
      traceId: payload?.traceId,
    })
  })

  worker.on("error", (error) => {
    log("error", "generation_worker_runtime_error", {
      workerId,
      error: error.message,
      stack: error.stack,
    })
    captureException(error, { source: "generation_worker_runtime", workerId })
  })

  worker.on("ready", () => {
    log("info", "generation_worker_ready", { workerId })
  })

  worker.on("closed", () => {
    log("warn", "generation_worker_closed", { workerId })
  })

  return worker
}

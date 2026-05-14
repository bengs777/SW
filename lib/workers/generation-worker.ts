import type { Job } from "bullmq"
import { prisma } from "@/lib/db/client"
import {
  createGenerationWorker,
  recordGenerationWorkerHeartbeat,
  type GenerationQueuePayload,
} from "@/lib/queue/generation-queue"
import { registerGenerationAbortController } from "@/lib/ai/generation-job-runtime"
import { executeGenerationJob } from "@/lib/services/generation-orchestrator.service"
import { BillingService } from "@/lib/services/billing.service"
import {
  GENERATION_TERMINAL_STATUSES,
  GenerationJobCancelledError,
  GenerationJobService,
} from "@/lib/services/generation-job.service"
import { reconcileStaleGenerationJobs } from "@/lib/services/stale-generation-reconciliation.service"
import { log } from "@/lib/logging"
import { captureException } from "@/lib/observability"

async function loadProjectFiles(projectId: string) {
  const files = await prisma.projectFile.findMany({
    where: { projectId },
    orderBy: { path: "asc" },
  })

  return files.map((file) => ({
    path: file.path,
    content: file.content,
    language: file.language as
      | "tsx"
      | "ts"
      | "css"
      | "json"
      | "html"
      | "prisma"
      | "md"
      | "env",
  }))
}

// RELIABILITY: hard deadline for a single generation job execution.
// Ensures the lambda never runs longer than this even if every probe inside
// passes its own timeout. Aligned to maxDuration (300s) on the route minus a
// 10s safety budget for billing reconciliation + final logging.
const JOB_EXECUTION_DEADLINE_MS = 290_000

export async function processGenerationPayload(payload: GenerationQueuePayload, queueJobId?: string | number) {
  const abortController = new AbortController()
  const unregisterAbort = registerGenerationAbortController(payload.jobId, abortController)
  const startedAt = Date.now()
  const resolvedQueueJobId = queueJobId ? String(queueJobId) : payload.jobId

  // Outer deadline — if the job runs past its budget for ANY reason
  // (orchestrator loop, hung probe, stuck DB call), abort the controller so
  // every downstream call sees the abort and unwinds. The .unref() means the
  // timer never keeps the worker process alive on its own.
  const deadlineTimer = setTimeout(() => {
    log("error", "generation_worker_deadline_exceeded", {
      jobId: payload.jobId,
      queueJobId: resolvedQueueJobId,
      deadlineMs: JOB_EXECUTION_DEADLINE_MS,
    })
    abortController.abort(new Error("GENERATION_JOB_DEADLINE_EXCEEDED"))
  }, JOB_EXECUTION_DEADLINE_MS)
  if (deadlineTimer.unref) deadlineTimer.unref()

  // RELIABILITY: Idempotency guard. If BullMQ re-delivers a job whose DB
  // record is already in a terminal state (completed/failed/cancelled), we
  // MUST NOT re-execute it. Re-execution would double-charge the user and
  // produce duplicate file writes. This is the single most important
  // safeguard against re-delivery bugs (lock expiry, worker crash + restart,
  // BullMQ retry).
  try {
    const existing = await GenerationJobService.findById(payload.jobId)
    if (existing && GENERATION_TERMINAL_STATUSES.has(existing.status)) {
      log("warn", "generation_worker_skipped_terminal", {
        jobId: payload.jobId,
        queueJobId: resolvedQueueJobId,
        status: existing.status,
      })
      clearTimeout(deadlineTimer)
      unregisterAbort()
      return
    }
  } catch (error) {
    log("warn", "generation_worker_terminal_check_failed", {
      jobId: payload.jobId,
      error: error instanceof Error ? error.message : String(error),
    })
    // Continue — better to risk a retry than to silently lose a job on a
    // transient DB blip.
  }

  try {
    log("info", "generation_worker_started", {
      jobId: payload.jobId,
      queueJobId: resolvedQueueJobId,
      projectId: payload.projectId,
      userId: payload.userId,
      requestHash: payload.requestHash,
    })

    await executeGenerationJob(
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
      }
    )
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
    log("info", "generation_worker_finished", {
      jobId: payload.jobId,
      queueJobId: resolvedQueueJobId,
      projectId: payload.projectId,
      userId: payload.userId,
      durationMs: Date.now() - startedAt,
    })
  } catch (error) {
    const isCancelled =
      error instanceof GenerationJobCancelledError ||
      (error instanceof Error && error.message === "GENERATION_JOB_CANCELLED")

    await BillingService.refundReservation(
      payload.usageLogId,
      payload.userId,
      payload.reservedCost,
      error instanceof Error ? error.message : String(error)
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

    if (!isCancelled) {
      log("error", "generation_worker_failed", {
        jobId: payload.jobId,
        queueJobId: resolvedQueueJobId,
        error: error instanceof Error ? error.message : String(error),
        durationMs: Date.now() - startedAt,
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
    clearTimeout(deadlineTimer)
    unregisterAbort()
  }
}

export async function processGenerationQueueJob(job: Job<GenerationQueuePayload>) {
  return processGenerationPayload(job.data, job.id)
}

export function startGenerationWorker() {
  const worker = createGenerationWorker(processGenerationQueueJob)
  const workerId = `generation:${process.env.VERCEL_REGION || "local"}:${process.pid}`

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
  // Don't keep the process alive just for heartbeats during shutdown.
  if (heartbeatTimer.unref) heartbeatTimer.unref()
  worker.on("closed", () => clearInterval(heartbeatTimer))
  worker.on("closing", () => clearInterval(heartbeatTimer))

  worker.on("active", async (job) => {
    if (!job) return
    await GenerationJobService.attachQueueJob(job.data.jobId, job.id || job.data.jobId).catch(
      (error) => {
        log("warn", "Generation worker attach_queue_job failed", {
          jobId: job.data.jobId,
          queueJobId: job.id,
          error: error instanceof Error ? error.message : String(error),
        })
      }
    )
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
  })

  worker.on("completed", async (job) => {
    if (!job) return
    log("info", "generation_worker_completed", {
      jobId: job.data.jobId,
      queueJobId: job.id,
    })
  })

  // RELIABILITY: log stalled jobs so we can see lock-expiry events. A spike
  // here means lockDuration is still too small or workers are starving.
  worker.on("stalled", (jobId) => {
    log("warn", "generation_worker_stalled", { queueJobId: jobId })
    captureException(new Error("BullMQ generation job stalled"), {
      queueJobId: jobId,
      source: "generation_worker_stalled_event",
    })
  })

  // Worker-level errors (Redis connection drop, etc) — must not crash
  // the process. Logged + reported to Sentry, BullMQ will reconnect.
  worker.on("error", (error) => {
    log("error", "generation_worker_error", {
      workerId,
      error: error instanceof Error ? error.message : String(error),
    })
    captureException(error, { source: "generation_worker_error_event", workerId })
  })

  return worker
}

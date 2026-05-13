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
import { GenerationJobCancelledError, GenerationJobService } from "@/lib/services/generation-job.service"
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

export async function processGenerationQueueJob(job: Job<GenerationQueuePayload>) {
  const abortController = new AbortController()
  const unregisterAbort = registerGenerationAbortController(job.data.jobId, abortController)
  const startedAt = Date.now()

  try {
    log("info", "Generation worker started", {
      jobId: job.data.jobId,
      queueJobId: job.id,
      projectId: job.data.projectId,
      userId: job.data.userId,
      requestHash: job.data.requestHash,
    })

    await executeGenerationJob(
      {
        jobId: job.data.jobId,
        projectId: job.data.projectId,
        prompt: job.data.prompt,
        selectedModel: job.data.model,
        promptLanguage: job.data.promptLanguage,
        collaborationMode: job.data.collaborationMode,
        previewContext: job.data.previewContext,
        persistenceKey: job.data.idempotencyKey || job.data.requestHash || job.data.jobId,
        signal: abortController.signal,
      },
      {
        loadProjectFiles,
      }
    )
    await BillingService.markCompleted(job.data.usageLogId, {
      provider: job.data.provider,
      model: job.data.model,
    }).catch((billingError) => {
      log("error", "Generation billing completion failed", {
        jobId: job.data.jobId,
        usageLogId: job.data.usageLogId,
        error: billingError instanceof Error ? billingError.message : String(billingError),
      })
      captureException(billingError, {
        jobId: job.data.jobId,
        usageLogId: job.data.usageLogId,
        source: "billing_completion",
      })
    })
    log("info", "Generation worker finished", {
      jobId: job.data.jobId,
      queueJobId: job.id,
      projectId: job.data.projectId,
      userId: job.data.userId,
      durationMs: Date.now() - startedAt,
    })
  } catch (error) {
    const isCancelled =
      error instanceof GenerationJobCancelledError ||
      (error instanceof Error && error.message === "GENERATION_JOB_CANCELLED")

    await BillingService.refundReservation(
      job.data.usageLogId,
      job.data.userId,
      job.data.reservedCost,
      error instanceof Error ? error.message : String(error)
    ).catch((refundError) => {
      log("error", "Generation billing refund failed", {
        jobId: job.data.jobId,
        usageLogId: job.data.usageLogId,
        error: refundError instanceof Error ? refundError.message : String(refundError),
      })
      captureException(refundError, {
        jobId: job.data.jobId,
        usageLogId: job.data.usageLogId,
        source: "billing_refund",
      })
    })

    if (!isCancelled) {
      log("error", "Generation worker failed", {
        jobId: job.data.jobId,
        queueJobId: job.id,
        error: error instanceof Error ? error.message : String(error),
        durationMs: Date.now() - startedAt,
      })
      captureException(error, {
        jobId: job.data.jobId,
        queueJobId: job.id,
        projectId: job.data.projectId,
        userId: job.data.userId,
        source: "generation_worker",
      })
    }
    throw error
  } finally {
    unregisterAbort()
  }
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
  worker.on("closed", () => clearInterval(heartbeatTimer))

  worker.on("active", async (job) => {
    if (!job) return
    await GenerationJobService.attachQueueJob(job.data.jobId, job.id || job.data.jobId)
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
    log("info", "Generation worker completed", {
      jobId: job.data.jobId,
      queueJobId: job.id,
    })
  })

  return worker
}

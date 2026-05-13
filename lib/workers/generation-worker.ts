import type { Job } from "bullmq"
import { prisma } from "@/lib/db/client"
import {
  createGenerationWorker,
  recordGenerationWorkerHeartbeat,
  type GenerationQueuePayload,
} from "@/lib/queue/generation-queue"
import { env } from "@/lib/env"
import { registerGenerationAbortController } from "@/lib/ai/generation-job-runtime"
import { executeGenerationJob } from "@/lib/services/generation-orchestrator.service"
import { BillingService } from "@/lib/services/billing.service"
import { GenerationJobCancelledError, GenerationJobService } from "@/lib/services/generation-job.service"
import { log } from "@/lib/logging"
import { captureException } from "@/lib/observability"

const STALE_GENERATION_TIMEOUT_MS = Math.max(
  env.aiQueueTimeoutMs,
  Number(process.env.SWIFT_STALE_GENERATION_TIMEOUT_MS || 15 * 60_000)
)

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

function parseBillingContext(contextJson: string | null) {
  if (!contextJson) return null

  try {
    const context = JSON.parse(contextJson) as {
      billing?: {
        usageLogId?: unknown
        reservedCost?: unknown
      }
    }
    const usageLogId = context.billing?.usageLogId
    const reservedCost = context.billing?.reservedCost

    if (typeof usageLogId !== "string" || typeof reservedCost !== "number") {
      return null
    }

    return { usageLogId, reservedCost }
  } catch {
    return null
  }
}

async function reconcileStaleGenerationJobs() {
  const cutoff = new Date(Date.now() - STALE_GENERATION_TIMEOUT_MS)
  const staleJobs = await prisma.generationJob.findMany({
    where: {
      status: {
        in: ["queued", "running", "cancelling"],
      },
      updatedAt: {
        lt: cutoff,
      },
    },
    take: 25,
    orderBy: { updatedAt: "asc" },
  })

  for (const job of staleJobs) {
    const message = `Generation timed out after worker recovery window (${Math.round(STALE_GENERATION_TIMEOUT_MS / 1000)}s)`
    await GenerationJobService.markFailed(job.id, message, "timeout")
    const billing = parseBillingContext(job.contextJson)
    if (billing) {
      await BillingService.refundReservation(
        billing.usageLogId,
        job.userId,
        billing.reservedCost,
        message
      ).catch((error) => {
        log("error", "Stale generation refund failed", {
          jobId: job.id,
          usageLogId: billing.usageLogId,
          error: error instanceof Error ? error.message : String(error),
        })
        captureException(error, {
          jobId: job.id,
          usageLogId: billing.usageLogId,
          source: "stale_generation_reconcile",
        })
      })
    }

    log("warn", "Stale generation reconciled", {
      jobId: job.id,
      userId: job.userId,
      projectId: job.projectId,
      previousStatus: job.status,
      updatedAt: job.updatedAt.toISOString(),
    })
  }
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

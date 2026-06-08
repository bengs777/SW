import { prisma } from "@/lib/db/client"
import { env } from "@/lib/env"
import { MIN_GENERATION_JOB_TIMEOUT_MS, timeoutConfig } from "@/lib/timeouts"
import { captureException } from "@/lib/observability"
import { log } from "@/lib/logging"
import { BillingService } from "@/lib/services/billing.service"
import { GenerationJobService } from "@/lib/services/generation-job.service"
import { OrchestrationRuntimeService } from "@/lib/services/orchestration-runtime.service"

const STALE_GENERATION_TIMEOUT_MS = Math.max(
  MIN_GENERATION_JOB_TIMEOUT_MS,
  Number(timeoutConfig.staleGenerationMs || env.aiQueueTimeoutMs)
)
const TERMINAL_STATUS_VALUES = ["completed", "failed", "cancelled", "dead_lettered", "terminated"]

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

async function reconcileTerminalStatusDrift() {
  const now = new Date()
  const deadLettered = await prisma.generationJob.updateMany({
    where: {
      deadLetteredAt: { not: null },
      status: { not: "dead_lettered" },
    },
    data: {
      status: "dead_lettered",
      orchestrationState: "dead_lettered",
      stage: "failed",
      progress: 100,
      terminatedAt: now,
      leaseOwner: null,
      leaseExpiresAt: null,
    },
  })
  const failed = await prisma.generationJob.updateMany({
    where: {
      failedAt: { not: null },
      status: { notIn: TERMINAL_STATUS_VALUES },
    },
    data: {
      status: "failed",
      orchestrationState: "terminated",
      stage: "failed",
      progress: 100,
      terminatedAt: now,
      leaseOwner: null,
      leaseExpiresAt: null,
    },
  })
  const cancelled = await prisma.generationJob.updateMany({
    where: {
      cancelledAt: { not: null },
      status: { notIn: TERMINAL_STATUS_VALUES },
    },
    data: {
      status: "cancelled",
      orchestrationState: "terminated",
      stage: "cancelled",
      progress: 100,
      terminatedAt: now,
      leaseOwner: null,
      leaseExpiresAt: null,
    },
  })

  if (deadLettered.count > 0 || failed.count > 0 || cancelled.count > 0) {
    log("warn", "terminal_generation_status_drift_reconciled", {
      deadLettered: deadLettered.count,
      failed: failed.count,
      cancelled: cancelled.count,
    })
  }
}

export async function reconcileStaleGenerationJobs() {
  await OrchestrationRuntimeService.recoverOrphanedJobs().catch((error) => {
    log("warn", "orphaned_generation_recovery_failed", {
      error: error instanceof Error ? error.message : String(error),
    })
  })
  await reconcileTerminalStatusDrift()
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

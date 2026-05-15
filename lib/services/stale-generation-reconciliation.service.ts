import { prisma } from "@/lib/db/client"
import { env } from "@/lib/env"
import { captureException } from "@/lib/observability"
import { log } from "@/lib/logging"
import { BillingService } from "@/lib/services/billing.service"
import { GenerationJobService } from "@/lib/services/generation-job.service"

const STALE_GENERATION_TIMEOUT_MS = Math.max(
  env.aiQueueTimeoutMs,
  Number(process.env.SWIFT_STALE_GENERATION_TIMEOUT_MS || 5 * 60_000)
)

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

export async function reconcileStaleGenerationJobs() {
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

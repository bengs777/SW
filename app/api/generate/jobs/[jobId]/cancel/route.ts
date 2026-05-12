import { NextRequest, NextResponse } from "next/server"
import { auth } from "@/auth"
import { prisma } from "@/lib/db/client"
import { abortGenerationJob } from "@/lib/ai/generation-job-runtime"
import { getGenerationQueue } from "@/lib/queue/generation-queue"
import { BillingService } from "@/lib/services/billing.service"
import { GENERATION_TERMINAL_STATUSES, GenerationJobService } from "@/lib/services/generation-job.service"

export const runtime = "nodejs"

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

export async function POST(
  _request: NextRequest,
  context: { params: Promise<{ jobId: string }> }
) {
  const session = await auth()
  const email = session?.user?.email

  if (!email) {
    return NextResponse.json({ error: "Authentication required" }, { status: 401 })
  }

  const { jobId } = await context.params
  const user = await prisma.user.findUnique({
    where: { email },
    select: { id: true },
  })

  if (!user) {
    return NextResponse.json({ error: "Authenticated user not found" }, { status: 404 })
  }

  const job = await GenerationJobService.findForUser(jobId, user.id)
  if (!job) {
    return NextResponse.json({ error: "Generation job not found" }, { status: 404 })
  }

  if (GENERATION_TERMINAL_STATUSES.has(job.status)) {
    return NextResponse.json({
      ok: true,
      alreadyTerminal: true,
      job: GenerationJobService.toPublicJob(job),
    })
  }

  await GenerationJobService.requestCancel(jobId)
  const abortedInProcess = abortGenerationJob(jobId)
  const queue = getGenerationQueue()
  const queueJobId = job.queueJobId || job.id
  if (queue) {
    const queueJob = await queue.getJob(queueJobId).catch(() => null)
    if (queueJob) {
      await queueJob.remove().catch(() => null)
    }
  }

  const billing = parseBillingContext(job.contextJson)
  if (billing) {
    await BillingService.refundReservation(
      billing.usageLogId,
      user.id,
      billing.reservedCost,
      "Generation cancelled"
    ).catch(() => null)
  }

  const cancelled = await GenerationJobService.markCancelled(jobId, "Generation cancelled")

  return NextResponse.json({
    ok: true,
    abortedInProcess,
    job: cancelled ? GenerationJobService.toPublicJob(cancelled) : null,
  })
}

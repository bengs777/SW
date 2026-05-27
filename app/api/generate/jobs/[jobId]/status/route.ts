import { NextRequest, NextResponse } from "next/server"
import { auth } from "@/auth"
import { prisma } from "@/lib/db/client"
import { getGenerationQueue } from "@/lib/queue/generation-queue"
import { GenerationJobService } from "@/lib/services/generation-job.service"
import { OrchestrationRuntimeService } from "@/lib/services/orchestration-runtime.service"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

async function getQueuePosition(queueJobId?: string | null) {
  if (!queueJobId) return { queuePosition: null, estimatedWaitMs: null }
  const queue = getGenerationQueue()
  if (!queue) return { queuePosition: null, estimatedWaitMs: null }

  const [waiting, delayed, job] = await Promise.all([
    queue.getJobs(["waiting"], 0, 200, true).catch(() => []),
    queue.getJobs(["delayed"], 0, 200, true).catch(() => []),
    queue.getJob(queueJobId).catch(() => null),
  ])
  const ordered = [...waiting, ...delayed].sort((left, right) => {
    if ((left.opts.priority || 4) !== (right.opts.priority || 4)) {
      return (left.opts.priority || 4) - (right.opts.priority || 4)
    }
    return Number(left.timestamp || 0) - Number(right.timestamp || 0)
  })
  const queuePosition = ordered.findIndex((item) => String(item.id) === String(queueJobId))
  const waitMs = job ? Math.max(0, Date.now() - Number(job.timestamp || Date.now())) : null
  return {
    queuePosition: queuePosition >= 0 ? queuePosition + 1 : null,
    estimatedWaitMs: waitMs,
  }
}

export async function GET(
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

  const status = await OrchestrationRuntimeService.getStatus(jobId)
  if (!status) {
    return NextResponse.json({ error: "Generation job not found" }, { status: 404 })
  }

  const queue = await getQueuePosition(job.queueJobId || job.id)
  return NextResponse.json({
    ...status,
    progressStreamingReady: status.durability.progressStreamingReady,
    queuePosition: queue.queuePosition ?? status.queuePosition,
    estimatedWaitMs: queue.estimatedWaitMs ?? status.estimatedWaitMs,
  })
}

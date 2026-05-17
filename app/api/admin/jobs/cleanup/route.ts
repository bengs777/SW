import { NextRequest, NextResponse } from "next/server"
import { prisma } from "@/lib/db/client"
import { requireDeveloperActorResponse } from "@/lib/admin"
import { cleanupGenerationQueue } from "@/lib/queue/generation-queue"
import { reconcileStaleGenerationJobs } from "@/lib/services/stale-generation-reconciliation.service"

/**
 * POST /api/admin/jobs/cleanup
 *
 * Admin-only endpoint to clean up stuck generation jobs.
 * This marks all jobs stuck in queued/running/cancelling for >2 minutes as failed,
 * unblocking users from the 429 "Too many active jobs" error.
 *
 * Only accessible by the developer account (DEV_OWNER_EMAIL).
 */

export const runtime = "nodejs"

export async function POST(request: NextRequest) {
  const actorResult = await requireDeveloperActorResponse()
  if ("error" in actorResult) {
    return actorResult.error
  }

  await reconcileStaleGenerationJobs().catch(() => null)
  const queueCleanup = await cleanupGenerationQueue().catch((error) => ({
    enabled: false,
    cleaned: null,
    error: error instanceof Error ? error.message : String(error),
  }))

  const STUCK_THRESHOLD_MINUTES = 2
  const cutoff = new Date(Date.now() - STUCK_THRESHOLD_MINUTES * 60 * 1000)

  // Find stuck jobs
  const stuckJobs = await prisma.generationJob.findMany({
    where: {
      status: { in: ["queued", "running", "cancelling"] },
      updatedAt: { lt: cutoff },
    },
    select: {
      id: true,
      userId: true,
      status: true,
      createdAt: true,
      updatedAt: true,
    },
    take: 50,
  })

  if (stuckJobs.length === 0) {
    return NextResponse.json({
      success: true,
      message: "No stuck jobs found. All clear!",
      cleaned: 0,
      queueCleanup,
    })
  }

  // Mark them as failed
  const result = await prisma.generationJob.updateMany({
    where: {
      id: { in: stuckJobs.map((j) => j.id) },
      status: { in: ["queued", "running", "cancelling"] },
    },
    data: {
      status: "failed",
      error: "Admin cleanup - stuck job recovery",
      failedAt: new Date(),
      updatedAt: new Date(),
    },
  })

  return NextResponse.json({
    success: true,
    message: `Cleaned ${result.count} stuck job(s). Users can now submit new requests.`,
    cleaned: result.count,
    queueCleanup,
    jobs: stuckJobs.map((j) => ({
      id: j.id,
      userId: j.userId,
      previousStatus: j.status,
      stuckSince: j.updatedAt.toISOString(),
    })),
  })
}

// GET: Show current stuck jobs without cleaning
export async function GET(request: NextRequest) {
  const actorResult = await requireDeveloperActorResponse()
  if ("error" in actorResult) {
    return actorResult.error
  }

  const STUCK_THRESHOLD_MINUTES = 2
  const cutoff = new Date(Date.now() - STUCK_THRESHOLD_MINUTES * 60 * 1000)

  const stuckJobs = await prisma.generationJob.findMany({
    where: {
      status: { in: ["queued", "running", "cancelling"] },
      updatedAt: { lt: cutoff },
    },
    select: {
      id: true,
      userId: true,
      status: true,
      createdAt: true,
      updatedAt: true,
    },
    take: 50,
  })

  const activeJobs = await prisma.generationJob.findMany({
    where: {
      status: { in: ["queued", "running", "cancelling"] },
    },
    select: {
      id: true,
      userId: true,
      status: true,
      createdAt: true,
      updatedAt: true,
    },
    take: 50,
  })

  return NextResponse.json({
    totalActive: activeJobs.length,
    stuckCount: stuckJobs.length,
    stuckThresholdMinutes: STUCK_THRESHOLD_MINUTES,
    activeJobs: activeJobs.map((j) => ({
      id: j.id,
      userId: j.userId,
      status: j.status,
      created: j.createdAt.toISOString(),
      lastUpdate: j.updatedAt.toISOString(),
      isStuck: j.updatedAt < cutoff,
    })),
  })
}

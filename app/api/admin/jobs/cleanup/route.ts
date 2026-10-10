import { NextResponse } from "next/server"
import { db } from "@/lib/db/client"
import { generationJobs } from "@/lib/db/schema"
import { and, inArray, lt } from "drizzle-orm"
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

export async function POST() {
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

  const stuckJobs = await db.select({
    id: generationJobs.id,
    userId: generationJobs.userId,
    status: generationJobs.status,
    createdAt: generationJobs.createdAt,
    updatedAt: generationJobs.updatedAt,
  }).from(generationJobs)
    .where(and(
      inArray(generationJobs.status, ["queued", "running", "cancelling"]),
      lt(generationJobs.updatedAt, cutoff)
    ))
    .limit(50)

  if (stuckJobs.length === 0) {
    return NextResponse.json({
      success: true,
      message: "No stuck jobs found. All clear!",
      cleaned: 0,
      queueCleanup,
    })
  }

  const result = await db.update(generationJobs)
    .set({
      status: "failed",
      error: "Admin cleanup - stuck job recovery",
      failedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(and(
      inArray(generationJobs.id, stuckJobs.map((j) => j.id)),
      inArray(generationJobs.status, ["queued", "running", "cancelling"])
    ))
    .returning({ id: generationJobs.id })

  return NextResponse.json({
    success: true,
    message: `Cleaned ${result.length} stuck job(s). Users can now submit new requests.`,
    cleaned: result.length,
    queueCleanup,
    jobs: stuckJobs.map((j) => ({
      id: j.id,
      userId: j.userId,
      previousStatus: j.status,
      stuckSince: j.updatedAt.toISOString(),
    })),
  })
}

export async function GET() {
  const actorResult = await requireDeveloperActorResponse()
  if ("error" in actorResult) {
    return actorResult.error
  }

  const STUCK_THRESHOLD_MINUTES = 2
  const cutoff = new Date(Date.now() - STUCK_THRESHOLD_MINUTES * 60 * 1000)

  const stuckJobs = await db.select({
    id: generationJobs.id,
    userId: generationJobs.userId,
    status: generationJobs.status,
    createdAt: generationJobs.createdAt,
    updatedAt: generationJobs.updatedAt,
  }).from(generationJobs)
    .where(and(
      inArray(generationJobs.status, ["queued", "running", "cancelling"]),
      lt(generationJobs.updatedAt, cutoff)
    ))
    .limit(50)

  const activeJobs = await db.select({
    id: generationJobs.id,
    userId: generationJobs.userId,
    status: generationJobs.status,
    createdAt: generationJobs.createdAt,
    updatedAt: generationJobs.updatedAt,
  }).from(generationJobs)
    .where(inArray(generationJobs.status, ["queued", "running", "cancelling"]))
    .limit(50)

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

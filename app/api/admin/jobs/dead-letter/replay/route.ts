import { NextRequest, NextResponse } from "next/server"
import { z } from "zod"
import { prisma } from "@/lib/db/client"
import { requireDeveloperActorResponse } from "@/lib/admin"
import { getGenerationDeadLetterPayload, replayGenerationDeadLetterJob } from "@/lib/queue/generation-queue"
import { GenerationJobService } from "@/lib/services/generation-job.service"
import { log } from "@/lib/logging"

export const runtime = "nodejs"

const ReplaySchema = z.object({
  deadLetterJobId: z.string().trim().min(1),
  removeDeadLetter: z.boolean().optional().default(false),
})

export async function POST(request: NextRequest) {
  const actorResult = await requireDeveloperActorResponse()
  if ("error" in actorResult) {
    return actorResult.error
  }

  const body = await request.json().catch(() => null)
  const parsed = ReplaySchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message || "Invalid dead-letter replay payload" },
      { status: 400 }
    )
  }

  try {
    const deadLetterPayload = await getGenerationDeadLetterPayload(parsed.data.deadLetterJobId)
    const replayQueueJobId = `replay:${deadLetterPayload.jobId}:${Date.now()}`
    await prisma.generationJob.update({
      where: { id: deadLetterPayload.jobId },
      data: {
        status: "queued",
        stage: "queued",
        label: "Replayed from dead-letter queue",
        progress: 0,
        error: null,
        failedAt: null,
        timedOutAt: null,
        cancelledAt: null,
        completedAt: null,
        cancelRequested: false,
        cancelReason: null,
        queueJobId: replayQueueJobId,
        version: { increment: 1 },
      },
    })

    await GenerationJobService.appendEvent({
      jobId: deadLetterPayload.jobId,
      type: "job.dead_letter_replayed",
      stage: "queued",
      status: "queued",
      message: "Generation job replayed from dead-letter queue",
      data: {
        deadLetterJobId: parsed.data.deadLetterJobId,
        queueJobId: replayQueueJobId,
        actorId: actorResult.actor.id,
      },
    })

    const replay = await replayGenerationDeadLetterJob({
      deadLetterJobId: parsed.data.deadLetterJobId,
      queueJobId: replayQueueJobId,
      removeDeadLetter: parsed.data.removeDeadLetter,
    })

    log("warn", "dead_letter_replay_requested", {
      deadLetterJobId: parsed.data.deadLetterJobId,
      jobId: replay.payload.jobId,
      queueJobId: replay.queueJobId,
      actorId: actorResult.actor.id,
    })

    return NextResponse.json({
      ok: true,
      jobId: replay.payload.jobId,
      queueJobId: replay.queueJobId,
    })
  } catch (error) {
    log("error", "dead_letter_replay_failed", {
      deadLetterJobId: parsed.data.deadLetterJobId,
      actorId: actorResult.actor.id,
      error: error instanceof Error ? error.message : String(error),
    })
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to replay dead-letter job" },
      { status: 500 }
    )
  }
}

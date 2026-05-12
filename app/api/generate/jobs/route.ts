import { NextRequest, NextResponse } from "next/server"
import { z } from "zod"
import { auth } from "@/auth"
import { prisma } from "@/lib/db/client"
import { enqueueGenerationTask, isGenerationQueueEnabled } from "@/lib/queue/generation-queue"
import { GenerationJobService } from "@/lib/services/generation-job.service"

export const runtime = "nodejs"

const CreateJobSchema = z.object({
  projectId: z.string().min(1),
  prompt: z.string().min(1),
  model: z.string().min(1),
  provider: z.string().optional(),
  plan: z.array(z.string()).optional(),
})

export async function POST(request: NextRequest) {
  const session = await auth()
  const email = session?.user?.email

  if (!email) {
    return NextResponse.json({ error: "Authentication required" }, { status: 401 })
  }

  const body = await request.json().catch(() => null)
  const parsed = await CreateJobSchema.safeParseAsync(body)

  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid generation job payload" }, { status: 400 })
  }

  const user = await prisma.user.findUnique({
    where: { email },
    select: { id: true },
  })

  if (!user) {
    return NextResponse.json({ error: "Authenticated user not found" }, { status: 404 })
  }

  const project = await prisma.project.findFirst({
    where: {
      id: parsed.data.projectId,
      workspace: {
        members: {
          some: {
            userId: user.id,
          },
        },
      },
    },
    select: { id: true },
  })

  if (!project) {
    return NextResponse.json({ error: "Project not found" }, { status: 404 })
  }

  const job = await GenerationJobService.create({
    userId: user.id,
    projectId: project.id,
    prompt: parsed.data.prompt,
    model: parsed.data.model,
    provider: parsed.data.provider,
    plan: parsed.data.plan,
  })

  if (!isGenerationQueueEnabled()) {
    await GenerationJobService.markFailed(job.id, "Redis queue is not configured for generation jobs.")
    return NextResponse.json({ error: "Generation queue is unavailable" }, { status: 503 })
  }

  const queueJob = await enqueueGenerationTask({
    jobId: job.id,
    userId: user.id,
    projectId: project.id,
    prompt: parsed.data.prompt,
    model: parsed.data.model,
    provider: parsed.data.provider || "swift",
  })

  await GenerationJobService.attachQueueJob(job.id, queueJob.id || job.id)

  return NextResponse.json({
    job: GenerationJobService.toPublicJob(job),
  }, { status: 202 })
}

import { NextRequest, NextResponse } from "next/server"
import { z } from "zod"
import { auth } from "@/auth"
import { prisma } from "@/lib/db/client"
import { enqueueGenerationTask } from "@/lib/queue/generation-queue"
import { GenerationJobService } from "@/lib/services/generation-job.service"

export const runtime = "nodejs"

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

  const queueJob = await enqueueGenerationTask({
    jobId: job.id,
    userId: user.id,
    projectId: project.id,
    prompt: parsed.data.prompt,
    model: parsed.data.model,
    provider: parsed.data.provider || "swift",
  })

  if (queueJob) {
    await GenerationJobService.attachQueueJob(job.id, queueJob.id || job.id)
  } else {
    void import("@/lib/services/generation-orchestrator.service")
      .then(({ executeGenerationJob }) =>
        executeGenerationJob(
          {
            jobId: job.id,
            projectId: project.id,
            prompt: parsed.data.prompt,
            selectedModel: parsed.data.model,
          },
          {
            loadProjectFiles,
          }
        )
      )
      .catch((error) => {
        console.error(
          "[Generation Queue] Direct fallback generation failed:",
          error instanceof Error ? error.message : String(error)
        )
      })
  }

  return NextResponse.json({
    job: GenerationJobService.toPublicJob(job),
  }, { status: 202 })
}

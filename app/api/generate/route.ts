import { NextRequest, NextResponse } from "next/server"
import { z } from "zod"
import { auth } from "@/auth"
import { prisma } from "@/lib/db/client"
import { GenerationJobService } from "@/lib/services/generation-job.service"

export const runtime = "nodejs"

const GenerateSchema = z.object({
  prompt: z.string().min(1),
  projectId: z.string().min(1),
  selectedModel: z.string().min(1),
  jobId: z.string().min(1),
  promptLanguage: z.enum(["id", "en"]).optional().default("id"),
  collaborationMode: z.string().optional(),
  idempotencyKey: z.string().optional(),
  previewContext: z.unknown().optional(),
  attachments: z.array(z.unknown()).optional().default([]),
})

export async function POST(request: NextRequest) {
  const session = await auth()
  const email = session?.user?.email

  if (!email) {
    return NextResponse.json({ error: "Authentication required" }, { status: 401 })
  }

  const body = await request.json().catch(() => null)
  const parsed = await GenerateSchema.safeParseAsync(body)

  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid generate payload" }, { status: 400 })
  }

  const user = await prisma.user.findUnique({
    where: { email },
    select: { id: true },
  })

  if (!user) {
    return NextResponse.json({ error: "Authenticated user not found" }, { status: 404 })
  }

  const job = await GenerationJobService.findForUser(parsed.data.jobId, user.id)
  if (!job) {
    return NextResponse.json({ error: "Generation job not found" }, { status: 404 })
  }

  await GenerationJobService.transition(job.id, {
    type: "job.request.accepted",
    status: job.status === "queued" ? "queued" : (job.status as "queued" | "running" | "completed" | "failed" | "cancelled" | "cancelling"),
    stage: job.stage as
      | "queued"
      | "generating"
      | "parsing"
      | "validating"
      | "saving"
      | "compiling"
      | "repairing"
      | "completed"
      | "failed"
      | "cancelled",
    label: "Generation request accepted",
    context: {
      promptLanguage: parsed.data.promptLanguage,
      collaborationMode: parsed.data.collaborationMode || null,
      previewContext: parsed.data.previewContext || null,
      attachmentCount: parsed.data.attachments.length,
      idempotencyKey: parsed.data.idempotencyKey || null,
    },
    message: "Generation request accepted",
  })

  return NextResponse.json(
    {
      ok: true,
      accepted: true,
      job: GenerationJobService.toPublicJob(job),
    },
    { status: 202 }
  )
}

import { NextRequest, NextResponse } from "next/server"
import { auth } from "@/auth"
import { prisma } from "@/lib/db/client"
import { GenerationDraftArtifactService } from "@/lib/services/generation-draft-artifact.service"
import { GenerationJobService } from "@/lib/services/generation-job.service"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

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

  const draft = await GenerationDraftArtifactService.readForJob({ jobId, userId: user.id })
  if (!draft) {
    return NextResponse.json({ error: "Generation draft not found" }, { status: 404 })
  }

  return NextResponse.json({
    ok: true,
    jobId,
    projectId: job.projectId,
    status: draft.status,
    artifactId: draft.artifactId,
    updatedAt: draft.updatedAt,
    manifest: draft.manifest,
    fileCount: draft.files.length,
    files: draft.files,
  }, {
    headers: {
      "Cache-Control": "no-store",
    },
  })
}

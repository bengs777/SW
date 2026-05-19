import { NextRequest, NextResponse } from "next/server"
import { auth } from "@/auth"
import { prisma } from "@/lib/db/client"
import { OrchestrationRuntimeService } from "@/lib/services/orchestration-runtime.service"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export async function GET(
  _request: NextRequest,
  context: { params: Promise<{ jobId: string }> }
) {
  const session = await auth()
  if (!session?.user?.email) {
    return NextResponse.json({ error: "Authentication required" }, { status: 401 })
  }

  const { jobId } = await context.params
  const user = await prisma.user.findUnique({
    where: { email: session.user.email },
    select: { id: true, isDeveloperAccount: true },
  })

  if (!user) {
    return NextResponse.json({ error: "Authenticated user not found" }, { status: 404 })
  }

  const job = await prisma.generationJob.findFirst({
    where: user.isDeveloperAccount ? { id: jobId } : { id: jobId, userId: user.id },
    select: { id: true },
  })

  if (!job) {
    return NextResponse.json({ error: "Generation job not found" }, { status: 404 })
  }

  const replay = await OrchestrationRuntimeService.replay(jobId)
  return NextResponse.json(replay, {
    headers: { "Cache-Control": "no-store" },
  })
}

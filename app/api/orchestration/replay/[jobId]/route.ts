import { NextRequest, NextResponse } from "next/server"
import { getSession } from "@/auth"
import { db } from "@/lib/db/client"
import { users, generationJobs } from "@/lib/db/schema"
import { eq, and } from "drizzle-orm"
import { OrchestrationRuntimeService } from "@/lib/services/orchestration-runtime.service"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export async function GET(
  _request: NextRequest,
  context: { params: Promise<{ jobId: string }> }
) {
  const session = await getSession()
  if (!session?.email) {
    return NextResponse.json({ error: "Authentication required" }, { status: 401 })
  }

  const { jobId } = await context.params
  const user = await db.query.users.findFirst({
    where: eq(users.email, session.email),
  })

  if (!user) {
    return NextResponse.json({ error: "Authenticated user not found" }, { status: 404 })
  }

  const job = await db.query.generationJobs.findFirst({
    where: user.isDeveloperAccount
      ? eq(generationJobs.id, jobId)
      : and(eq(generationJobs.id, jobId), eq(generationJobs.userId, user.id)),
  })

  if (!job) {
    return NextResponse.json({ error: "Generation job not found" }, { status: 404 })
  }

  const replay = await OrchestrationRuntimeService.replay(jobId)
  return NextResponse.json(replay, {
    headers: { "Cache-Control": "no-store" },
  })
}

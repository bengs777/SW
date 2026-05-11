import { NextRequest } from "next/server"
import { auth } from "@/auth"
import { prisma } from "@/lib/db/client"
import { GenerationJobService } from "@/lib/services/generation-job.service"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

const TERMINAL_STATUSES = new Set(["completed", "failed", "cancelled"])

export async function GET(
  _request: NextRequest,
  context: { params: Promise<{ jobId: string }> }
) {
  const session = await auth()
  const email = session?.user?.email

  if (!email) {
    return new Response("Authentication required", { status: 401 })
  }

  const { jobId } = await context.params
  const user = await prisma.user.findUnique({
    where: { email },
    select: { id: true },
  })

  if (!user) {
    return new Response("Authenticated user not found", { status: 404 })
  }

  const initialJob = await GenerationJobService.findForUser(jobId, user.id)
  if (!initialJob) {
    return new Response("Generation job not found", { status: 404 })
  }

  const encoder = new TextEncoder()
  let closed = false

  const stream = new ReadableStream({
    async start(controller) {
      const send = (event: string, data: unknown) => {
        if (closed) return
        controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`))
      }

      let lastUpdatedAt = ""

      const emitJob = async () => {
        const job = await GenerationJobService.findForUser(jobId, user.id)
        if (!job) {
          send("error", { error: "Generation job not found" })
          closed = true
          controller.close()
          return
        }

        const updatedAt = job.updatedAt.toISOString()
        if (updatedAt !== lastUpdatedAt) {
          lastUpdatedAt = updatedAt
          send("job", GenerationJobService.toPublicJob(job))
        } else {
          send("heartbeat", { updatedAt: new Date().toISOString() })
        }

        if (TERMINAL_STATUSES.has(job.status)) {
          closed = true
          controller.close()
        }
      }

      await emitJob()

      while (!closed) {
        await new Promise((resolve) => setTimeout(resolve, 1000))
        await emitJob()
      }
    },
    cancel() {
      closed = true
    },
  })

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  })
}


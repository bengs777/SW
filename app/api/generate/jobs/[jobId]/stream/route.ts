import { NextRequest } from "next/server"
import { auth } from "@/auth"
import { prisma } from "@/lib/db/client"
import { GenerationJobService, GENERATION_TERMINAL_STATUSES } from "@/lib/services/generation-job.service"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

const HEARTBEAT_MS = 15_000
const POLL_MS = 1_000
const IDLE_TIMEOUT_MS = 135_000
const MAX_RETRY_MS = 10_000

function parseLastEventSequence(request: NextRequest) {
  const headerValue = request.headers.get("last-event-id")
  const queryValue = request.nextUrl.searchParams.get("lastEventId")
  const raw = headerValue || queryValue || "0"
  const parsed = Number(raw)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0
}

function eventFrame(event: string, id: number | string, data: unknown, retryMs = MAX_RETRY_MS) {
  return `id: ${id}\nretry: ${retryMs}\nevent: ${event}\ndata: ${JSON.stringify(data)}\n\n`
}

function safeJsonParse(value: string | null) {
  if (!value) return null

  try {
    return JSON.parse(value)
  } catch {
    return null
  }
}

export async function GET(
  request: NextRequest,
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
  const startedAt = Date.now()
  const abortSignal = request.signal
  let closed = false
  let lastEventSequence = parseLastEventSequence(request)
  let lastSentAt = 0

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (event: string, id: number | string, data: unknown) => {
        if (closed) return
        controller.enqueue(encoder.encode(eventFrame(event, id, data)))
        if (event !== "heartbeat") {
          console.log("frontend_notified")
        }
        lastSentAt = Date.now()
      }

      const close = () => {
        if (closed) return
        closed = true
        controller.close()
      }

      abortSignal.addEventListener("abort", close, { once: true })

      send("job", lastEventSequence, GenerationJobService.toPublicJob(initialJob))

      while (!closed) {
        let events: Awaited<ReturnType<typeof GenerationJobService.listEvents>> = []
        try {
          events = await GenerationJobService.listEvents(jobId, lastEventSequence)
        } catch (error) {
          send("generation.stream_error", lastEventSequence, {
            message: error instanceof Error ? error.message : "Failed to read generation events",
          })
          close()
          return
        }

        for (const event of events) {
          lastEventSequence = event.sequence
          send(event.type, event.sequence, {
            id: event.id,
            type: event.type,
            stage: event.stage,
            status: event.status,
            message: event.message,
            createdAt: event.createdAt.toISOString(),
            data: safeJsonParse(event.dataJson),
          })
        }

        const freshJob = await GenerationJobService.findForUser(jobId, user.id).catch(() => null)
        if (!freshJob) {
          send("generation.failed", lastEventSequence, { message: "Generation job not found" })
          close()
          return
        }

        send("job", lastEventSequence, GenerationJobService.toPublicJob(freshJob))

        if (GENERATION_TERMINAL_STATUSES.has(freshJob.status)) {
          close()
          return
        }

        const now = Date.now()
        if (now - lastSentAt >= HEARTBEAT_MS) {
          send("heartbeat", lastEventSequence, {
            at: new Date(now).toISOString(),
            uptimeMs: now - startedAt,
          })
        }

        if (now - startedAt >= IDLE_TIMEOUT_MS) {
          send("timeout", lastEventSequence, {
            message: "SSE stream idle timeout reached. Reconnect with backoff.",
          })
          close()
          return
        }

        await new Promise((resolve) => setTimeout(resolve, POLL_MS))
      }
    },
    cancel() {
      closed = true
    },
  })

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  })
}

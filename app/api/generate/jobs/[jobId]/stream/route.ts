import { NextRequest } from "next/server"
import { auth } from "@/auth"
import { prisma } from "@/lib/db/client"
import { GenerationJobService, GENERATION_TERMINAL_STATUSES } from "@/lib/services/generation-job.service"
import { log } from "@/lib/logging"

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

function sleep(ms: number, signal: AbortSignal) {
  if (signal.aborted) {
    return Promise.reject(new DOMException("SSE sleep aborted", "AbortError"))
  }

  return new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      signal.removeEventListener("abort", abort)
      resolve()
    }, ms)
    const abort = () => {
      clearTimeout(timeout)
      signal.removeEventListener("abort", abort)
      reject(new DOMException("SSE sleep aborted", "AbortError"))
    }

    signal.addEventListener("abort", abort, { once: true })
  })
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
    select: { id: true, isDeveloperAccount: true },
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
  const developerDiagnosticsAllowed = Boolean(user.isDeveloperAccount || process.env.NODE_ENV !== "production")

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      log("info", "stream_connected", {
        event: "stream_connected",
        jobId,
        userId: user.id,
        lastEventSequence,
        developerDiagnosticsAllowed,
      })
      const send = (event: string, id: number | string, data: unknown) => {
        if (closed) return
        controller.enqueue(encoder.encode(eventFrame(event, id, data)))
        if (event !== "heartbeat") {
          console.log("frontend_notified")
          log("info", "frontend_notified", {
            event: "frontend_notified",
            jobId,
            userId: user.id,
            streamEvent: event,
            eventId: id,
          })
        }
        lastSentAt = Date.now()
      }

      const close = async (reason = "stream_closed") => {
        if (closed) return
        closed = true
        console.log("sse_closed")
        log("info", "stream_terminated", {
          event: "stream_terminated",
          jobId,
          userId: user.id,
          reason,
          uptimeMs: Date.now() - startedAt,
          lastEventSequence,
        })
        await GenerationJobService.appendEvent({
          jobId,
          type: "stream_terminated",
          stage: "completed",
          status: "running",
          message: reason,
          data: {
            event: "stream_terminated",
            reason,
            uptimeMs: Date.now() - startedAt,
            lastEventSequence,
          },
        }).catch(() => null)
        try {
          controller.close()
        } catch {
          // Stream may already be closed by the runtime.
        }
      }

      abortSignal.addEventListener("abort", () => {
        log("warn", "stream_aborted", {
          event: "stream_aborted",
          jobId,
          userId: user.id,
          uptimeMs: Date.now() - startedAt,
          lastEventSequence,
        })
        void close("stream_aborted")
      }, { once: true })

      send("job", lastEventSequence, GenerationJobService.toPublicJob(initialJob))
      log("info", "frontend_listener_attached", {
        event: "frontend_listener_attached",
        jobId,
        userId: user.id,
        lastEventSequence,
      })
      if (developerDiagnosticsAllowed) {
        send("developer.diagnostics", `${lastEventSequence}:diagnostics`, GenerationJobService.toDeveloperDiagnostics(initialJob))
      }

      while (!closed) {
        let events: Awaited<ReturnType<typeof GenerationJobService.listEvents>> = []
        try {
          events = await GenerationJobService.listEvents(jobId, lastEventSequence)
        } catch (error) {
          send("generation.stream_error", lastEventSequence, {
            message: error instanceof Error ? error.message : "Failed to read generation events",
          })
          await close("stream_event_read_failed")
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
          await close("job_not_found")
          return
        }

        send("job", lastEventSequence, GenerationJobService.toPublicJob(freshJob))
        if (developerDiagnosticsAllowed) {
          send("developer.diagnostics", `${lastEventSequence}:diagnostics`, GenerationJobService.toDeveloperDiagnostics(freshJob))
        }

        if (GENERATION_TERMINAL_STATUSES.has(freshJob.status)) {
          await close(`job_${freshJob.status}`)
          return
        }

        const now = Date.now()
        if (now - lastSentAt >= HEARTBEAT_MS) {
          log("info", "sse_heartbeat", {
            event: "sse_heartbeat",
            jobId,
            userId: user.id,
            uptimeMs: now - startedAt,
            lastEventSequence,
          })
          send("heartbeat", lastEventSequence, {
            at: new Date(now).toISOString(),
            uptimeMs: now - startedAt,
          })
        }

        if (now - startedAt >= IDLE_TIMEOUT_MS) {
          send("timeout", lastEventSequence, {
            message: "SSE stream idle timeout reached. Reconnect with backoff.",
          })
          await close("stream_idle_timeout")
          return
        }

        try {
          await sleep(POLL_MS, abortSignal)
        } catch (error) {
          if (error instanceof Error && error.name === "AbortError") {
            await close("stream_aborted")
            return
          }
          throw error
        }
      }
    },
    cancel() {
      closed = true
      log("info", "stream_disconnected", {
        event: "stream_disconnected",
        jobId,
        userId: user.id,
        uptimeMs: Date.now() - startedAt,
        lastEventSequence,
      })
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

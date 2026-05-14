import { NextRequest } from "next/server"
import { auth } from "@/auth"
import { prisma } from "@/lib/db/client"
import { GenerationJobService, GENERATION_TERMINAL_STATUSES } from "@/lib/services/generation-job.service"
import { log } from "@/lib/logging"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"
// RELIABILITY: bound the lambda duration. Without this, a stuck consumer keeps
// the lambda billing forever. 60s aligns with Vercel hobby; clients reconnect
// via EventSource native retry semantics.
export const maxDuration = 60

const HEARTBEAT_MS = 15_000
// Adaptive polling: tight when there's recent activity, loose when idle.
const POLL_FAST_MS = 750
const POLL_SLOW_MS = 3_000
const FAST_POLL_WINDOW_MS = 5_000
// Stream max lifetime — must be < maxDuration to give us time to send a
// graceful timeout event. EventSource will auto-reconnect with last-event-id.
const STREAM_MAX_MS = 50_000
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
  const correlationId = request.headers.get("x-request-id") || jobId

  let closed = false
  let lastEventSequence = parseLastEventSequence(request)
  let lastSentAt = Date.now() // initialize to now so heartbeat fires after HEARTBEAT_MS, not immediately
  let lastActivityAt = Date.now()
  let pollDelayTimer: NodeJS.Timeout | null = null

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (event: string, id: number | string, data: unknown) => {
        if (closed) return
        try {
          controller.enqueue(encoder.encode(eventFrame(event, id, data)))
          lastSentAt = Date.now()
        } catch {
          // Consumer disconnected mid-write — close gracefully.
          closeStream()
        }
      }

      const closeStream = () => {
        if (closed) return
        closed = true
        if (pollDelayTimer) {
          clearTimeout(pollDelayTimer)
          pollDelayTimer = null
        }
        try {
          controller.close()
        } catch {
          /* already closed */
        }
      }

      // Cleanup on client disconnect — EventSource cancel, navigation, browser close.
      const onAbort = () => {
        log("info", "sse_stream_aborted", {
          jobId,
          correlationId,
          uptimeMs: Date.now() - startedAt,
          reason: "client_abort",
        })
        closeStream()
      }
      abortSignal.addEventListener("abort", onAbort, { once: true })

      send("job", lastEventSequence, GenerationJobService.toPublicJob(initialJob))

      try {
        while (!closed) {
          // Bail out if client disconnected (defense-in-depth — abort listener
          // also handles this).
          if (abortSignal.aborted) {
            closeStream()
            return
          }

          let events: Awaited<ReturnType<typeof GenerationJobService.listEvents>> = []
          try {
            events = await GenerationJobService.listEvents(jobId, lastEventSequence)
          } catch (error) {
            log("error", "sse_stream_db_read_failed", {
              jobId,
              correlationId,
              error: error instanceof Error ? error.message : String(error),
            })
            send("generation.stream_error", lastEventSequence, {
              message: "Failed to read generation events. Reconnect with lastEventId.",
            })
            closeStream()
            return
          }

          if (events.length > 0) {
            lastActivityAt = Date.now()
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
          }

          const freshJob = await GenerationJobService.findForUser(jobId, user.id).catch(
            () => null
          )
          if (!freshJob) {
            send("generation.failed", lastEventSequence, {
              message: "Generation job not found",
            })
            closeStream()
            return
          }

          send("job", lastEventSequence, GenerationJobService.toPublicJob(freshJob))

          if (GENERATION_TERMINAL_STATUSES.has(freshJob.status)) {
            log("info", "sse_stream_terminal", {
              jobId,
              correlationId,
              terminalStatus: freshJob.status,
              uptimeMs: Date.now() - startedAt,
            })
            closeStream()
            return
          }

          const now = Date.now()
          if (now - lastSentAt >= HEARTBEAT_MS) {
            send("heartbeat", lastEventSequence, {
              at: new Date(now).toISOString(),
              uptimeMs: now - startedAt,
            })
          }

          // Stream max lifetime guard. Send a graceful timeout event so the
          // EventSource client reconnects with last-event-id rather than a 504.
          if (now - startedAt >= STREAM_MAX_MS) {
            send("timeout", lastEventSequence, {
              message: "SSE stream lifetime reached. Reconnect with lastEventId.",
              reconnectAfterMs: 1_000,
            })
            log("info", "sse_stream_lifetime_reached", {
              jobId,
              correlationId,
              uptimeMs: now - startedAt,
            })
            closeStream()
            return
          }

          // Adaptive polling: poll fast right after activity, slow during idle.
          // Reduces DB load during long-running steady-state generations.
          const idleMs = now - lastActivityAt
          const nextDelay = idleMs < FAST_POLL_WINDOW_MS ? POLL_FAST_MS : POLL_SLOW_MS

          await new Promise<void>((resolve) => {
            pollDelayTimer = setTimeout(() => {
              pollDelayTimer = null
              resolve()
            }, nextDelay)
            if (pollDelayTimer.unref) pollDelayTimer.unref()
          })
        }
      } finally {
        // Belt-and-suspenders cleanup
        abortSignal.removeEventListener("abort", onAbort)
        if (pollDelayTimer) {
          clearTimeout(pollDelayTimer)
          pollDelayTimer = null
        }
      }
    },
    cancel() {
      closed = true
      if (pollDelayTimer) {
        clearTimeout(pollDelayTimer)
        pollDelayTimer = null
      }
    },
  })

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
      "X-Request-Id": correlationId,
    },
  })
}

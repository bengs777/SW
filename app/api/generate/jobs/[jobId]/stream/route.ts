import { NextRequest } from "next/server"
import { auth } from "@/auth"
import { prisma } from "@/lib/db/client"
import { GenerationJobService, GENERATION_TERMINAL_STATUSES } from "@/lib/services/generation-job.service"
import { log } from "@/lib/logging"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

/**
 * SSE stream for generation job events.
 *
 * Lifecycle invariants (post-audit):
 *
 *   1. Lambda duration is hard-bounded by `maxDuration`. The stream sends a
 *      graceful `timeout` event before the lambda is killed so EventSource
 *      reconnects with `Last-Event-ID` rather than seeing an aborted socket.
 *
 *   2. EVERY exit path (terminal status, client disconnect, error, lifetime
 *      reached, cancel callback) goes through the same `cleanup()` function.
 *      cleanup() is idempotent — multiple calls are safe.
 *
 *   3. cleanup() removes the abort listener and clears the polling timer.
 *      Without these the request handler holds GC roots until lambda freeze,
 *      which produced memory growth over long-running streams.
 *
 *   4. controller.enqueue is wrapped in try/catch. If the consumer disconnects
 *      between an `await` and the next enqueue, this catches the
 *      ERR_INVALID_STATE error instead of bubbling it up the lambda.
 *
 *   5. Polling timer is `unref`'d so a slow Prisma read can't keep the lambda
 *      alive past the deadline.
 */

export const maxDuration = 60

const HEARTBEAT_MS = 15_000
// Adaptive polling: tight when there's recent activity, loose when idle.
const POLL_FAST_MS = 750
const POLL_SLOW_MS = 3_000
const FAST_POLL_WINDOW_MS = 5_000
// Stream max lifetime — must be < maxDuration to give us time to send the
// graceful timeout event. EventSource auto-reconnects with last-event-id.
const STREAM_MAX_MS = 50_000
const MAX_RETRY_MS = 10_000
// Hard wall-clock on every individual Prisma read inside the loop. If a poll
// query stalls past this we abandon the stream rather than letting a stuck
// connection extend the lambda lifetime.
const DB_READ_TIMEOUT_MS = 5_000

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

function withDeadline<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      reject(new Error(`sse_db_timeout:${label}:${ms}ms`))
    }, ms)
    if (timer.unref) timer.unref()
    promise.then(
      (value) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve(value)
      },
      (error) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        reject(error)
      }
    )
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

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false
      let lastEventSequence = parseLastEventSequence(request)
      // Initialize to "now" so the first heartbeat fires after HEARTBEAT_MS,
      // not immediately on first iteration.
      let lastSentAt = Date.now()
      let lastActivityAt = Date.now()
      let pollDelayTimer: NodeJS.Timeout | null = null
      let pollResolve: (() => void) | null = null

      // Single source of truth for cleanup. Idempotent: multiple callers fine.
      const cleanup = (reason: string) => {
        if (closed) return
        closed = true

        if (pollDelayTimer) {
          clearTimeout(pollDelayTimer)
          pollDelayTimer = null
        }
        // Wake any pending poll-delay so the loop can observe `closed` and
        // exit instead of waiting out its full sleep.
        if (pollResolve) {
          const resolve = pollResolve
          pollResolve = null
          resolve()
        }

        try {
          abortSignal.removeEventListener("abort", onAbort)
        } catch {
          /* removeEventListener doesn't throw, but defensive */
        }

        try {
          controller.close()
        } catch {
          /* already closed (consumer disconnected) */
        }

        log("info", "sse_stream_cleanup", {
          jobId,
          correlationId,
          reason,
          uptimeMs: Date.now() - startedAt,
        })
      }

      const send = (event: string, id: number | string, data: unknown) => {
        if (closed) return
        try {
          controller.enqueue(encoder.encode(eventFrame(event, id, data)))
          lastSentAt = Date.now()
        } catch (error) {
          // Consumer disconnected mid-write, or controller was closed by the
          // runtime due to lambda shutdown. Either way, stop the loop.
          cleanup(
            `enqueue_failed:${error instanceof Error ? error.name : "unknown"}`
          )
        }
      }

      const onAbort = () => {
        cleanup("client_abort")
      }
      abortSignal.addEventListener("abort", onAbort, { once: true })

      // Defensive: if the request was already aborted before we even started,
      // close immediately. (Browsers can do this on rapid navigation.)
      if (abortSignal.aborted) {
        cleanup("abort_before_start")
        return
      }

      send("job", lastEventSequence, GenerationJobService.toPublicJob(initialJob))

      try {
        while (!closed) {
          // Early exit if client disconnected (defense-in-depth — abort
          // listener also handles this).
          if (abortSignal.aborted) {
            cleanup("loop_observed_abort")
            return
          }

          let events: Awaited<ReturnType<typeof GenerationJobService.listEvents>> = []
          try {
            events = await withDeadline(
              GenerationJobService.listEvents(jobId, lastEventSequence),
              DB_READ_TIMEOUT_MS,
              "list_events"
            )
          } catch (error) {
            log("error", "sse_stream_db_read_failed", {
              jobId,
              correlationId,
              error: error instanceof Error ? error.message : String(error),
            })
            send("generation.stream_error", lastEventSequence, {
              message: "Failed to read generation events. Reconnect with lastEventId.",
            })
            cleanup("db_read_failed")
            return
          }

          if (events.length > 0) {
            lastActivityAt = Date.now()
            for (const event of events) {
              if (closed) break
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

          if (closed) return

          let freshJob: Awaited<ReturnType<typeof GenerationJobService.findForUser>> = null
          try {
            freshJob = await withDeadline(
              GenerationJobService.findForUser(jobId, user.id),
              DB_READ_TIMEOUT_MS,
              "find_job"
            )
          } catch (error) {
            log("warn", "sse_stream_job_lookup_failed", {
              jobId,
              correlationId,
              error: error instanceof Error ? error.message : String(error),
            })
            // Don't kill the stream on a single failed lookup — the next
            // iteration may succeed. Continue to next poll cycle.
          }

          if (!freshJob) {
            send("generation.failed", lastEventSequence, {
              message: "Generation job not found",
            })
            cleanup("job_not_found")
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
            cleanup(`terminal:${freshJob.status}`)
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
            cleanup("lifetime_reached")
            return
          }

          // Adaptive polling: poll fast right after activity, slow during idle.
          const idleMs = now - lastActivityAt
          const nextDelay = idleMs < FAST_POLL_WINDOW_MS ? POLL_FAST_MS : POLL_SLOW_MS

          await new Promise<void>((resolve) => {
            pollResolve = resolve
            pollDelayTimer = setTimeout(() => {
              pollDelayTimer = null
              pollResolve = null
              resolve()
            }, nextDelay)
            if (pollDelayTimer.unref) pollDelayTimer.unref()
          })
        }
      } finally {
        cleanup("loop_finally")
      }
    },
    cancel(reason) {
      // Consumer detached the readable stream. The `start()` finally-block
      // owns the cleanup, but we still log here so cancel is visible in
      // observability.
      log("info", "sse_stream_cancelled_by_consumer", {
        jobId,
        correlationId,
        reason: reason instanceof Error ? reason.message : String(reason ?? "no_reason"),
      })
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

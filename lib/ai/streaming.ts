type SseEvent = {
  event: string
  data?: Record<string, unknown>
}

export type SwiftSseStream = {
  response: Response
  send: (event: SseEvent) => void
  close: () => void
  signal: AbortSignal
}

const encoder = new TextEncoder()

export function createSwiftSseStream(options?: { timeoutMs?: number; heartbeatMs?: number }): SwiftSseStream {
  const abortController = new AbortController()
  let streamController: ReadableStreamDefaultController<Uint8Array> | null = null
  let closed = false
  const timeoutMs = options?.timeoutMs ?? 120_000
  const heartbeatMs = options?.heartbeatMs ?? 15_000

  const timeout = setTimeout(() => abortController.abort(), timeoutMs)
  const heartbeat = setInterval(() => {
    write({ event: "generation.heartbeat", data: { at: new Date().toISOString() } })
  }, heartbeatMs)

  function write(input: SseEvent) {
    if (closed || !streamController) return
    const data = JSON.stringify(input.data || {})
    streamController.enqueue(encoder.encode(`event: ${input.event}\ndata: ${data}\n\n`))
  }

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      streamController = controller
    },
    cancel() {
      close()
      abortController.abort()
    },
  })

  function close() {
    if (closed) return
    closed = true
    clearTimeout(timeout)
    clearInterval(heartbeat)
    streamController?.close()
    streamController = null
  }

  abortController.signal.addEventListener("abort", () => {
    write({ event: "generation.failed", data: { message: "Swift request timed out." } })
    close()
  }, { once: true })

  return {
    response: new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      },
    }),
    send: write,
    close,
    signal: abortController.signal,
  }
}

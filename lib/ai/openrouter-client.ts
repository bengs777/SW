import { env } from "@/lib/env"
import { SwiftAiCancelledError, SwiftAiError, SwiftAiTimeoutError, reasonFromStatus, redactAiSecret } from "@/lib/ai/errors"
import { getAgentForUrl } from "@/lib/ai/connection-pool"
import { log } from "@/lib/logging"

type ChatMessage = {
  role: "system" | "user" | "assistant"
  content: string
}

type OpenRouterCompletionInput = {
  model: string
  messages: ChatMessage[]
  temperature?: number
  topP?: number
  maxTokens: number
  responseFormat?: "json_object"
  timeoutMs: number
  signal?: AbortSignal
  lifecycle?: (event: OpenRouterLifecycleEvent) => void
}

type OpenRouterCompletionResult = {
  message: string
  requestId?: string | null
  tokenUsage?: {
    promptTokens?: number
    completionTokens?: number
    totalTokens?: number
  }
}

type OpenRouterStreamPayload = {
  error?: {
    message?: string
  } | string
  choices?: Array<{
    delta?: {
      content?: string
    }
    message?: {
      content?: string
    }
  }>
}

export type OpenRouterStreamEvent =
  | { type: "delta"; delta: string }
  | { type: "done"; requestId?: string | null; tokenUsage?: OpenRouterCompletionResult["tokenUsage"] }

export type OpenRouterLifecycleEvent = {
  event:
    | "request_started"
    | "request_stream_started"
    | "chunk_received"
    | "first_token_received"
    | "token_received"
    | "stream_closed"
    | "stream_error"
    | "request_completed"
    | "request_timeout"
    | "request_cancelled"
    | "request_failed"
  provider: "openrouter"
  model: string
  at: string
  latencyMs: number
  requestId?: string | null
  detail?: Record<string, unknown>
}

function positiveEnvMs(keys: string[], fallbackMs: number) {
  for (const key of keys) {
    const value = Number(process.env[key])
    if (Number.isFinite(value) && value > 0) return Math.round(value)
  }
  return fallbackMs
}

const PROVIDER_HARD_TIMEOUT_MS = positiveEnvMs(
  ["OPENROUTER_HARD_TIMEOUT_MS", "AI_PROVIDER_REQUEST_BUDGET_MS"],
  180_000
)
const STREAM_TOKEN_WATCHDOG_MS = positiveEnvMs(
  ["OPENROUTER_STREAM_IDLE_TIMEOUT_MS", "OPENROUTER_STREAM_TOKEN_WATCHDOG_MS"],
  60_000
)

export function getOpenRouterBaseUrl() {
  return (env.openRouterBaseUrl || "https://openrouter.ai/api/v1").replace(/\/+$/, "")
}

export function assertOpenRouterConfigured() {
  if (!env.openRouterApiKey) {
    throw new SwiftAiError("OPENROUTER_API_KEY is not configured", { reason: "config" })
  }
}

export function buildOpenRouterHeaders() {
  assertOpenRouterConfigured()

  const headers: Record<string, string> = {
    Authorization: `Bearer ${env.openRouterApiKey}`,
    "Content-Type": "application/json",
    "HTTP-Referer": env.openRouterSiteUrl || env.appUrl || "https://swift.biz.id",
    "X-Title": env.openRouterAppName || "Swift AI",
  }

  if (/openrouter\.ai/i.test(getOpenRouterBaseUrl())) {
    headers["X-OpenRouter-Cache"] = "true"
    headers["X-OpenRouter-Cache-TTL"] = "300"
  }

  return headers
}

function createRequestRuntime(input: OpenRouterCompletionInput, stream: boolean) {
  const startedAt = Date.now()
  const controller = new AbortController()
  const requestTimeoutMs = Math.min(Math.max(1, input.timeoutMs), PROVIDER_HARD_TIMEOUT_MS)
  let requestTimedOut = false
  let streamTimedOut = false
  let cancelled = false
  let streamWatchdog: ReturnType<typeof setTimeout> | null = null

  const emit = (event: OpenRouterLifecycleEvent["event"], detail?: Record<string, unknown>, requestId?: string | null) => {
    const payload: OpenRouterLifecycleEvent = {
      event,
      provider: "openrouter",
      model: input.model,
      at: new Date().toISOString(),
      latencyMs: Date.now() - startedAt,
      requestId,
      detail,
    }
    input.lifecycle?.(payload)
    log(event === "request_failed" || event === "request_timeout" ? "warn" : "info", event, payload)
  }

  const requestTimeout = setTimeout(() => {
    requestTimedOut = true
    emit("request_timeout", { timeoutType: "provider", timeoutMs: requestTimeoutMs })
    controller.abort()
  }, requestTimeoutMs)

  const upstreamAbort = () => {
    cancelled = true
    emit("request_cancelled", { source: "upstream_signal" })
    controller.abort()
  }

  if (input.signal) {
    if (input.signal.aborted) {
      upstreamAbort()
    } else {
      input.signal.addEventListener("abort", upstreamAbort, { once: true })
    }
  }

  const resetStreamWatchdog = (requestId?: string | null, detail?: Record<string, unknown>) => {
    if (!stream) return
    if (streamWatchdog) clearTimeout(streamWatchdog)
    streamWatchdog = setTimeout(() => {
      streamTimedOut = true
      emit(
        "request_timeout",
        { timeoutType: "stream_no_token", timeoutMs: STREAM_TOKEN_WATCHDOG_MS, ...detail },
        requestId
      )
      controller.abort()
    }, STREAM_TOKEN_WATCHDOG_MS)
  }

  const clearStreamWatchdog = () => {
    if (streamWatchdog) clearTimeout(streamWatchdog)
    streamWatchdog = null
  }

  const cleanup = () => {
    clearTimeout(requestTimeout)
    clearStreamWatchdog()
    input.signal?.removeEventListener("abort", upstreamAbort)
  }

  const normalizeAbort = (error: unknown) => {
    if (error instanceof SwiftAiError) return error
    if (error instanceof Error && error.name === "AbortError") {
      if (cancelled) return new SwiftAiCancelledError(input.model)
      return new SwiftAiTimeoutError(streamTimedOut ? STREAM_TOKEN_WATCHDOG_MS : requestTimeoutMs, input.model)
    }
    return error
  }

  return {
    signal: controller.signal,
    emit,
    resetStreamWatchdog,
    clearStreamWatchdog,
    cleanup,
    normalizeAbort,
    didTimeout: () => requestTimedOut || streamTimedOut,
  }
}

export async function createOpenRouterChatCompletion(
  input: OpenRouterCompletionInput
): Promise<OpenRouterCompletionResult> {
  const runtime = createRequestRuntime(input, false)
  runtime.emit("request_started", { stream: false, timeoutMs: Math.min(input.timeoutMs, PROVIDER_HARD_TIMEOUT_MS) })

  try {
    const response = await fetchOpenRouter(input, false, runtime.signal)
    const requestId = response.headers.get("x-request-id")
    runtime.emit("request_stream_started", { stream: false }, requestId)
    const data = await response.json()
    const message = data.choices?.[0]?.message?.content || ""

    if (!String(message).trim()) {
      throw new SwiftAiError("AI gateway returned an empty response", {
        reason: "empty_response",
        requestId,
        internalModelId: input.model,
      })
    }

    runtime.emit("first_token_received", { stream: false }, requestId)
    runtime.emit("request_completed", {
      promptTokens: data.usage?.prompt_tokens,
      completionTokens: data.usage?.completion_tokens,
      totalTokens: data.usage?.total_tokens,
    }, requestId)

    return {
      message,
      requestId,
      tokenUsage: {
        promptTokens: data.usage?.prompt_tokens,
        completionTokens: data.usage?.completion_tokens,
        totalTokens: data.usage?.total_tokens,
      },
    }
  } catch (error) {
    const normalized = runtime.normalizeAbort(error)
    const swiftError =
      normalized instanceof SwiftAiError
        ? normalized
        : new SwiftAiError(normalized instanceof Error ? redactAiSecret(normalized.message) : "Network error", {
            reason: "network",
            internalModelId: input.model,
          })
    if (swiftError.reason !== "cancelled") {
      runtime.emit("request_failed", {
        reason: swiftError.reason,
        statusCode: swiftError.statusCode,
        message: redactAiSecret(swiftError.message),
      }, swiftError.requestId)
    }
    throw swiftError
  } finally {
    runtime.cleanup()
  }
}

export async function* streamOpenRouterChatCompletion(
  input: OpenRouterCompletionInput
): AsyncGenerator<OpenRouterStreamEvent> {
  const runtime = createRequestRuntime(input, true)
  runtime.emit("request_started", { stream: true, timeoutMs: Math.min(input.timeoutMs, PROVIDER_HARD_TIMEOUT_MS) })
  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null
  let requestId: string | null = null
  let streamFinished = false

  try {
    const response = await fetchOpenRouter(input, true, runtime.signal)
    requestId = response.headers.get("x-request-id")
    reader = response.body?.getReader() || null

    if (!reader) {
      throw new SwiftAiError("AI gateway stream body is empty", {
        reason: "empty_response",
        requestId,
        internalModelId: input.model,
      })
    }

    runtime.emit("request_stream_started", { stream: true }, requestId)
    runtime.resetStreamWatchdog(requestId, { phase: "awaiting_first_token" })

    const decoder = new TextDecoder()
    const parser = createSseParser()
    let firstTokenSeen = false
    let chunkCount = 0
    let tokenCount = 0
    let doneSeen = false

    while (true) {
      const { done, value } = await readStreamChunk(reader, runtime.signal)
      if (done) break

      chunkCount += 1
      const decodedChunk = decoder.decode(value, { stream: true })
      runtime.emit("chunk_received", {
        stream: true,
        chunkBytes: value.byteLength,
        chunkCount,
        rawChunkText: decodedChunk,
      }, requestId)

      const events = parser.push(decodedChunk)
      for (const event of events) {
        const payload = event.data.trim()
        if (!payload) continue
        if (payload === "[DONE]") {
          doneSeen = true
          break
        }

        let parsed: OpenRouterStreamPayload
        try {
          parsed = JSON.parse(payload)
        } catch {
          throw new SwiftAiError("AI gateway returned malformed stream event JSON", {
            reason: "invalid_output",
            requestId,
            internalModelId: input.model,
          })
        }

        if (parsed.error) {
          const errorMessage = typeof parsed.error === "string" ? parsed.error : parsed.error.message
          throw new SwiftAiError(`AI gateway stream error: ${redactAiSecret(errorMessage || "Unknown error")}`, {
            reason: "server_error",
            requestId,
            internalModelId: input.model,
          })
        }

        const delta = parsed.choices?.[0]?.delta?.content || parsed.choices?.[0]?.message?.content || ""
        if (delta) {
          tokenCount += 1
          if (!firstTokenSeen) {
            firstTokenSeen = true
            runtime.emit("first_token_received", { stream: true }, requestId)
          }
          runtime.emit("token_received", { stream: true, tokenCount, deltaChars: delta.length, delta }, requestId)
          runtime.resetStreamWatchdog(requestId, { phase: "awaiting_next_token", tokenCount })
          yield { type: "delta", delta }
        }
      }

      if (doneSeen) break
    }

    const remainingEvents = parser.flush(decoder.decode())
    for (const event of remainingEvents) {
      const payload = event.data.trim()
      if (!payload || payload === "[DONE]") continue
      const parsed = JSON.parse(payload)
      const delta = parsed.choices?.[0]?.delta?.content || parsed.choices?.[0]?.message?.content || ""
      if (!delta) continue
      tokenCount += 1
      if (!firstTokenSeen) {
        firstTokenSeen = true
        runtime.emit("first_token_received", { stream: true }, requestId)
      }
      runtime.emit("token_received", { stream: true, tokenCount, deltaChars: delta.length, delta }, requestId)
      yield { type: "delta", delta }
    }

    runtime.clearStreamWatchdog()
    streamFinished = true
    runtime.emit("stream_closed", { stream: true, chunkCount, tokenCount, doneSeen }, requestId)
    runtime.emit("request_completed", { stream: true, tokenCount }, requestId)
    yield { type: "done", requestId: response.headers.get("x-request-id") }
  } catch (error) {
    const normalized = runtime.normalizeAbort(error)
    const swiftError =
      normalized instanceof SwiftAiError
        ? normalized
        : new SwiftAiError(normalized instanceof Error ? redactAiSecret(normalized.message) : "Network error", {
            reason: "network",
            internalModelId: input.model,
          })
    if (swiftError.reason !== "cancelled") {
      runtime.emit("stream_error", {
        reason: swiftError.reason,
        statusCode: swiftError.statusCode,
        message: redactAiSecret(swiftError.message),
      }, swiftError.requestId || requestId)
      runtime.emit("request_failed", {
        reason: swiftError.reason,
        statusCode: swiftError.statusCode,
        message: redactAiSecret(swiftError.message),
      }, swiftError.requestId || requestId)
    }
    throw swiftError
  } finally {
    runtime.clearStreamWatchdog()
    if (reader) {
      if (runtime.signal.aborted || !streamFinished) {
        await reader.cancel().catch(() => null)
      }
      reader.releaseLock()
    }
    runtime.cleanup()
  }
}

function readStreamChunk(reader: ReadableStreamDefaultReader<Uint8Array>, signal: AbortSignal) {
  if (signal.aborted) {
    return Promise.reject(new DOMException("Stream read aborted", "AbortError"))
  }

  return new Promise<ReadableStreamReadResult<Uint8Array>>((resolve, reject) => {
    const abort = () => {
      reject(new DOMException("Stream read aborted", "AbortError"))
    }

    signal.addEventListener("abort", abort, { once: true })
    reader.read().then(
      (result) => {
        signal.removeEventListener("abort", abort)
        resolve(result)
      },
      (error) => {
        signal.removeEventListener("abort", abort)
        reject(error)
      }
    )
  })
}

type ParsedSseEvent = {
  event?: string
  data: string
}

function createSseParser() {
  let buffer = ""

  const parse = (text: string, flush: boolean) => {
    buffer += text
    const events: ParsedSseEvent[] = []

    while (true) {
      const match = buffer.match(/\r?\n\r?\n/)
      if (!match) break
      const raw = buffer.slice(0, match.index)
      buffer = buffer.slice((match.index || 0) + match[0].length)
      const event = parseSseEvent(raw)
      if (event) events.push(event)
    }

    if (flush && buffer.trim()) {
      const event = parseSseEvent(buffer)
      buffer = ""
      if (event) events.push(event)
    }

    return events
  }

  return {
    push: (text: string) => parse(text, false),
    flush: (text = "") => parse(text, true),
  }
}

function parseSseEvent(raw: string): ParsedSseEvent | null {
  const data: string[] = []
  let event: string | undefined

  for (const line of raw.split(/\r?\n/)) {
    if (!line || line.startsWith(":")) continue
    const separatorIndex = line.indexOf(":")
    const field = separatorIndex === -1 ? line : line.slice(0, separatorIndex)
    let value = separatorIndex === -1 ? "" : line.slice(separatorIndex + 1)
    if (value.startsWith(" ")) value = value.slice(1)
    if (field === "event") event = value
    if (field === "data") data.push(value)
  }

  if (data.length === 0) return null
  return { event, data: data.join("\n") }
}

async function fetchOpenRouter(input: OpenRouterCompletionInput, stream: boolean, signal: AbortSignal) {
  try {
    const url = `${getOpenRouterBaseUrl()}/chat/completions`
    log("info", "openrouter_request_created", {
      provider: "openrouter",
      model: input.model,
      stream,
      maxTokens: input.maxTokens,
    })
    // Keep-alive agent for connection reuse — reduces TCP/TLS handshake overhead.
    // Note: undici (default Node 18+ fetch) ignores the agent option and uses
    // its own pool. We pass it anyway for older runtimes / future compatibility.
    const agent = getAgentForUrl(url)
    const response = await fetch(url, {
      method: "POST",
      headers: buildOpenRouterHeaders(),
      signal,
      // @ts-expect-error - agent is honored by node-fetch / older runtimes; ignored by undici
      agent,
      body: JSON.stringify({
        model: input.model,
        messages: input.messages,
        temperature: input.temperature ?? 0.2,
        top_p: input.topP ?? 0.9,
        max_tokens: input.maxTokens,
        stream,
        ...(input.responseFormat ? { response_format: { type: input.responseFormat } } : {}),
      }),
    })

    if (!response.ok) {
      throw await errorFromOpenRouterResponse(response, input.model)
    }

    return response
  } catch (error) {
    if (error instanceof SwiftAiError) throw error

    if (error instanceof Error && error.name === "AbortError") {
      throw error
    }

    throw new SwiftAiError(error instanceof Error ? redactAiSecret(error.message) : "Network error", {
      reason: "network",
      internalModelId: input.model,
    })
  }
}

async function errorFromOpenRouterResponse(response: Response, internalModelId: string) {
  const text = await response.text().catch(() => "")
  let message = text

  try {
    const parsed = JSON.parse(text)
    message = parsed.error?.message || parsed.message || text
  } catch {
    // keep text body
  }

  return new SwiftAiError(`AI gateway API error (${response.status}): ${redactAiSecret(message)}`.trim(), {
    reason: reasonFromStatus(response.status),
    statusCode: response.status,
    requestId: response.headers.get("x-request-id"),
    internalModelId,
  })
}

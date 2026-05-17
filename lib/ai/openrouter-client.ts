import { env } from "@/lib/env"
import { SwiftAiError, SwiftAiTimeoutError, reasonFromStatus, redactAiSecret } from "@/lib/ai/errors"
import { getAgentForUrl } from "@/lib/ai/connection-pool"

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

export type OpenRouterStreamEvent =
  | { type: "delta"; delta: string }
  | { type: "done"; requestId?: string | null; tokenUsage?: OpenRouterCompletionResult["tokenUsage"] }

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

  return {
    Authorization: `Bearer ${env.openRouterApiKey}`,
    "Content-Type": "application/json",
    "HTTP-Referer": env.openRouterSiteUrl || env.appUrl || "https://swift.biz.id",
    "X-Title": env.openRouterAppName || "Swift AI",
    "X-OpenRouter-Cache": "true",
    "X-OpenRouter-Cache-TTL": "300",
  }
}

export async function createOpenRouterChatCompletion(
  input: OpenRouterCompletionInput
): Promise<OpenRouterCompletionResult> {
  const response = await fetchOpenRouter(input, false)
  const data = await response.json()
  const message = data.choices?.[0]?.message?.content || ""

  if (!String(message).trim()) {
    throw new SwiftAiError("OpenRouter returned an empty response", {
      reason: "empty_response",
      requestId: response.headers.get("x-request-id"),
      internalModelId: input.model,
    })
  }

  return {
    message,
    requestId: response.headers.get("x-request-id"),
    tokenUsage: {
      promptTokens: data.usage?.prompt_tokens,
      completionTokens: data.usage?.completion_tokens,
      totalTokens: data.usage?.total_tokens,
    },
  }
}

export async function* streamOpenRouterChatCompletion(
  input: OpenRouterCompletionInput
): AsyncGenerator<OpenRouterStreamEvent> {
  const response = await fetchOpenRouter(input, true)
  const reader = response.body?.getReader()

  if (!reader) {
    throw new SwiftAiError("OpenRouter stream body is empty", {
      reason: "empty_response",
      requestId: response.headers.get("x-request-id"),
      internalModelId: input.model,
    })
  }

  const decoder = new TextDecoder()
  let buffer = ""

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break

      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split(/\r?\n/)
      buffer = lines.pop() || ""

      for (const line of lines) {
        const trimmed = line.trim()
        if (!trimmed.startsWith("data:")) continue
        const payload = trimmed.slice(5).trim()
        if (!payload || payload === "[DONE]") continue

        const parsed = JSON.parse(payload)
        const delta = parsed.choices?.[0]?.delta?.content || ""
        if (delta) {
          yield { type: "delta", delta }
        }
      }
    }

    yield { type: "done", requestId: response.headers.get("x-request-id") }
  } finally {
    reader.releaseLock()
  }
}

async function fetchOpenRouter(input: OpenRouterCompletionInput, stream: boolean) {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), input.timeoutMs)
  const upstreamAbort = () => controller.abort()

  if (input.signal) {
    if (input.signal.aborted) {
      controller.abort()
    } else {
      input.signal.addEventListener("abort", upstreamAbort, { once: true })
    }
  }

  try {
    const url = `${getOpenRouterBaseUrl()}/chat/completions`
    // Keep-alive agent for connection reuse — reduces TCP/TLS handshake overhead.
    // Note: undici (default Node 18+ fetch) ignores the agent option and uses
    // its own pool. We pass it anyway for older runtimes / future compatibility.
    const agent = getAgentForUrl(url)
    const response = await fetch(url, {
      method: "POST",
      headers: buildOpenRouterHeaders(),
      signal: controller.signal,
      // @ts-expect-error - agent is honored by node-fetch / older runtimes; ignored by undici
      agent,
      body: JSON.stringify({
        model: input.model,
        messages: input.messages,
        temperature: input.temperature ?? 0.2,
        top_p: input.topP ?? 0.9,
        max_tokens: input.maxTokens,
        include_reasoning: false,
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
      throw new SwiftAiTimeoutError(input.timeoutMs, input.model)
    }

    throw new SwiftAiError(error instanceof Error ? redactAiSecret(error.message) : "Network error", {
      reason: "network",
      internalModelId: input.model,
    })
  } finally {
    clearTimeout(timeout)
    input.signal?.removeEventListener("abort", upstreamAbort)
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

  return new SwiftAiError(`OpenRouter API error (${response.status}): ${redactAiSecret(message)}`.trim(), {
    reason: reasonFromStatus(response.status),
    statusCode: response.status,
    requestId: response.headers.get("x-request-id"),
    internalModelId,
  })
}

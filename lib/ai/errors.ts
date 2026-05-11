import type { ProviderFailureReason } from "@/lib/ai/swift-tiers"

export class SwiftAiError extends Error {
  reason: ProviderFailureReason
  statusCode?: number
  requestId?: string | null
  internalModelId?: string

  constructor(
    message: string,
    details: {
      reason: ProviderFailureReason
      statusCode?: number
      requestId?: string | null
      internalModelId?: string
    }
  ) {
    super(message)
    this.name = "SwiftAiError"
    this.reason = details.reason
    this.statusCode = details.statusCode
    this.requestId = details.requestId
    this.internalModelId = details.internalModelId
  }
}

export class SwiftAiTimeoutError extends SwiftAiError {
  constructor(timeoutMs: number, internalModelId?: string) {
    super(`OpenRouter request timed out after ${Math.round(timeoutMs / 1000)} seconds`, {
      reason: "timeout",
      internalModelId,
    })
    this.name = "SwiftAiTimeoutError"
  }
}

export class SwiftAiCancelledError extends SwiftAiError {
  constructor(internalModelId?: string) {
    super("OpenRouter request was cancelled", {
      reason: "cancelled",
      internalModelId,
    })
    this.name = "SwiftAiCancelledError"
  }
}

export function reasonFromStatus(status: number): ProviderFailureReason {
  if (status === 401 || status === 403) return "auth"
  if (status === 408) return "timeout"
  if (status === 429 || status === 402) return "rate_limit"
  if (status >= 500) return "server_error"
  return "unknown"
}

export function isTransientFailure(reason: ProviderFailureReason) {
  return reason === "timeout" || reason === "network" || reason === "server_error" || reason === "rate_limit"
}

export function redactAiSecret(value: string) {
  return value
    .replace(/sk-or-v1-[A-Za-z0-9_-]+/g, "[redacted]")
    .replace(/sk-[A-Za-z0-9_-]+/g, "[redacted]")
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, "Bearer [redacted]")
}

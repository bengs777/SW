import type { ProviderFailureReason } from "@/lib/ai/swift-tiers"
import { isTransientFailure } from "@/lib/ai/errors"
import { env } from "@/lib/env"

export const MAX_RETRIES_PER_MODEL = Math.min(2, Math.max(0, env.aiMaxRetries))
export const MAX_PROVIDER_ATTEMPTS_PER_REQUEST = 64

export function shouldRetryModel(reason: ProviderFailureReason, retryCount: number) {
  return retryCount < MAX_RETRIES_PER_MODEL && isTransientFailure(reason)
}

export function retryDelayMs(retryCount: number) {
  const baseDelayMs = Number(process.env.AI_RETRY_BASE_DELAY_MS || 500)
  const maxDelayMs = Number(process.env.AI_RETRY_MAX_DELAY_MS || 8_000)
  const exponential = Math.max(250, baseDelayMs) * 2 ** Math.max(0, retryCount - 1)
  const jitter = Math.round(exponential * (0.2 + Math.random() * 0.3))
  return Math.min(Math.max(1000, maxDelayMs), Math.round(exponential + jitter))
}

export function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

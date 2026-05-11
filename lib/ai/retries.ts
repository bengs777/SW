import type { ProviderFailureReason } from "@/lib/ai/swift-tiers"
import { isTransientFailure } from "@/lib/ai/errors"

export const MAX_RETRIES_PER_MODEL = 0
export const MAX_PROVIDER_ATTEMPTS_PER_REQUEST = 4

export function shouldRetryModel(reason: ProviderFailureReason, retryCount: number) {
  return retryCount < MAX_RETRIES_PER_MODEL && isTransientFailure(reason)
}

export function retryDelayMs(retryCount: number) {
  return Math.min(1000, 250 * (retryCount + 1))
}

export function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

import { env, getEnvNumber } from "@/lib/env"

export const MIN_GENERATION_JOB_TIMEOUT_MS = 500_000

export function getTimeoutMs(name: string, fallbackMs: number, minMs = 1_000) {
  const value = Math.round(getEnvNumber(fallbackMs, name))
  if (!Number.isFinite(value)) return Math.max(minMs, fallbackMs)
  return Math.max(minMs, value)
}

export const timeoutConfig = {
  aiRequestMs: env.aiTimeoutMs,
  generationJobMs: getTimeoutMs("SWIFT_GENERATION_JOB_TIMEOUT_MS", env.aiQueueTimeoutMs, MIN_GENERATION_JOB_TIMEOUT_MS),
  staleGenerationMs: getTimeoutMs("SWIFT_STALE_GENERATION_TIMEOUT_MS", env.aiQueueTimeoutMs, MIN_GENERATION_JOB_TIMEOUT_MS),
  sandboxServiceMs: getTimeoutMs("SANDBOX_SERVICE_TIMEOUT_MS", 300_000, 1_000),
  healthProviderMs: getTimeoutMs("HEALTH_PROVIDER_TIMEOUT_MS", 8_000, 1_000),
}

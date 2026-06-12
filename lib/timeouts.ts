import { env, getEnvNumber } from "@/lib/env"

export const MIN_GENERATION_JOB_TIMEOUT_MS = 900_000

export function getTimeoutMs(name: string, fallbackMs: number, minMs = 1_000) {
  const value = Math.round(getEnvNumber(fallbackMs, name))
  if (!Number.isFinite(value)) return Math.max(minMs, fallbackMs)
  return Math.max(minMs, value)
}

const isProductionLikeExecutor =
  env.nodeEnv === "production" ||
  process.env.SWIFT_WORKER_TYPE === "generation" ||
  process.env.SWIFT_ENABLE_GENERATION_WORKER === "true" ||
  process.env.SWIFT_GENERATION_EXECUTION_MODE === "queue"
const defaultExecutorHardTimeoutMs = isProductionLikeExecutor ? 120_000 : 30_000
const executorHardTimeoutMs = getTimeoutMs("SWIFT_EXECUTOR_HARD_TIMEOUT_MS", defaultExecutorHardTimeoutMs, 30_000)
const defaultExecutorStuckOperationMs = Math.min(45_000, Math.max(15_000, Math.round(executorHardTimeoutMs / 2)))

export const timeoutConfig = {
  aiRequestMs: env.aiTimeoutMs,
  generationJobMs: getTimeoutMs("SWIFT_GENERATION_JOB_TIMEOUT_MS", env.aiQueueTimeoutMs, MIN_GENERATION_JOB_TIMEOUT_MS),
  staleGenerationMs: getTimeoutMs("SWIFT_STALE_GENERATION_TIMEOUT_MS", env.aiQueueTimeoutMs, MIN_GENERATION_JOB_TIMEOUT_MS),
  executorHardMs: executorHardTimeoutMs,
  executorStuckOperationMs: getTimeoutMs("SWIFT_EXECUTOR_STUCK_OPERATION_MS", defaultExecutorStuckOperationMs, 5_000),
  sandboxServiceMs: getTimeoutMs("SANDBOX_SERVICE_TIMEOUT_MS", 300_000, 1_000),
  healthProviderMs: getTimeoutMs("HEALTH_PROVIDER_TIMEOUT_MS", 8_000, 1_000),
}

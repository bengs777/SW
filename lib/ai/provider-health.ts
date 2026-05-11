import type { ProviderFailureReason, ProviderHealthStatus } from "@/lib/ai/swift-tiers"
import { getSwiftTierConfigs } from "@/lib/ai/swift-tiers"
import { isTransientFailure } from "@/lib/ai/errors"

export type SwiftModelHealth = {
  modelId: string
  status: ProviderHealthStatus
  latencyMs: number
  consecutiveFailures: number
  lastFailure?: ProviderFailureReason
  lastFailureAt?: number
  cooldownUntil?: number
  checkedAt: number
  message?: string
  statusCode?: number
}

const DEFAULT_HEALTH_TTL_MS = 60_000
const FAILURE_COOLDOWN_MS = 90_000
const OFFLINE_COOLDOWN_MS = 5 * 60_000
const FAILURE_THRESHOLD = 3
const healthByModel = new Map<string, SwiftModelHealth>()

export function getConfiguredSwiftModelIds() {
  const ids = new Set<string>()
  for (const tier of getSwiftTierConfigs()) {
    for (const target of tier.targets) {
      ids.add(target.modelId)
    }
  }
  return Array.from(ids)
}

export function getModelHealth(modelId: string) {
  const health = healthByModel.get(modelId)
  if (!health) return null
  return health
}

export function isModelTemporarilyUnavailable(modelId: string) {
  const health = healthByModel.get(modelId)
  if (!health) return false
  if (health.status !== "offline") return false
  return Boolean(health.cooldownUntil && health.cooldownUntil > Date.now())
}

export function markModelSuccess(modelId: string, latencyMs: number) {
  const current = healthByModel.get(modelId)
  healthByModel.set(modelId, {
    modelId,
    status: "healthy",
    latencyMs,
    consecutiveFailures: 0,
    checkedAt: Date.now(),
    message: current?.message,
  })
}

export function markModelFailure(
  modelId: string,
  input: {
    reason: ProviderFailureReason
    latencyMs: number
    statusCode?: number
    message?: string
  }
) {
  const current = healthByModel.get(modelId)
  const consecutiveFailures = (current?.consecutiveFailures || 0) + 1
  const status = toHealthStatus(input.reason, consecutiveFailures)
  const cooldownMs = status === "offline" ? OFFLINE_COOLDOWN_MS : FAILURE_COOLDOWN_MS

  healthByModel.set(modelId, {
    modelId,
    status,
    latencyMs: input.latencyMs,
    consecutiveFailures,
    lastFailure: input.reason,
    lastFailureAt: Date.now(),
    cooldownUntil: status === "healthy" ? undefined : Date.now() + cooldownMs,
    checkedAt: Date.now(),
    message: input.message,
    statusCode: input.statusCode,
  })
}

export function getHealthSnapshot(options?: { ttlMs?: number }) {
  const ttlMs = options?.ttlMs ?? DEFAULT_HEALTH_TTL_MS
  return getConfiguredSwiftModelIds().map((modelId) => {
    const health = healthByModel.get(modelId)
    const stale = !health || Date.now() - health.checkedAt > ttlMs

    return {
      modelId,
      status: stale ? "degraded" : health.status,
      latencyMs: health?.latencyMs || 0,
      consecutiveFailures: health?.consecutiveFailures || 0,
      lastFailure: health?.lastFailure,
      statusCode: health?.statusCode,
      cooldownUntil: health?.cooldownUntil ? new Date(health.cooldownUntil).toISOString() : undefined,
      checkedAt: health?.checkedAt ? new Date(health.checkedAt).toISOString() : undefined,
      cached: Boolean(health && !stale),
      message: health?.message,
    }
  })
}

function toHealthStatus(reason: ProviderFailureReason, consecutiveFailures: number): ProviderHealthStatus {
  if (reason === "auth" || reason === "config") return "offline"
  if (consecutiveFailures >= FAILURE_THRESHOLD) return "offline"
  if (isTransientFailure(reason) || reason === "empty_response" || reason === "invalid_output") return "degraded"
  return "offline"
}

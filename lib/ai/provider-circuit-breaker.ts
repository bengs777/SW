import type { ProviderFailureReason } from "@/lib/ai/swift-tiers"

type CircuitState = {
  status: "closed" | "open" | "half_open"
  consecutiveFailures: number
  openedAt?: number
  cooldownUntil?: number
  lastFailureReason?: ProviderFailureReason
  lastFailureMessage?: string
}

const FAILURE_THRESHOLD = Math.max(1, Number(process.env.SWIFT_PROVIDER_CIRCUIT_FAILURE_THRESHOLD || 10))
const COOLDOWN_MS = Math.max(5_000, Number(process.env.SWIFT_PROVIDER_CIRCUIT_COOLDOWN_MS || 60_000))
const stateByProvider = new Map<string, CircuitState>()

function currentState(provider: string): CircuitState {
  const current = stateByProvider.get(provider)
  if (current) return current
  const next: CircuitState = { status: "closed", consecutiveFailures: 0 }
  stateByProvider.set(provider, next)
  return next
}

export function getProviderCircuitState(provider: string) {
  const state = currentState(provider)
  const now = Date.now()
  const status = state.status === "open" && state.cooldownUntil && state.cooldownUntil <= now
    ? "half_open"
    : state.status

  return {
    ...state,
    status,
    cooldownUntil: state.cooldownUntil ? new Date(state.cooldownUntil).toISOString() : undefined,
    openedAt: state.openedAt ? new Date(state.openedAt).toISOString() : undefined,
  }
}

export function isProviderCircuitOpen(provider: string) {
  const state = currentState(provider)
  if (state.status !== "open") return false
  if (state.cooldownUntil && state.cooldownUntil <= Date.now()) {
    state.status = "half_open"
    return false
  }
  return true
}

export function markProviderCircuitSuccess(provider: string) {
  stateByProvider.set(provider, { status: "closed", consecutiveFailures: 0 })
}

export function markProviderCircuitFailure(
  provider: string,
  input: {
    reason: ProviderFailureReason
    message?: string
  }
) {
  const state = currentState(provider)
  const consecutiveFailures = state.consecutiveFailures + 1

  if (consecutiveFailures >= FAILURE_THRESHOLD) {
    stateByProvider.set(provider, {
      status: "open",
      consecutiveFailures,
      openedAt: Date.now(),
      cooldownUntil: Date.now() + COOLDOWN_MS,
      lastFailureReason: input.reason,
      lastFailureMessage: input.message,
    })
    return
  }

  stateByProvider.set(provider, {
    ...state,
    status: state.status === "half_open" ? "open" : state.status,
    consecutiveFailures,
    cooldownUntil: state.status === "half_open" ? Date.now() + COOLDOWN_MS : state.cooldownUntil,
    lastFailureReason: input.reason,
    lastFailureMessage: input.message,
  })
}

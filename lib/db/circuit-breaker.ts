type DatabaseCircuitState = {
  status: "closed" | "open" | "half_open"
  consecutiveFailures: number
  openedAt?: number
  cooldownUntil?: number
  lastError?: string
}

const FAILURE_THRESHOLD = Math.max(1, Number(process.env.DB_CIRCUIT_FAILURE_THRESHOLD || 50))
const COOLDOWN_MS = Math.max(5_000, Number(process.env.DB_CIRCUIT_COOLDOWN_MS || 30_000))
let state: DatabaseCircuitState = { status: "closed", consecutiveFailures: 0 }

export function getDatabaseCircuitState() {
  if (state.status === "open" && state.cooldownUntil && state.cooldownUntil <= Date.now()) {
    state = { ...state, status: "half_open" }
  }

  return {
    ...state,
    openedAt: state.openedAt ? new Date(state.openedAt).toISOString() : undefined,
    cooldownUntil: state.cooldownUntil ? new Date(state.cooldownUntil).toISOString() : undefined,
  }
}

export function isDatabaseCircuitOpen() {
  return getDatabaseCircuitState().status === "open"
}

export function markDatabaseCircuitSuccess() {
  state = { status: "closed", consecutiveFailures: 0 }
}

export function markDatabaseCircuitFailure(error: string) {
  const consecutiveFailures = state.consecutiveFailures + 1
  if (consecutiveFailures >= FAILURE_THRESHOLD) {
    state = {
      status: "open",
      consecutiveFailures,
      openedAt: Date.now(),
      cooldownUntil: Date.now() + COOLDOWN_MS,
      lastError: error,
    }
    return
  }

  state = {
    ...state,
    status: state.status === "half_open" ? "open" : state.status,
    consecutiveFailures,
    cooldownUntil: state.status === "half_open" ? Date.now() + COOLDOWN_MS : state.cooldownUntil,
    lastError: error,
  }
}

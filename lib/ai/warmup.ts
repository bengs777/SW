import { env } from "@/lib/env"
import { pingOpenRouter } from "@/lib/ai/connection-pool"
import { warmCacheConnection } from "@/lib/ai/response-cache"
import { log } from "@/lib/logging"

/**
 * AI warmup module.
 *
 * Purpose: keep the AI subsystem in "standby" — connection pool warm, cache
 * connected — without burning compute when no one is actively using it.
 *
 * RELIABILITY GUARANTEES (post-audit):
 *
 *   1. Each cycle has a HARD ceiling of WARMUP_CYCLE_TIMEOUT_MS. The
 *      individual probes (`pingOpenRouter`, `warmCacheConnection`) ALSO
 *      enforce their own per-call ceilings. The cycle timeout is the
 *      ultimate guarantee — even if every probe lies about its deadline,
 *      the cycle promise resolves within this budget.
 *
 *   2. Cycles cannot overlap. If a previous cycle is still in-flight when
 *      the interval fires, the new tick is dropped. Without this, a slow
 *      upstream + interval timer = exponential fan-out + socket exhaustion
 *      (the original 200s+ latency symptom).
 *
 *   3. Exponential backoff after sustained failure. Without this we'd
 *      hammer a sick upstream with 4-min retries forever (the original
 *      `openRouterOk:false` log spam).
 *
 *   4. Disabled on Vercel serverless. Each lambda instance is short-lived
 *      so a 4-min interval rarely fires before the instance is recycled —
 *      net cost: negative.
 */

const WARMUP_INTERVAL_MS = 4 * 60 * 1000 // 4 minutes
const STARTUP_DELAY_MS = 5_000
const WARMUP_CYCLE_TIMEOUT_MS = 10_000 // Hard wall on a full cycle
const PROBE_TIMEOUT_MS = 4_000 // Forwarded to each probe
const BACKOFF_AFTER_FAILURES = 3
const MAX_BACKOFF_MS = 30 * 60 * 1000 // 30 min

type WarmupState = {
  initialized: boolean
  intervalId: NodeJS.Timeout | null
  inFlight: boolean
  lastWarmupAt: number | null
  lastSuccess: boolean
  consecutiveFailures: number
  currentIntervalMs: number
}

const globalRef = globalThis as typeof globalThis & {
  __swiftAiWarmupState?: WarmupState
}

function getState(): WarmupState {
  if (!globalRef.__swiftAiWarmupState) {
    globalRef.__swiftAiWarmupState = {
      initialized: false,
      intervalId: null,
      inFlight: false,
      lastWarmupAt: null,
      lastSuccess: false,
      consecutiveFailures: 0,
      currentIntervalMs: WARMUP_INTERVAL_MS,
    }
  }
  return globalRef.__swiftAiWarmupState
}

/**
 * Wrap any promise with a hard wall-clock timeout. Resolves with the original
 * value, or rejects with a deterministic timeout error after `ms`. Crucially
 * this never settles twice.
 */
function withHardTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false

    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      reject(new Error(`warmup_timeout:${label}:${ms}ms`))
    }, ms)
    if (timer.unref) timer.unref()

    promise.then(
      (value) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve(value)
      },
      (error) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        reject(error)
      }
    )
  })
}

async function performWarmup() {
  const state = getState()

  // Re-entrancy guard: drop overlapping ticks.
  if (state.inFlight) {
    log("warn", "ai_warmup_skipped_overlap", {
      lastWarmupAt: state.lastWarmupAt ? new Date(state.lastWarmupAt).toISOString() : null,
    })
    return
  }

  state.inFlight = true
  state.lastWarmupAt = Date.now()
  const cycleStart = Date.now()

  try {
    // Each probe enforces its own ceiling. The cycle timeout is the upper
    // bound on the whole `Promise.allSettled`. We never nest a second
    // `withHardTimeout` around a probe — that would just hide bugs in the
    // probe's own timer logic. The probes themselves are the source of
    // truth for their own timing.
    const settled = await withHardTimeout(
      Promise.allSettled([
        pingOpenRouter(env.openRouterBaseUrl, env.openRouterApiKey, PROBE_TIMEOUT_MS),
        warmCacheConnection(),
      ]),
      WARMUP_CYCLE_TIMEOUT_MS,
      "cycle"
    )

    const [openRouterResult, cacheResult] = settled

    const openRouterOk =
      openRouterResult.status === "fulfilled" && openRouterResult.value.ok
    const cacheOk = cacheResult.status === "fulfilled" && cacheResult.value === true

    state.lastSuccess = openRouterOk
    state.consecutiveFailures = openRouterOk ? 0 : state.consecutiveFailures + 1

    log(openRouterOk ? "info" : "warn", "ai_warmup_cycle", {
      openRouterOk,
      openRouterLatencyMs:
        openRouterResult.status === "fulfilled" ? openRouterResult.value.latencyMs : null,
      openRouterError:
        openRouterResult.status === "fulfilled" ? openRouterResult.value.error : null,
      cacheOk,
      consecutiveFailures: state.consecutiveFailures,
      cycleDurationMs: Date.now() - cycleStart,
    })

    applyBackoff(state)
  } catch (error) {
    state.lastSuccess = false
    state.consecutiveFailures += 1
    log("error", "ai_warmup_cycle_failed", {
      error: error instanceof Error ? error.message : String(error),
      consecutiveFailures: state.consecutiveFailures,
      cycleDurationMs: Date.now() - cycleStart,
    })
    applyBackoff(state)
  } finally {
    state.inFlight = false
  }
}

function applyBackoff(state: WarmupState) {
  const desiredInterval =
    state.consecutiveFailures >= BACKOFF_AFTER_FAILURES
      ? Math.min(
          MAX_BACKOFF_MS,
          WARMUP_INTERVAL_MS * Math.pow(2, state.consecutiveFailures - BACKOFF_AFTER_FAILURES + 1)
        )
      : WARMUP_INTERVAL_MS

  if (desiredInterval === state.currentIntervalMs) return

  state.currentIntervalMs = desiredInterval
  if (state.intervalId) {
    clearInterval(state.intervalId)
    state.intervalId = setInterval(() => {
      performWarmup().catch(() => {
        /* swallowed inside performWarmup */
      })
    }, desiredInterval)
    if (state.intervalId.unref) state.intervalId.unref()
    log("info", "ai_warmup_backoff_applied", {
      intervalMs: desiredInterval,
      consecutiveFailures: state.consecutiveFailures,
    })
  }
}

/**
 * Initialize the warmup loop. Idempotent across calls.
 *
 * On Vercel serverless, periodic warmup provides no benefit (each invocation
 * is short-lived) and pays per-cold-start cost. We skip warmup entirely on
 * Vercel by default. Set SWIFT_FORCE_WARMUP=1 to re-enable for testing.
 */
export function initializeAiWarmup(): void {
  const state = getState()
  if (state.initialized) return

  if (process.env.NEXT_PHASE === "phase-production-build") return
  if (!env.openRouterApiKey) return

  const isVercelServerless = process.env.VERCEL === "1"
  const forceWarmup = process.env.SWIFT_FORCE_WARMUP === "1"
  if (isVercelServerless && !forceWarmup) {
    log("info", "ai_warmup_skipped_serverless", {
      reason: "vercel_per_invocation_lifecycle",
    })
    state.initialized = true
    return
  }

  state.initialized = true
  state.currentIntervalMs = WARMUP_INTERVAL_MS

  const startupTimer = setTimeout(() => {
    performWarmup().catch(() => {
      /* swallowed inside performWarmup */
    })
  }, STARTUP_DELAY_MS)
  if (startupTimer.unref) startupTimer.unref()

  state.intervalId = setInterval(() => {
    performWarmup().catch(() => {
      /* swallowed inside performWarmup */
    })
  }, state.currentIntervalMs)
  if (state.intervalId.unref) state.intervalId.unref()

  log("info", "ai_warmup_initialized", {
    intervalMs: state.currentIntervalMs,
    startupDelayMs: STARTUP_DELAY_MS,
    cycleTimeoutMs: WARMUP_CYCLE_TIMEOUT_MS,
    probeTimeoutMs: PROBE_TIMEOUT_MS,
  })
}

export function getWarmupStatus() {
  const state = getState()
  return {
    initialized: state.initialized,
    inFlight: state.inFlight,
    lastWarmupAt: state.lastWarmupAt ? new Date(state.lastWarmupAt).toISOString() : null,
    lastSuccess: state.lastSuccess,
    consecutiveFailures: state.consecutiveFailures,
    currentIntervalMs: state.currentIntervalMs,
  }
}

export function stopAiWarmup() {
  const state = getState()
  if (state.intervalId) {
    clearInterval(state.intervalId)
    state.intervalId = null
  }
  state.initialized = false
  state.inFlight = false
}

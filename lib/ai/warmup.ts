import { env } from "@/lib/env"
import { pingOpenRouter } from "@/lib/ai/connection-pool"
import { warmCacheConnection } from "@/lib/ai/response-cache"
import { log } from "@/lib/logging"

/**
 * AI warmup module.
 *
 * Goal: keep the AI subsystem in "standby" — ready to respond fast — without
 * burning compute when no one is actively using it.
 *
 * RELIABILITY GUARANTEES (post-audit):
 * - Each cycle has a HARD ceiling of WARMUP_CYCLE_TIMEOUT_MS (cannot hang).
 * - Cycles cannot overlap (re-entrancy guard prevents fan-out under stalls).
 * - After repeated failures, interval backs off exponentially (no retry storm).
 * - Disabled on Vercel serverless (per-invocation lifecycle, not long-running).
 */

// Tighter ceilings — production logs showed 200s+ "warmup" latencies because
// individual probes had per-request timeouts but the cycle itself did not.
const WARMUP_INTERVAL_MS = 4 * 60 * 1000 // 4 minutes
const STARTUP_DELAY_MS = 5_000
const WARMUP_CYCLE_TIMEOUT_MS = 8_000 // hard wall on a full cycle
const PROBE_TIMEOUT_MS = 4_000 // hard wall on a single probe
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

/** Wrap any promise with a hard timeout that rejects on overrun. */
function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`warmup_timeout:${label}:${ms}ms`))
    }, ms)
    if (timer.unref) timer.unref()
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error) => {
        clearTimeout(timer)
        reject(error)
      }
    )
  })
}

async function performWarmup() {
  const state = getState()

  // Re-entrancy guard: if a previous cycle is still in flight, skip this tick.
  // Without this, a slow upstream + interval timer = fan-out of overlapping
  // requests + exhausted socket pool + escalating latency (the production symptom).
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
    const [openRouterResult, cacheResult] = await withTimeout(
      Promise.allSettled([
        withTimeout(
          pingOpenRouter(env.openRouterBaseUrl, env.openRouterApiKey),
          PROBE_TIMEOUT_MS,
          "openrouter"
        ).catch((error) => ({
          ok: false as const,
          latencyMs: Date.now() - cycleStart,
          error: error instanceof Error ? error.message : String(error),
        })),
        withTimeout(warmCacheConnection(), PROBE_TIMEOUT_MS, "cache").catch(() => false),
      ]),
      WARMUP_CYCLE_TIMEOUT_MS,
      "cycle"
    )

    const openRouterOk =
      openRouterResult.status === "fulfilled" && openRouterResult.value.ok
    const cacheOk = cacheResult.status === "fulfilled" && cacheResult.value === true

    state.lastSuccess = openRouterOk
    state.consecutiveFailures = openRouterOk ? 0 : state.consecutiveFailures + 1

    log(openRouterOk ? "info" : "warn", "ai_warmup_cycle", {
      openRouterOk,
      openRouterLatencyMs:
        openRouterResult.status === "fulfilled" ? openRouterResult.value.latencyMs : null,
      cacheOk,
      consecutiveFailures: state.consecutiveFailures,
      cycleDurationMs: Date.now() - cycleStart,
    })

    // Exponential backoff after sustained failures so we don't hammer a sick
    // upstream with 4-min retries forever (which is what produced repeated
    // "openRouterOk:false" log spam in production).
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
 * IMPORTANT: warmup is a long-running concern. On Vercel serverless each
 * invocation is short-lived, so a periodic `setInterval` provides no real
 * benefit and pays per-cold-start cost. We therefore skip warmup entirely
 * on Vercel by default. Set SWIFT_FORCE_WARMUP=1 to re-enable for testing.
 */
export function initializeAiWarmup(): void {
  const state = getState()
  if (state.initialized) return

  if (process.env.NEXT_PHASE === "phase-production-build") return
  if (!env.openRouterApiKey) return

  // Vercel serverless: don't run periodic warmup. Each function instance lives
  // for at most one request burst, so the interval rarely fires before the
  // instance is recycled. This was the source of "AI warmup initialized" log
  // spam on every cold start.
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

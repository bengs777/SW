import { env } from "@/lib/env"
import { pingOpenRouter } from "@/lib/ai/connection-pool"
import { warmCacheConnection, resetCacheCooldown } from "@/lib/ai/response-cache"
import { resetRateLimitCooldown } from "@/lib/security/rate-limit"
import { log } from "@/lib/logging"

/**
 * AI warmup module.
 *
 * Goal: keep the AI subsystem in "standby" — ready to respond fast — without
 * burning compute when no one is actively using it.
 *
 * Strategy:
 * - On process start: open Redis connection + open keep-alive socket to OpenRouter.
 * - Periodically (every 4 minutes): ping OpenRouter so the keep-alive socket
 *   stays warm. Free OpenRouter probe endpoint, costs nothing.
 * - Cache stays connected so first cached lookup is fast.
 *
 * Why 4 minutes?
 * - Most CDN / cloud providers idle out keep-alive sockets at ~5 minutes.
 * - 4-minute intervals keep the socket alive without wasting requests.
 *
 * Cost analysis:
 * - OpenRouter /auth/key endpoint is FREE (no model invocation).
 * - Redis PING is essentially free.
 * - One keep-alive cycle per 4 min = 360 pings/day = $0 in AI costs.
 */

const WARMUP_INTERVAL_MS = 4 * 60 * 1000 // 4 minutes
const STARTUP_DELAY_MS = 5_000 // wait 5s after process start before first warmup

type WarmupState = {
  initialized: boolean
  intervalId: NodeJS.Timeout | null
  lastWarmupAt: number | null
  lastSuccess: boolean
  consecutiveFailures: number
}

const globalRef = globalThis as typeof globalThis & {
  __swiftAiWarmupState?: WarmupState
}

function getState(): WarmupState {
  if (!globalRef.__swiftAiWarmupState) {
    globalRef.__swiftAiWarmupState = {
      initialized: false,
      intervalId: null,
      lastWarmupAt: null,
      lastSuccess: false,
      consecutiveFailures: 0,
    }
  }
  return globalRef.__swiftAiWarmupState
}

async function performWarmup() {
  const state = getState()
  state.lastWarmupAt = Date.now()

  const [openRouterResult, cacheResult] = await Promise.allSettled([
    pingOpenRouter(env.openRouterBaseUrl, env.openRouterApiKey),
    warmCacheConnection(),
  ])

  const openRouterOk =
    openRouterResult.status === "fulfilled" && openRouterResult.value.ok
  const cacheOk = cacheResult.status === "fulfilled" && cacheResult.value === true

  state.lastSuccess = openRouterOk
  state.consecutiveFailures = openRouterOk ? 0 : state.consecutiveFailures + 1

  // If cache is down, reset cooldown timers to force reconnection on next request
  if (!cacheOk) {
    resetCacheCooldown()
    resetRateLimitCooldown()
  }

  log("info", "ai_warmup_cycle", {
    openRouterOk,
    openRouterLatencyMs: openRouterResult.status === "fulfilled" ? openRouterResult.value.latencyMs : null,
    cacheOk,
    consecutiveFailures: state.consecutiveFailures,
  })
}

/**
 * Initialize the warmup loop. Safe to call multiple times — it's idempotent.
 *
 * Note: in serverless (Vercel), this runs per-instance lifecycle, which is
 * exactly what we want — each cold-start instance warms up its own pool.
 */
export function initializeAiWarmup(): void {
  const state = getState()
  if (state.initialized) return

  // Skip in build phase
  if (process.env.NEXT_PHASE === "phase-production-build") return

  // Skip if no API key configured (CI, local without secrets)
  if (!env.openRouterApiKey) return

  state.initialized = true

  // Defer first warmup so it doesn't block startup
  setTimeout(() => {
    performWarmup().catch((error) => {
      log("warn", "ai_warmup_initial_failed", {
        error: error instanceof Error ? error.message : String(error),
      })
    })
  }, STARTUP_DELAY_MS)

  // Periodic warmup
  state.intervalId = setInterval(() => {
    performWarmup().catch((error) => {
      log("warn", "ai_warmup_periodic_failed", {
        error: error instanceof Error ? error.message : String(error),
      })
    })
  }, WARMUP_INTERVAL_MS)

  // Don't keep process alive just for warmup
  if (state.intervalId.unref) {
    state.intervalId.unref()
  }

  log("info", "ai_warmup_initialized", {
    intervalMs: WARMUP_INTERVAL_MS,
    startupDelayMs: STARTUP_DELAY_MS,
  })
}

export function getWarmupStatus() {
  const state = getState()
  return {
    initialized: state.initialized,
    lastWarmupAt: state.lastWarmupAt ? new Date(state.lastWarmupAt).toISOString() : null,
    lastSuccess: state.lastSuccess,
    consecutiveFailures: state.consecutiveFailures,
  }
}

export function stopAiWarmup() {
  const state = getState()
  if (state.intervalId) {
    clearInterval(state.intervalId)
    state.intervalId = null
  }
  state.initialized = false
}

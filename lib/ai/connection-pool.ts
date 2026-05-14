import { Agent as HttpAgent } from "node:http"
import { Agent as HttpsAgent } from "node:https"

/**
 * Persistent HTTP/HTTPS keep-alive agent for OpenRouter calls.
 *
 * Why this matters for "standby" + cost:
 * - Without keep-alive, every request opens a new TCP + TLS handshake (~150-300ms overhead).
 * - With keep-alive, established connections are reused → first byte arrives much sooner.
 * - Reduces compute time (Vercel/Railway charge by execution duration).
 * - Reduces tail latency on cold starts after the first warm hit.
 *
 * Singleton agents persist across the process lifetime.
 */

const KEEP_ALIVE_MS = 60_000
const MAX_SOCKETS = 50
const MAX_FREE_SOCKETS = 10
const SCHEDULING: "fifo" | "lifo" = "lifo" // newer connections preferred = better keep-alive

type GlobalWithAgents = typeof globalThis & {
  __swiftHttpAgent?: HttpAgent
  __swiftHttpsAgent?: HttpsAgent
}

const globalRef = globalThis as GlobalWithAgents

export function getHttpsAgent(): HttpsAgent {
  if (!globalRef.__swiftHttpsAgent) {
    globalRef.__swiftHttpsAgent = new HttpsAgent({
      keepAlive: true,
      keepAliveMsecs: KEEP_ALIVE_MS,
      maxSockets: MAX_SOCKETS,
      maxFreeSockets: MAX_FREE_SOCKETS,
      scheduling: SCHEDULING,
      timeout: 120_000,
    })
  }
  return globalRef.__swiftHttpsAgent
}

export function getHttpAgent(): HttpAgent {
  if (!globalRef.__swiftHttpAgent) {
    globalRef.__swiftHttpAgent = new HttpAgent({
      keepAlive: true,
      keepAliveMsecs: KEEP_ALIVE_MS,
      maxSockets: MAX_SOCKETS,
      maxFreeSockets: MAX_FREE_SOCKETS,
      scheduling: SCHEDULING,
      timeout: 120_000,
    })
  }
  return globalRef.__swiftHttpAgent
}

/**
 * Pick the right agent based on URL protocol.
 * Note: Next.js/Node 18+ fetch uses undici by default which does its own pooling,
 * but explicitly providing an agent ensures consistent behavior across runtimes.
 */
export function getAgentForUrl(url: string): HttpsAgent | HttpAgent | undefined {
  // undici (default Node 18+ fetch) ignores the agent option — but on older runtimes
  // (pre-undici, polyfills) this still helps. Returning undefined is fine for undici.
  if (url.startsWith("https://")) return getHttpsAgent()
  if (url.startsWith("http://")) return getHttpAgent()
  return undefined
}

/**
 * Periodic warmup ping to keep the connection pool ready.
 * Called from the warmup module on app startup.
 *
 * RELIABILITY: Uses both AbortController AND a hard wall-clock timeout race.
 * AbortSignal.timeout() alone has been observed to allow undici DNS/TLS phases
 * to outlast the signal in production (root cause of 200s+ latencies in logs).
 */
export async function pingOpenRouter(
  baseUrl: string,
  apiKey: string,
  timeoutMs = 4_000
): Promise<{ ok: boolean; latencyMs: number; status?: number; error?: string }> {
  if (!apiKey) return { ok: false, latencyMs: 0, error: "no_api_key" }

  const startedAt = Date.now()
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  if (timer.unref) timer.unref()

  // Hard wall-clock race — guarantees the function resolves no later than
  // timeoutMs + a small fudge factor, even if undici hangs in DNS/TLS.
  const wallClock = new Promise<{ ok: false; latencyMs: number; error: string }>(
    (resolve) => {
      const t = setTimeout(
        () =>
          resolve({
            ok: false,
            latencyMs: Date.now() - startedAt,
            error: "wall_clock_timeout",
          }),
        timeoutMs + 500
      )
      if (t.unref) t.unref()
    }
  )

  const fetchAttempt = (async () => {
    try {
      const response = await fetch(`${baseUrl.replace(/\/+$/, "")}/auth/key`, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          Accept: "application/json",
        },
        signal: controller.signal,
        cache: "no-store",
      })
      // Drain the body so the connection can be released back to the pool.
      // Without this the keep-alive socket stays "in use" and future probes
      // open new connections, which is what produced socket-pool exhaustion
      // on cold starts.
      await response.body?.cancel().catch(() => undefined)
      return {
        ok: response.ok,
        status: response.status,
        latencyMs: Date.now() - startedAt,
      }
    } catch (error) {
      return {
        ok: false as const,
        latencyMs: Date.now() - startedAt,
        error: error instanceof Error ? error.message : String(error),
      }
    } finally {
      clearTimeout(timer)
    }
  })()

  return Promise.race([fetchAttempt, wallClock])
}

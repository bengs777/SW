import { Agent as HttpAgent } from "node:http"
import { Agent as HttpsAgent } from "node:https"

/**
 * Persistent HTTP/HTTPS keep-alive agents for OpenRouter calls.
 *
 * Why this matters for "standby" + cost:
 *   - Without keep-alive, every request opens a new TCP + TLS handshake
 *     (~150-300ms overhead).
 *   - With keep-alive, established connections are reused → first byte
 *     arrives much sooner.
 *   - Reduces compute time (Vercel/Railway charge by execution duration).
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
 *
 * Note: Next.js / Node 18+ fetch uses undici by default which does its own
 * pooling. Undici ignores the `agent` option but we still pass it for
 * consistency on older runtimes (returning undefined is fine for undici).
 */
export function getAgentForUrl(url: string): HttpsAgent | HttpAgent | undefined {
  if (url.startsWith("https://")) return getHttpsAgent()
  if (url.startsWith("http://")) return getHttpAgent()
  return undefined
}

/**
 * Warmup ping to OpenRouter `/auth/key`.
 *
 * RELIABILITY (post-audit):
 *
 * Previous bug: `Promise.race(fetch, wallClock)` resolved early on wall-clock
 * fire, but the fetch promise kept running in the background, holding the
 * undici socket and pinning event-loop work. Production logs showed 200s+
 * "completed" warmup cycles where the wall-clock had already returned but
 * the underlying request was still in DNS/TLS.
 *
 * New invariants:
 *   1. ONE authoritative timer. When it fires we abort the controller, the
 *      fetch rejects, and we resolve with a deterministic timeout result.
 *   2. We `await response.body?.cancel()` so the socket is released back to
 *      the keep-alive pool. Skipping this leaks a busy socket per failed
 *      probe → pool exhaustion → cascading hang on the next probe.
 *   3. The function ALWAYS resolves within `timeoutMs + GUARD_MS` regardless
 *      of what undici does internally — the guard fires `controller.abort()`
 *      and synthesizes a timeout result if the fetch hasn't already settled.
 */
const WARMUP_GUARD_MS = 500

export async function pingOpenRouter(
  baseUrl: string,
  apiKey: string,
  timeoutMs = 4_000
): Promise<{ ok: boolean; latencyMs: number; status?: number; error?: string }> {
  if (!apiKey) return { ok: false, latencyMs: 0, error: "no_api_key" }

  const startedAt = Date.now()
  const controller = new AbortController()

  return new Promise((resolve) => {
    let settled = false
    const settle = (result: { ok: boolean; latencyMs: number; status?: number; error?: string }) => {
      if (settled) return
      settled = true
      clearTimeout(abortTimer)
      clearTimeout(guardTimer)
      // Make sure the request is aborted if the resolve was the wall-clock
      // path; ignore any abort-cascade error.
      try {
        controller.abort()
      } catch {
        /* already aborted */
      }
      resolve(result)
    }

    const abortTimer = setTimeout(() => {
      try {
        controller.abort()
      } catch {
        /* already aborted */
      }
    }, timeoutMs)
    if (abortTimer.unref) abortTimer.unref()

    // Hard guard: even if undici ignores the abort signal during DNS/TLS, we
    // synthesize a deterministic timeout result.
    const guardTimer = setTimeout(() => {
      settle({
        ok: false,
        latencyMs: Date.now() - startedAt,
        error: "wall_clock_timeout",
      })
    }, timeoutMs + WARMUP_GUARD_MS)
    if (guardTimer.unref) guardTimer.unref()

    void (async () => {
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
        // open new connections (cause of socket-pool exhaustion on cold start).
        await response.body?.cancel().catch(() => undefined)

        settle({
          ok: response.ok,
          status: response.status,
          latencyMs: Date.now() - startedAt,
        })
      } catch (error) {
        settle({
          ok: false,
          latencyMs: Date.now() - startedAt,
          error: error instanceof Error ? error.message : String(error),
        })
      }
    })()
  })
}

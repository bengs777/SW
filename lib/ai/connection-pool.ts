import { Agent as HttpAgent } from "node:http"
import { Agent as HttpsAgent } from "node:https"

/**
 * Persistent HTTP/HTTPS keep-alive agent for OpenRouter calls.
 *
 * Why this matters for "standby" + cost:
 * - Without keep-alive, every request opens a new TCP + TLS handshake (~150-300ms overhead).
 * - With keep-alive, established connections are reused → first byte arrives much sooner.
 * - Reduces compute time on usage-metered runtimes.
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
 */
export async function pingOpenRouter(baseUrl: string, apiKey: string): Promise<{ ok: boolean; latencyMs: number }> {
  if (!apiKey) return { ok: false, latencyMs: 0 }

  const startedAt = Date.now()
  try {
    const response = await fetch(`${baseUrl.replace(/\/+$/, "")}/auth/key`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: "application/json",
      },
      signal: AbortSignal.timeout(5_000),
    })
    return {
      ok: response.ok,
      latencyMs: Date.now() - startedAt,
    }
  } catch {
    return {
      ok: false,
      latencyMs: Date.now() - startedAt,
    }
  }
}

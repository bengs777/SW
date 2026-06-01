import { env } from "@/lib/env"

export type ExternalRuntimeHealthStatus = "healthy" | "degraded" | "unhealthy" | "missing"

export type ExternalRuntimeHealth = {
  configured: boolean
  endpoint: string | null
  status: ExternalRuntimeHealthStatus
  ok: boolean
  httpStatus: number | null
  latencyMs: number | null
  checkedAt: string
  detail?: unknown
  error?: string | null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

async function fetchJsonHealth(endpoint: string, timeoutMs = 5_000) {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)
  const startedAt = Date.now()

  try {
    const response = await fetch(endpoint, {
      method: "GET",
      cache: "no-store",
      signal: controller.signal,
      headers: {
        Accept: "application/json",
      },
    })
    const text = await response.text()
    const body = text ? JSON.parse(text) as unknown : null

    return {
      httpStatus: response.status,
      latencyMs: Date.now() - startedAt,
      body,
    }
  } finally {
    clearTimeout(timeout)
  }
}

export async function getExternalWorkerRuntimeHealth(): Promise<ExternalRuntimeHealth> {
  if (!env.workerHealthUrl) {
    return {
      configured: false,
      endpoint: null,
      status: "missing",
      ok: false,
      httpStatus: null,
      latencyMs: null,
      checkedAt: new Date().toISOString(),
      error: "Set SWIFT_WORKER_HEALTH_URL to probe the dedicated worker directly.",
    }
  }

  try {
    const response = await fetchJsonHealth(env.workerHealthUrl)
    const body = isRecord(response.body) ? response.body : {}
    const bodyStatus = String(body.status || "unknown").toLowerCase()
    const bodyMode = String(body.mode || "unknown").toLowerCase()
    const bodyWorker = String(body.worker || "unknown").toLowerCase()
    const healthy = response.httpStatus === 200 && bodyStatus === "healthy" && bodyMode === "queue"
    const degraded = !healthy && (
      bodyStatus === "degraded" ||
      bodyStatus === "stale" ||
      bodyWorker === "degraded" ||
      bodyWorker === "missing"
    )

    return {
      configured: true,
      endpoint: env.workerHealthUrl,
      status: healthy ? "healthy" : degraded ? "degraded" : "unhealthy",
      ok: healthy,
      httpStatus: response.httpStatus,
      latencyMs: response.latencyMs,
      checkedAt: new Date().toISOString(),
      detail: response.body,
      error: null,
    }
  } catch (error) {
    return {
      configured: true,
      endpoint: env.workerHealthUrl,
      status: "unhealthy",
      ok: false,
      httpStatus: null,
      latencyMs: null,
      checkedAt: new Date().toISOString(),
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

export async function getExternalSandboxRuntimeHealth(): Promise<ExternalRuntimeHealth> {
  if (!env.sandboxServiceUrl) {
    return {
      configured: false,
      endpoint: null,
      status: "missing",
      ok: false,
      httpStatus: null,
      latencyMs: null,
      checkedAt: new Date().toISOString(),
      error: "Set SANDBOX_SERVICE_URL to probe the external sandbox runtime.",
    }
  }

  const endpoint = `${env.sandboxServiceUrl}/health`

  try {
    const response = await fetchJsonHealth(endpoint)
    const body = isRecord(response.body) ? response.body : {}
    const bodyStatus = String(body.status || "unknown").toLowerCase()
    const bodyOk = body.ok !== false
    const healthy = response.httpStatus === 200 && bodyOk && (bodyStatus === "healthy" || body.ok === true)
    const degraded = !healthy && bodyStatus === "degraded"

    return {
      configured: true,
      endpoint,
      status: healthy ? "healthy" : degraded ? "degraded" : "unhealthy",
      ok: healthy,
      httpStatus: response.httpStatus,
      latencyMs: response.latencyMs,
      checkedAt: new Date().toISOString(),
      detail: response.body,
      error: null,
    }
  } catch (error) {
    return {
      configured: true,
      endpoint,
      status: "unhealthy",
      ok: false,
      httpStatus: null,
      latencyMs: null,
      checkedAt: new Date().toISOString(),
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

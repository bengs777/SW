import { env } from "@/lib/env"

export type ExternalRuntimeHealthStatus = "healthy" | "degraded" | "unhealthy" | "missing" | "not_configured" | "degraded_optional"

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

function sandboxStorageDiagnostic(body: Record<string, unknown>) {
  const runtime = isRecord(body.runtime) ? body.runtime : {}
  const storage = isRecord(runtime.storage)
    ? runtime.storage
    : isRecord(body.storage)
      ? body.storage
      : null
  const hasStorageDetail = Boolean(storage)
  const rootReady = runtime.rootReady !== false
  const storageOk = Boolean(storage && storage.ok === true)
  const availableBytes = typeof storage?.availableBytes === "number" ? storage.availableBytes : null
  const minFreeBytes = typeof storage?.minFreeBytes === "number" ? storage.minFreeBytes : null
  const error = !hasStorageDetail
    ? "Sandbox health endpoint is missing runtime.storage; redeploy the sandbox runtime service and ensure it exposes storage health."
    : !rootReady
      ? String(runtime.rootError || "Sandbox root is not ready.")
      : !storageOk
        ? String(runtime.rootError || `Sandbox storage is not ready. availableBytes=${availableBytes ?? "unknown"}, minFreeBytes=${minFreeBytes ?? "unknown"}.`)
        : null

  return {
    hasStorageDetail,
    rootReady,
    storageOk,
    availableBytes,
    minFreeBytes,
    error,
  }
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
      status: "not_configured",
      ok: true,
      httpStatus: null,
      latencyMs: null,
      checkedAt: new Date().toISOString(),
      error: "SWIFT_WORKER_HEALTH_URL is not configured; Redis/BullMQ heartbeat remains the primary worker health signal.",
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
      status: healthy ? "healthy" : degraded ? "degraded_optional" : "degraded_optional",
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
      status: "degraded_optional",
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
    const storage = sandboxStorageDiagnostic(body)
    const healthy =
      response.httpStatus === 200 &&
      bodyOk &&
      storage.hasStorageDetail &&
      storage.rootReady &&
      storage.storageOk &&
      (bodyStatus === "healthy" || body.ok === true)
    const degraded = !healthy && (bodyStatus === "degraded" || (storage.hasStorageDetail && !storage.storageOk))

    return {
      configured: true,
      endpoint,
      status: healthy ? "healthy" : degraded ? "degraded" : "unhealthy",
      ok: healthy,
      httpStatus: response.httpStatus,
      latencyMs: response.latencyMs,
      checkedAt: new Date().toISOString(),
      detail: response.body,
      error: healthy ? null : storage.error || `Sandbox runtime returned status ${body.status || "unknown"}.`,
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

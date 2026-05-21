import { NextRequest, NextResponse } from "next/server"
import { randomUUID } from "node:crypto"
import { getDatabaseRuntimeDiagnostic, prisma } from "@/lib/db/client"
import { env, getMissingProductionEnvVars, validateEnv } from "@/lib/env"
import { ProviderRouter } from "@/lib/ai/provider-router"
import { getConfiguredSwiftModelIds } from "@/lib/ai/provider-health"
import { getGenerationQueueHealth } from "@/lib/queue/generation-queue"
import { log } from "@/lib/logging"
import { timeoutConfig } from "@/lib/timeouts"
import { getAuthRuntimeDiagnostic } from "@/lib/auth/runtime"
import { getDeploymentRuntimeReadiness, getProductionReadiness } from "@/lib/production/readiness"
import { getRuntimeHealthDashboard } from "@/lib/observability/runtime-recovery"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

type HealthCheck = {
  status: "healthy" | "degraded" | "unhealthy" | "disabled"
  latencyMs?: number
  detail?: unknown
}

type ProviderHealthSummary = {
  status: string
  cached?: boolean
}

async function timed<T>(fn: () => Promise<T>) {
  const startedAt = Date.now()
  const result = await fn()
  return {
    result,
    latencyMs: Date.now() - startedAt,
  }
}

async function withHealthTimeout<T>(name: string, timeoutMs: number, fn: () => Promise<T>): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | null = null
  try {
    return await Promise.race([
      fn(),
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error(`${name} timed out after ${timeoutMs}ms`)), timeoutMs)
      }),
    ])
  } finally {
    if (timeout) clearTimeout(timeout)
  }
}

async function checkDatabase(): Promise<HealthCheck> {
  const runtime = getDatabaseRuntimeDiagnostic()
  if (!runtime.ok) {
    return {
      status: "unhealthy",
      detail: runtime,
    }
  }

  try {
    const { latencyMs } = await timed(() =>
      withHealthTimeout("database health check", 2_000, () => prisma.$queryRaw`SELECT 1`)
    )
    return { status: "healthy", latencyMs }
  } catch (error) {
    return {
      status: "unhealthy",
      detail: error instanceof Error ? error.message : String(error),
    }
  }
}

async function checkQueue(): Promise<HealthCheck> {
  try {
    const { result, latencyMs } = await timed(() =>
      withHealthTimeout("queue health check", 2_000, () => getGenerationQueueHealth())
    )
    return {
      status: result.status === "healthy" ? "healthy" : result.status === "disabled" ? "disabled" : "degraded",
      latencyMs,
      detail: result,
    }
  } catch (error) {
    return {
      status: env.hasNativeRedisConfig ? "unhealthy" : "disabled",
      detail: error instanceof Error ? error.message : String(error),
    }
  }
}

async function checkProviders(refresh: boolean): Promise<HealthCheck> {
  try {
    const { result, latencyMs } = await timed(async () => {
      return withHealthTimeout<ProviderHealthSummary[]>(
        "provider health check",
        refresh ? timeoutConfig.healthProviderMs : 2_000,
        async () => {
          const providers = refresh
            ? await Promise.all(getConfiguredSwiftModelIds().map((modelId) => ProviderRouter.checkProviderHealth(modelId)))
            : await ProviderRouter.getConfiguredProviderHealth()
          return providers.map((provider) => ({
            ...provider,
            status: String(provider.status),
            cached: Boolean(provider.cached),
          }))
        }
      )
    })
    const hasHealthy = result.some((provider) => provider.status === "healthy")
    const hasDegraded = result.some((provider) => provider.status === "degraded")

    return {
      status: hasHealthy ? "healthy" : hasDegraded ? "degraded" : "unhealthy",
      latencyMs,
      detail: {
        cached: result.every((provider) => provider.cached),
        providers: result,
      },
    }
  } catch (error) {
    return {
      status: "unhealthy",
      detail: error instanceof Error ? error.message : String(error),
    }
  }
}

async function checkAuth(): Promise<HealthCheck> {
  const diagnostic = getAuthRuntimeDiagnostic()
  return {
    status: diagnostic.status,
    detail: diagnostic,
  }
}

async function checkDeploymentReadiness(): Promise<HealthCheck> {
  try {
    const readiness = await getDeploymentRuntimeReadiness()
    return {
      status: readiness.status === "blocked" ? "unhealthy" : readiness.status === "degraded" ? "degraded" : "healthy",
      detail: readiness,
    }
  } catch (error) {
    const fallback = getProductionReadiness()
    return {
      status: "unhealthy",
      detail: {
        ...fallback,
        runtimeError: error instanceof Error ? error.message : String(error),
      },
    }
  }
}

function okLabel(check: HealthCheck) {
  return check.status === "healthy" || check.status === "degraded" ? "ok" : check.status
}

function workerLabel(queue: HealthCheck) {
  if (queue.status === "disabled") return "disabled"
  if (queue.status === "unhealthy") return "unhealthy"

  const detail = queue.detail as { workerHeartbeat?: { ageMs?: number | null } | null } | undefined
  const ageMs = detail?.workerHeartbeat?.ageMs
  return typeof ageMs === "number" && ageMs <= 90_000 ? "ok" : "degraded"
}

export async function GET(request: NextRequest) {
  const startedAt = Date.now()
  const requestId = request.headers.get("x-request-id") || request.headers.get("x-vercel-id") || randomUUID()
  const coldStartProbe = request.nextUrl.searchParams.get("coldStart") === "true"
  const refreshProvider = request.nextUrl.searchParams.get("refreshProvider") === "true"

  if (coldStartProbe) {
    const envReport = validateEnv()
    return NextResponse.json({
      status: "healthy",
      database: "skipped",
      worker: "skipped",
      queue: "skipped",
      checkedAt: new Date().toISOString(),
      durationMs: Date.now() - startedAt,
      requestId,
      service: "swift-ai",
      environment: env.nodeEnv,
      checks: {
        startup: {
          status: "healthy",
          mode: "cold-start",
        },
        environment: {
          status: envReport.issues.every((issue) => issue.severity !== "error") ? "healthy" : "unhealthy",
          audit: {
            ok: envReport.ok,
            issues: envReport.issues.map((issue) => ({
              key: issue.key,
              severity: issue.severity,
              message: issue.message,
            })),
          },
        },
        auth: await checkAuth(),
        deployment: {
          status: getProductionReadiness().ok ? "healthy" : "unhealthy",
          detail: getProductionReadiness(),
        },
      },
    }, {
      headers: {
        "Cache-Control": "no-store",
        "X-Request-Id": requestId,
      },
    })
  }

  const [database, queue, providers, authCheck, deployment] = await Promise.all([
    checkDatabase(),
    checkQueue(),
    checkProviders(refreshProvider),
    checkAuth(),
    checkDeploymentReadiness(),
  ])
  const runtimeHealth = await getRuntimeHealthDashboard(1).catch((error) => ({
    status: "unhealthy",
    error: error instanceof Error ? error.message : String(error),
  }))
  const missingProductionEnv = env.nodeEnv === "production" ? getMissingProductionEnvVars() : []
  const envReport = validateEnv()
  const requiredHealthy =
    database.status !== "unhealthy" &&
    authCheck.status !== "unhealthy" &&
    deployment.status !== "unhealthy" &&
    missingProductionEnv.length === 0
  const operational =
    requiredHealthy &&
    queue.status !== "unhealthy" &&
    providers.status !== "unhealthy"
  const status = operational ? "healthy" : requiredHealthy ? "degraded" : "unhealthy"
  const durationMs = Date.now() - startedAt

  log(status === "unhealthy" ? "error" : status === "degraded" ? "warn" : "info", "Health check completed", {
    requestId,
    status,
    durationMs,
    database: database.status,
    auth: authCheck.status,
    deployment: deployment.status,
    queue: queue.status,
    providers: providers.status,
    runtimeHealth: runtimeHealth.status,
    missingProductionEnvCount: missingProductionEnv.length,
    envIssueCount: envReport.issues.length,
  })

  return NextResponse.json({
    status,
    database: okLabel(database),
    auth: okLabel(authCheck),
    deployment: okLabel(deployment),
    worker: workerLabel(queue),
    queue: okLabel(queue),
    checkedAt: new Date().toISOString(),
    durationMs,
    requestId,
    service: "swift-ai",
    environment: env.nodeEnv,
    checks: {
      database,
      auth: authCheck,
      deployment,
      queue,
      providers,
      runtimeHealth,
      environment: {
        status: missingProductionEnv.length === 0 && envReport.issues.every((issue) => issue.severity !== "error")
          ? "healthy"
          : "unhealthy",
        missingProductionEnv,
        audit: {
          ok: envReport.ok,
          issues: envReport.issues.map((issue) => ({
            key: issue.key,
            severity: issue.severity,
            message: issue.message,
          })),
        },
        runtime: {
          nodeEnv: env.nodeEnv,
          vercel: Boolean(process.env.VERCEL),
          region: process.env.VERCEL_REGION || null,
          generationExecutionMode: process.env.SWIFT_GENERATION_EXECUTION_MODE || "queue",
          aiTimeoutMs: env.aiTimeoutMs,
          aiQueueTimeoutMs: env.aiQueueTimeoutMs,
          timeouts: timeoutConfig,
          aiMaxRetries: env.aiMaxRetries,
          aiMaxConcurrentGenerations: env.aiMaxConcurrentGenerations,
        },
      },
    },
  }, {
    status: status === "unhealthy" ? 503 : 200,
    headers: {
      "Cache-Control": "no-store",
      "X-Request-Id": requestId,
    },
  })
}

import { NextRequest, NextResponse } from "next/server"
import { randomUUID } from "node:crypto"
import { prisma } from "@/lib/db/client"
import { env, getMissingProductionEnvVars, validateEnv } from "@/lib/env"
import { ProviderRouter } from "@/lib/ai/provider-router"
import { getConfiguredSwiftModelIds } from "@/lib/ai/provider-health"
import { getGenerationQueueHealth } from "@/lib/queue/generation-queue"
import { log } from "@/lib/logging"
import { timeoutConfig } from "@/lib/timeouts"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

type HealthCheck = {
  status: "healthy" | "degraded" | "unhealthy" | "disabled"
  latencyMs?: number
  detail?: unknown
}

async function timed<T>(fn: () => Promise<T>) {
  const startedAt = Date.now()
  const result = await fn()
  return {
    result,
    latencyMs: Date.now() - startedAt,
  }
}

async function checkDatabase(): Promise<HealthCheck> {
  try {
    const { latencyMs } = await timed(() => prisma.$queryRaw`SELECT 1`)
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
    const { result, latencyMs } = await timed(() => getGenerationQueueHealth())
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
    const { result, latencyMs } = await timed(async () =>
      refresh
        ? Promise.all(getConfiguredSwiftModelIds().map((modelId) => ProviderRouter.checkProviderHealth(modelId)))
        : ProviderRouter.getConfiguredProviderHealth()
    )
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

export async function GET(request: NextRequest) {
  const startedAt = Date.now()
  const requestId = request.headers.get("x-request-id") || request.headers.get("x-vercel-id") || randomUUID()
  const refreshProvider = request.nextUrl.searchParams.get("refreshProvider") === "true"
  const [database, queue, providers] = await Promise.all([
    checkDatabase(),
    checkQueue(),
    checkProviders(refreshProvider),
  ])
  const missingProductionEnv = env.nodeEnv === "production" ? getMissingProductionEnvVars() : []
  const envReport = validateEnv()
  const requiredHealthy = database.status !== "unhealthy" && missingProductionEnv.length === 0
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
    queue: queue.status,
    providers: providers.status,
    missingProductionEnvCount: missingProductionEnv.length,
    envIssueCount: envReport.issues.length,
  })

  return NextResponse.json({
    status,
    checkedAt: new Date().toISOString(),
    durationMs,
    requestId,
    service: "swift-ai",
    environment: env.nodeEnv,
    checks: {
      database,
      queue,
      providers,
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
          generationExecutionMode: process.env.SWIFT_GENERATION_EXECUTION_MODE || (process.env.VERCEL ? "serverless" : "queue"),
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

import { randomUUID } from "node:crypto"
import { NextRequest, NextResponse } from "next/server"
import { auth } from "@/auth"
import { prisma } from "@/lib/db/client"
import { ProviderRouter } from "@/lib/ai/provider-router"
import { getConfiguredSwiftModelIds } from "@/lib/ai/provider-health"
import { getGenerationQueueHealth } from "@/lib/queue/generation-queue"
import { log } from "@/lib/logging"
import { getExecutionTraceSnapshot } from "@/lib/observability/execution-tracer"
import { monitorOperation } from "@/lib/observability/performance-monitor"
import { getRuntimeMetricsSnapshot, recordPrismaDuration } from "@/lib/observability/runtime-metrics"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

async function requireDebugAccess() {
  if (process.env.NODE_ENV !== "production") return { ok: true, status: 200 }
  const session = await auth()
  const email = session?.user?.email
  if (!email) return { ok: false, status: 401 }
  const user = await prisma.user.findUnique({
    where: { email },
    select: { isDeveloperAccount: true },
  })
  return { ok: Boolean(user?.isDeveloperAccount), status: user?.isDeveloperAccount ? 200 : 403 }
}

async function checkPrisma() {
  const startedAt = Date.now()
  try {
    await monitorOperation("prisma", "debug_prisma_health", () => prisma.$queryRaw`SELECT 1`)
    const latencyMs = Date.now() - startedAt
    recordPrismaDuration(latencyMs, { operation: "debugRuntimeHealth" })
    return { status: "healthy", latencyMs }
  } catch (error) {
    return {
      status: "unhealthy",
      latencyMs: Date.now() - startedAt,
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

async function checkOpenRouter() {
  try {
    const providers = await Promise.all(
      getConfiguredSwiftModelIds().map((modelId) => ProviderRouter.checkProviderHealth(modelId))
    )
    return {
      status: providers.some((provider) => provider.status === "healthy") ? "healthy" : "degraded",
      providers,
    }
  } catch (error) {
    return {
      status: "unhealthy",
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

export async function GET(request: NextRequest) {
  const requestId = request.headers.get("x-request-id") || randomUUID()
  const access = await requireDebugAccess()
  if (!access.ok) {
    return NextResponse.json({ error: "Not authorized", requestId }, { status: access.status })
  }

  const traceId = request.nextUrl.searchParams.get("traceId") || undefined
  const taskId = request.nextUrl.searchParams.get("taskId") || undefined
  const correlationId = request.nextUrl.searchParams.get("correlationId") || undefined
  const [queue, prismaHealth, openRouter] = await Promise.all([
    getGenerationQueueHealth().catch((error) => ({
      status: "unhealthy",
      error: error instanceof Error ? error.message : String(error),
    })),
    checkPrisma(),
    checkOpenRouter(),
  ])
  const metrics = getRuntimeMetricsSnapshot()

  const response = {
    requestId,
    checkedAt: new Date().toISOString(),
    workerHealth: {
      status: "workerHeartbeat" in queue && queue.workerHeartbeat ? queue.status : "unknown",
      heartbeat: "workerHeartbeat" in queue ? queue.workerHeartbeat : null,
    },
    queueDepth: "counts" in queue ? queue.counts : null,
    activeGenerations: metrics.activeGenerations,
    retryCounts: {
      totalRetryEvents: metrics.counts.retryEvents,
      retryFrequencyPct: metrics.rates.retryFrequencyPct,
    },
    memory: metrics.memory,
    redisHealth: "redis" in queue ? queue.redis : null,
    prismaHealth,
    openRouterStatus: openRouter,
    performance: {
      averages: metrics.averages,
      rates: metrics.rates,
      counts: metrics.counts,
    },
    traces: getExecutionTraceSnapshot({ taskId, traceId, correlationId }),
  }

  log("info", "debug_runtime_snapshot", {
    requestId,
    activeGenerations: metrics.activeGenerations.length,
    queueStatus: queue.status,
    prismaStatus: prismaHealth.status,
    openRouterStatus: openRouter.status,
  })

  return NextResponse.json(response, {
    headers: {
      "Cache-Control": "no-store",
      "X-Request-Id": requestId,
    },
  })
}

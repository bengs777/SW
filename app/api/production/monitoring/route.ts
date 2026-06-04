import { NextRequest, NextResponse } from "next/server"
import { getDatabasePoolUsage, prisma } from "@/lib/db/client"
import { getDatabaseMetricsSnapshot } from "@/lib/db/metrics"
import { getDatabaseCircuitState } from "@/lib/db/circuit-breaker"
import { ProviderRouter } from "@/lib/ai/provider-router"
import { getProviderMetricsSnapshot } from "@/lib/ai/provider-metrics"
import { getProviderCircuitState } from "@/lib/ai/provider-circuit-breaker"
import { getActiveSwiftModelChain } from "@/lib/ai/swift-tiers"
import { getGenerationQueueHealth } from "@/lib/queue/generation-queue"
import { getRuntimeMetricsSnapshot } from "@/lib/observability/runtime-metrics"
import { getMemoryUsageSnapshot } from "@/lib/observability/performance-monitor"
import { hasValidObservabilityToken } from "@/lib/security/internal-observability"
import { requireDeveloperActorResponse } from "@/lib/admin"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export async function GET(request: NextRequest) {
  if (!hasValidObservabilityToken(request)) {
    const actorResult = await requireDeveloperActorResponse()
    if ("error" in actorResult) {
      return actorResult.error
    }
  }

  const since = new Date(Date.now() - 24 * 60 * 60 * 1000)
  const [queue, provider, generationCounts, runtimeMetrics] = await Promise.all([
    getGenerationQueueHealth().catch((error) => ({
      status: "unhealthy",
      error: error instanceof Error ? error.message : String(error),
    })),
    ProviderRouter.getConfiguredProviderHealth().catch((error) => ({
      status: "unhealthy",
      error: error instanceof Error ? error.message : String(error),
    })),
    prisma.generationJob.groupBy({
      by: ["status"],
      where: { createdAt: { gte: since } },
      _count: { _all: true },
    }).catch(() => []),
    Promise.resolve(getRuntimeMetricsSnapshot()),
  ])

  const totalGenerations = generationCounts.reduce((sum, item) => sum + item._count._all, 0)
  const completedGenerations = generationCounts
    .filter((item) => item.status === "completed")
    .reduce((sum, item) => sum + item._count._all, 0)
  const failedGenerations = generationCounts
    .filter((item) => ["failed", "dead_lettered", "cancelled"].includes(item.status))
    .reduce((sum, item) => sum + item._count._all, 0)

  return NextResponse.json({
    status:
      (queue as { status?: string }).status === "healthy" &&
      Array.isArray(provider) &&
      provider.some((item) => item.status === "healthy")
        ? "healthy"
        : "degraded",
    checkedAt: new Date().toISOString(),
    queueHealth: queue,
    workerHealth: {
      status: (queue as { status?: string }).status || "unknown",
      heartbeat: (queue as { workerHeartbeat?: unknown }).workerHeartbeat || null,
    },
    providerHealth: provider,
    providerChain: getActiveSwiftModelChain(),
    providerMetrics: getProviderMetricsSnapshot(),
    providerCircuitBreaker: getProviderCircuitState("openrouter"),
    generationSuccess: {
      window: "24h",
      total: totalGenerations,
      completed: completedGenerations,
      failed: failedGenerations,
      successRate: totalGenerations === 0 ? 0 : Math.round((completedGenerations / totalGenerations) * 1000) / 10,
    },
    runtimeFailures: {
      validationFailureRatePct: runtimeMetrics.rates.validationFailureRatePct,
      retryFrequencyPct: runtimeMetrics.rates.retryFrequencyPct,
    },
    memoryUsage: getMemoryUsageSnapshot(),
    databaseHealth: {
      pool: await getDatabasePoolUsage(),
      metrics: getDatabaseMetricsSnapshot(),
      circuitBreaker: getDatabaseCircuitState(),
    },
    runtimeMetrics,
  })
}

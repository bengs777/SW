import { NextRequest, NextResponse } from "next/server"
import { ProviderRouter } from "@/lib/ai/provider-router"
import { getProviderMetricsSnapshot } from "@/lib/ai/provider-metrics"
import { getProviderCircuitState } from "@/lib/ai/provider-circuit-breaker"
import { getActiveSwiftModelChain } from "@/lib/ai/swift-tiers"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export async function GET(request: NextRequest) {
  const chain = getActiveSwiftModelChain()
  const model = request.nextUrl.searchParams.get("model")?.trim() || chain[0]?.replace(/^(openrouter|agentrouter):/i, "") || ""

  if (!model) {
    return NextResponse.json(
      {
        provider: "openrouter",
        status: "offline",
        model: null,
        latencyMs: 0,
        error: "No Swift AI model chain is configured",
        providerChain: chain,
        circuitBreaker: getProviderCircuitState("openrouter"),
        metrics: getProviderMetricsSnapshot(),
      },
      { status: 503 }
    )
  }

  const result = await ProviderRouter.checkProviderHealth(model)
  const status = result.status === "healthy" ? "healthy" : result.status === "degraded" ? "degraded" : "offline"

  return NextResponse.json(
    {
      provider: "openrouter",
      status,
      model,
      latencyMs: result.latencyMs || 0,
      providerChain: chain,
      circuitBreaker: getProviderCircuitState("openrouter"),
      metrics: getProviderMetricsSnapshot(),
      checkedAt: result.checkedAt || new Date().toISOString(),
      ...(result.failureReason ? { failureReason: result.failureReason } : {}),
      ...(result.message ? { message: result.message } : {}),
    },
    { status: status === "offline" ? 503 : 200 }
  )
}

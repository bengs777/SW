import { NextRequest, NextResponse } from "next/server"
import { auth } from "@/auth"
import { ModelConfigService } from "@/lib/services/model-config.service"
import { ProviderRouter } from "@/lib/ai/provider-router"
import { getConfiguredSwiftModelIds } from "@/lib/ai/provider-health"

type PublicProviderState = "connected" | "slow" | "timeout"

export async function GET(request: NextRequest) {
  const session = await auth()
  if (!session?.user?.email) {
    return NextResponse.json({ error: "Authentication required" }, { status: 401 })
  }

  const modelKey = request.nextUrl.searchParams.get("modelKey")?.trim()
  if (!modelKey) {
    return NextResponse.json({ error: "modelKey is required" }, { status: 400 })
  }

  const model = await ModelConfigService.getActiveModelByKey(modelKey)
  if (!model) {
    return NextResponse.json({ error: "Model not available" }, { status: 404 })
  }

  const providers = request.nextUrl.searchParams.get("refresh") === "true"
    ? await Promise.all(getConfiguredSwiftModelIds().map((modelId) => ProviderRouter.checkProviderHealth(modelId)))
    : await ProviderRouter.getConfiguredProviderHealth()
  const hasHealthy = providers.some((provider) => provider.status === "healthy")
  const hasDegraded = providers.some((provider) => provider.status === "degraded")
  const status: PublicProviderState = hasHealthy ? "connected" : hasDegraded ? "slow" : "timeout"

  return NextResponse.json({
    modelKey,
    status,
    issue: hasHealthy ? "healthy" : hasDegraded ? "latency" : "unknown",
    checkedAt: new Date().toISOString(),
    responseTimeMs: providers.reduce((max, provider) => Math.max(max, provider.latencyMs || 0), 0),
    reason: hasHealthy
      ? "Swift AI engine is ready"
      : hasDegraded
        ? "Swift AI engine is available through a slower fallback path"
        : "Swift AI engine is temporarily unavailable",
    action: hasHealthy
      ? "Swift siap dipakai."
      : hasDegraded
        ? "Generate tetap bisa dicoba, atau pilih Swift 1 untuk mode lebih cepat."
        : "Coba lagi sebentar lagi. Saldo akan otomatis dikembalikan jika generate gagal.",
    provider: "swift",
    modelName: model.key,
    usedFallback: hasDegraded,
    cached: providers.every((provider) => provider.cached),
  })
}

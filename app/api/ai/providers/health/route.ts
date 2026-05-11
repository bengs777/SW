import { NextRequest, NextResponse } from "next/server"
import { requireDeveloperActorResponse } from "@/lib/admin"
import { ProviderRouter } from "@/lib/ai/provider-router"
import { getConfiguredSwiftModelIds } from "@/lib/ai/provider-health"

export const runtime = "nodejs"

export async function GET(request: NextRequest) {
  const actorResult = await requireDeveloperActorResponse()
  if ("error" in actorResult) {
    return actorResult.error
  }

  const refresh = request.nextUrl.searchParams.get("refresh") === "1"
  const providers = refresh
    ? await Promise.all(getConfiguredSwiftModelIds().map((modelId) => ProviderRouter.checkProviderHealth(modelId)))
    : await ProviderRouter.getConfiguredProviderHealth()

  const status =
    providers.length === 0
      ? "offline"
      : providers.some((provider) => provider.status === "healthy")
        ? providers.some((provider) => provider.status !== "healthy")
          ? "degraded"
          : "healthy"
        : "offline"

  return NextResponse.json({
    ok: status !== "offline",
    status,
    providers,
    checkedAt: new Date().toISOString(),
  })
}

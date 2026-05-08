import { NextResponse } from "next/server"
import { auth } from "@/auth"
import { ModelConfigService } from "@/lib/services/model-config.service"
import { env } from "@/lib/env"
import { SWIFT_AI_DISPLAY_NAME, getModelDisplayMeta } from "@/lib/ai/models"
import { AGENTROUTER_PROVIDER, AGENTROUTER_PUBLIC_NAME } from "@/lib/ai/agentrouter-config"
import { OPENROUTER_PROVIDER } from "@/lib/ai/openrouter-config"

function isProviderReady(provider: string) {
  if (provider === OPENROUTER_PROVIDER) return Boolean(env.openRouterApiKey)
  if (provider === AGENTROUTER_PROVIDER) return Boolean(env.agentRouterApiKey)
  return false
}

function getBilledProviderLabel(provider: string) {
  if (provider === AGENTROUTER_PROVIDER) return AGENTROUTER_PUBLIC_NAME
  return SWIFT_AI_DISPLAY_NAME
}

export async function GET() {
  const session = await auth()

  if (!session?.user?.email) {
    return NextResponse.json({ error: "Authentication required" }, { status: 401 })
  }

  const models = await ModelConfigService.getActiveModels()

  return NextResponse.json({
    models: models
      .filter((model) => isProviderReady(model.provider))
      .map((model) => ({
          ...model,
          ...getModelDisplayMeta(model.key),
          billedProviderLabel: getBilledProviderLabel(model.provider),
        })),
  })
}

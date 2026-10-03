import { NextResponse } from "next/server"
import { getSession } from "@/auth"
import { ModelConfigService } from "@/lib/services/model-config.service"
import { SWIFT_AI_DISPLAY_NAME, getModelDisplayMeta } from "@/lib/ai/models"

export async function GET() {
  const session = await getSession()

  if (!session?.email) {
    return NextResponse.json({ error: "Authentication required" }, { status: 401 })
  }

  const models = await ModelConfigService.getActiveModels()

  return NextResponse.json({
    models: models
      .map((model) => ({
          ...model,
          ...getModelDisplayMeta(model.key),
          provider: "swift",
          billedProviderLabel: SWIFT_AI_DISPLAY_NAME,
        })),
  })
}

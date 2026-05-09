import type { ModelOption } from "@/lib/types"
import { DEFAULT_MODEL_OPTIONS } from "@/lib/ai/models"
import { AGENTROUTER_PROVIDER } from "@/lib/ai/agentrouter-config"
import { OPENROUTER_PROVIDER } from "@/lib/ai/openrouter-config"
import { env } from "@/lib/env"

export function getRuntimeModelOptions(): ModelOption[] {
  return DEFAULT_MODEL_OPTIONS.filter((model) => {
    if (model.provider === AGENTROUTER_PROVIDER && !env.agentRouterApiKey) return false
    if (model.provider === OPENROUTER_PROVIDER && !env.openRouterApiKey) return false
    return true
  })
}

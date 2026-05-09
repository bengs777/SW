import { env } from "@/lib/env"
import { OPENROUTER_MODEL_ID, OPENROUTER_PROVIDER } from "@/lib/ai/openrouter-config"
import { AGENTROUTER_PROVIDER } from "@/lib/ai/agentrouter-config"

export function chooseModelForTask(purpose: "generate" | "inspect") {
  // inspect (debugging) prefers OpenRouter (strong) when available
  if (purpose === "inspect") {
    if (env.openRouterApiKey) return { provider: OPENROUTER_PROVIDER, modelName: OPENROUTER_MODEL_ID }
    if (env.agentRouterApiKey) return { provider: AGENTROUTER_PROVIDER, modelName: env.agentRouterFallbackModels[0] || "deepseek-v3.2" }
    throw new Error("No AI provider configured for inspect")
  }

  // generation is locked to OpenRouter DeepSeek Flash when configured.
  if (env.openRouterApiKey) return { provider: OPENROUTER_PROVIDER, modelName: OPENROUTER_MODEL_ID }

  if (env.agentRouterApiKey) {
    return { provider: AGENTROUTER_PROVIDER, modelName: env.agentRouterFallbackModels[0] || "deepseek-v3.2" }
  }

  throw new Error("No AI provider configured for generate")
}

export default { chooseModelForTask }

import { env } from "@/lib/env"

export const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1"
export const OPENROUTER_PROVIDER = "openrouter"
export const OPENROUTER_DEFAULT_MODEL = "poolside/laguna-m.1:free"
export const OPENROUTER_DEFAULT_FALLBACK_MODELS = [
  "openrouter/owl-alpha",
  "poolside/laguna-xs.2:free",
]
export const PUBLIC_AI_NAME = "Swift AI"
export const BASIC_PROMPT_FEE_IDR = 3000
export const BUILD_PROMPT_FEE_IDR = 3000
export const PRO_PROMPT_FEE_IDR = 3000
export const PROMPT_FEE_IDR = BASIC_PROMPT_FEE_IDR

function uniqueModels(modelIds: string[]) {
  const seen = new Set<string>()
  return modelIds.filter((modelId) => {
    const normalized = modelId.trim()
    if (!normalized || seen.has(normalized)) return false
    seen.add(normalized)
    return true
  })
}

export function normalizeOpenRouterModelId(modelSpec: string) {
  return modelSpec.replace(/^openrouter:/i, "").trim()
}

export function getOpenRouterModel() {
  return normalizeOpenRouterModelId(process.env.OPENROUTER_MODEL || OPENROUTER_DEFAULT_MODEL)
}

export function getOpenRouterModelChain() {
  return uniqueModels([
    getOpenRouterModel(),
    ...OPENROUTER_DEFAULT_FALLBACK_MODELS.map(normalizeOpenRouterModelId),
  ])
}

export function getOpenRouterConfig() {
  return {
    apiKey: env.openRouterApiKey,
    model: getOpenRouterModel(),
    modelChain: getOpenRouterModelChain(),
    baseUrl: env.openRouterBaseUrl || OPENROUTER_BASE_URL,
    siteUrl: env.openRouterSiteUrl,
    appName: env.openRouterAppName,
    provider: OPENROUTER_PROVIDER,
    publicName: PUBLIC_AI_NAME,
  }
}

export function assertOpenRouterReady() {
  const config = getOpenRouterConfig()

  if (!config.apiKey) {
    throw new Error("OPENROUTER_API_KEY is not configured")
  }

  return config
}

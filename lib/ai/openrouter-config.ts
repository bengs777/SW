import { env } from "@/lib/env"

export const OPENROUTER_BASE_URL = "https://agentrouter.org/v1"
export const OPENROUTER_PROVIDER = "agentrouter"
export const OPENROUTER_DEFAULT_MODEL = "glm-5.1"
export const OPENROUTER_DEFAULT_FALLBACK_MODELS: string[] = []
const OPENROUTER_FALLBACK_ENV_KEYS: string[] = []
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
  return modelSpec.replace(/^(openrouter|agentrouter):/i, "").trim()
}

export function getOpenRouterModel() {
  return normalizeOpenRouterModelId(process.env.AGENTROUTER_MODEL || OPENROUTER_DEFAULT_MODEL)
}

export function getOpenRouterModelChain() {
  const configuredPrimaryModel = getOpenRouterModel()
  const configuredFallbackModels = OPENROUTER_FALLBACK_ENV_KEYS
    .map((key) => process.env[key] || "")
    .filter(Boolean)

  return uniqueModels([
    configuredPrimaryModel,
    ...configuredFallbackModels.map(normalizeOpenRouterModelId),
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
    throw new Error("AGENTROUTER_API_KEY or OPENROUTER_API_KEY is not configured")
  }

  return config
}

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
const PRODUCTION_BLOCKED_MODEL_RE = /\b(poolside\/laguna|openrouter\/owl-alpha|owl-alpha)\b/i
const DEPRECATED_MODEL_ENV_KEYS = [
  "OPENROUTER_FREE_MODEL",
  "OPENROUTER_MODEL_ID",
  "SWIFT_FALLBACK_MODEL_1",
  "AGENTROUTER_FALLBACK_MODEL",
  "AGENTROUTER_FALLBACK_MODELS",
  "OPENROUTER_FALLBACK_MODEL",
  "OPENROUTER_FALLBACK_MODELS",
]

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

function configuredModelChainFromEnv() {
  return (process.env.SWIFT_AI_MODEL_CHAIN || "")
    .split(",")
    .map(normalizeOpenRouterModelId)
    .filter(Boolean)
}

function assertProductionModelConfig(modelIds: string[]) {
  if (process.env.NODE_ENV !== "production" || process.env.SWIFT_ALLOW_LEGACY_PROVIDER_MODELS === "true") {
    return
  }

  const deprecatedEnvKey = DEPRECATED_MODEL_ENV_KEYS.find((key) => Boolean(process.env[key]?.trim()))
  if (deprecatedEnvKey) {
    throw new Error(
      `Deprecated production model env ${deprecatedEnvKey} is configured. Use AGENTROUTER_MODEL=glm-5.1 and SWIFT_AI_MODEL_CHAIN=agentrouter:glm-5.1.`
    )
  }

  const blockedModel = modelIds.find((modelId) => PRODUCTION_BLOCKED_MODEL_RE.test(modelId))
  if (blockedModel) {
    throw new Error(
      `Blocked production AgentRouter model configured: ${blockedModel}. Use AGENTROUTER_MODEL=glm-5.1 and SWIFT_AI_MODEL_CHAIN=agentrouter:glm-5.1.`
    )
  }
}

export function getOpenRouterModel() {
  const [firstChainModel] = configuredModelChainFromEnv()
  return normalizeOpenRouterModelId(
    process.env.AGENTROUTER_MODEL || process.env.OPENROUTER_MODEL || firstChainModel || OPENROUTER_DEFAULT_MODEL
  )
}

export function getOpenRouterModelChain() {
  const configuredPrimaryModel = getOpenRouterModel()
  const configuredChainModels = configuredModelChainFromEnv()
  const configuredFallbackModels = OPENROUTER_FALLBACK_ENV_KEYS
    .map((key) => process.env[key] || "")
    .filter(Boolean)

  const chain = uniqueModels([
    configuredPrimaryModel,
    ...configuredChainModels,
    ...configuredFallbackModels.map(normalizeOpenRouterModelId),
    ...OPENROUTER_DEFAULT_FALLBACK_MODELS.map(normalizeOpenRouterModelId),
  ])
  assertProductionModelConfig(chain)
  return chain
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

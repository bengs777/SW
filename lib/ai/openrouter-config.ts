import { env } from "@/lib/env"

export const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1"
export const OPENROUTER_MODEL_ID = "deepseek/deepseek-v4-flash"
export const OPENROUTER_PROVIDER = "openrouter"
export const PUBLIC_AI_NAME = "Swift AI"
export const BASIC_PROMPT_FEE_IDR = 2000
export const BUILD_PROMPT_FEE_IDR = 5000
export const PRO_PROMPT_FEE_IDR = 15000
export const PROMPT_FEE_IDR = BASIC_PROMPT_FEE_IDR

export function getOpenRouterConfig() {
  return {
    apiKey: env.openRouterApiKey,
    baseUrl: OPENROUTER_BASE_URL,
    model: OPENROUTER_MODEL_ID,
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

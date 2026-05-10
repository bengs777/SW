import { env } from "@/lib/env"

export const SWIFT_PROVIDER = "swift"
export const SWIFT_1_MODEL_KEY = "swift-1"
export const SWIFT_2_MODEL_KEY = "swift-2"
export const SWIFT_3_MODEL_KEY = "swift-3"
export const DEFAULT_SWIFT_TIER_KEY = SWIFT_2_MODEL_KEY

export type SwiftTierKey =
  | typeof SWIFT_1_MODEL_KEY
  | typeof SWIFT_2_MODEL_KEY
  | typeof SWIFT_3_MODEL_KEY

export type InternalProviderName =
  | "gemini"
  | "deepseek"
  | "openrouter"
  | "openai"
  | "agentrouter"

export type ProviderHealthStatus = "healthy" | "degraded" | "offline"
export type ProviderFailureReason =
  | "auth"
  | "rate_limit"
  | "timeout"
  | "network"
  | "empty_response"
  | "config"
  | "server_error"
  | "unknown"

export type SwiftProviderTarget = {
  provider: InternalProviderName
  modelName: string
  role: string
}

export type SwiftTierConfig = {
  key: SwiftTierKey
  label: string
  shortLabel: string
  description: string
  note: string
  price: number
  timeoutMs: number
  maxOutputTokens: number
  rank: number
  targets: SwiftProviderTarget[]
}

export const USER_FRIENDLY_AI_ENGINE_ERROR =
  "Swift sedang mengalami gangguan sementara pada AI engine. Credit kamu otomatis dikembalikan jika generate gagal. Coba lagi sebentar lagi atau pilih Swift 1 untuk mode lebih cepat."

function getEnvValue(...keys: string[]) {
  for (const key of keys) {
    const value = process.env[key]
    if (value && value.trim()) {
      return value.trim()
    }
  }

  return ""
}

export function hasProviderKey(provider: InternalProviderName) {
  if (provider === "gemini") return Boolean(env.geminiApiKey)
  if (provider === "deepseek") return Boolean(env.deepSeekApiKey)
  if (provider === "openrouter") return Boolean(env.openRouterApiKey)
  if (provider === "openai") return Boolean(env.openAiApiKey)
  if (provider === "agentrouter") return Boolean(env.agentRouterApiKey)
  return false
}

export function hasAnyPrimaryProviderKey() {
  return Boolean(env.openRouterApiKey || env.geminiApiKey || env.deepSeekApiKey || env.openAiApiKey)
}

export function getSwiftTierConfigs(): SwiftTierConfig[] {
  const geminiFlash = getEnvValue("GEMINI_FLASH_MODEL_ID", "GEMINI_MODEL_ID") || "gemini-2.5-flash"
  const deepSeekChat = getEnvValue("DEEPSEEK_CHAT_MODEL_ID", "DEEPSEEK_MODEL_ID") || "deepseek-chat"
  const deepSeekReasoner = getEnvValue("DEEPSEEK_REASONER_MODEL_ID") || "deepseek-reasoner"
  const openRouterFast = getEnvValue("OPENROUTER_FAST_MODEL_ID", "OPENROUTER_MODEL_ID") || "deepseek/deepseek-v4-flash"
  const openRouterClaude =
    getEnvValue("OPENROUTER_CLAUDE_MODEL_ID", "OPENROUTER_BUILDER_MODEL_ID") ||
    "anthropic/claude-sonnet-4.5"
  const openAiModel = getEnvValue("OPENAI_DEFAULT_MODEL", "OPENAI_MODEL_ID") || "gpt-4.1"

  return [
    {
      key: SWIFT_1_MODEL_KEY,
      label: "Swift 1 — Fast",
      shortLabel: "Swift 1",
      description: "cepat dan hemat",
      note: "Untuk landing page, UI section, dashboard, CRUD sederhana, dan ecommerce basic.",
      price: 1,
      timeoutMs: 15_000,
      maxOutputTokens: 4000,
      rank: 1,
      targets: [
        { provider: "gemini", modelName: geminiFlash, role: "primary" },
        { provider: "deepseek", modelName: deepSeekChat, role: "fallback" },
        { provider: "openrouter", modelName: openRouterFast, role: "fallback" },
      ],
    },
    {
      key: SWIFT_2_MODEL_KEY,
      label: "Swift 2 — Builder",
      shortLabel: "Swift 2",
      description: "cocok untuk fullstack",
      note: "Untuk fullstack app, auth, database, API route, Prisma, dan repair ringan.",
      price: 5,
      timeoutMs: 25_000,
      maxOutputTokens: 8000,
      rank: 2,
      targets: [
        { provider: "deepseek", modelName: deepSeekReasoner, role: "primary" },
        { provider: "deepseek", modelName: deepSeekChat, role: "fallback" },
        { provider: "gemini", modelName: geminiFlash, role: "fallback" },
        { provider: "openrouter", modelName: openRouterClaude, role: "fallback" },
      ],
    },
    {
      key: SWIFT_3_MODEL_KEY,
      label: "Swift 3 — Engineer",
      shortLabel: "Swift 3",
      description: "terbaik untuk debug dan production hardening",
      note: "Untuk autonomous repair, debugging sulit, architecture, optimization, dan production hardening.",
      price: 15,
      timeoutMs: 45_000,
      maxOutputTokens: 16000,
      rank: 3,
      targets: [
        { provider: "openrouter", modelName: openRouterClaude, role: "primary" },
        { provider: "openai", modelName: openAiModel, role: "fallback" },
        { provider: "deepseek", modelName: deepSeekReasoner, role: "fallback" },
        { provider: "deepseek", modelName: deepSeekChat, role: "fallback" },
      ],
    },
  ]
}

export function getSwiftTierConfig(key: string | null | undefined) {
  return getSwiftTierConfigs().find((tier) => tier.key === key) || null
}

export function isSwiftTierKey(key: string | null | undefined): key is SwiftTierKey {
  return Boolean(key && getSwiftTierConfig(key))
}

export function getDefaultSwiftTier() {
  return getSwiftTierConfig(DEFAULT_SWIFT_TIER_KEY) || getSwiftTierConfigs()[1]
}

export function getSwiftTierOptions() {
  return getSwiftTierConfigs().map((tier) => ({
    key: tier.key,
    label: tier.label,
    provider: SWIFT_PROVIDER,
    modelName: tier.key,
    price: tier.price,
    isActive: true,
    rank: tier.rank,
    description: tier.description,
    note: tier.note,
  }))
}

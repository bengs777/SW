export const SWIFT_PROVIDER = "swift"
export const SWIFT_2_MODEL_KEY = "swift-2"
export const DEFAULT_SWIFT_TIER_KEY = SWIFT_2_MODEL_KEY
export const DEEPSEEK_V4_FLASH_MODEL_ID = "deepseek/deepseek-v4-flash"
export const DEEPSEEK_V4_FLASH_NITRO_MODEL_ID = "deepseek/deepseek-v4-flash:nitro"

export type SwiftTierKey = typeof SWIFT_2_MODEL_KEY

export type ProviderHealthStatus = "healthy" | "degraded" | "offline"
export type ProviderFailureReason =
  | "auth"
  | "rate_limit"
  | "timeout"
  | "network"
  | "empty_response"
  | "config"
  | "server_error"
  | "invalid_output"
  | "cancelled"
  | "overloaded"
  | "unknown"

export type SwiftModelTarget = {
  modelId: string
  role: "primary" | "fallback"
}

export type SwiftTierConfig = {
  key: SwiftTierKey
  label: string
  shortLabel: string
  description: string
  note: string
  priceIdr: number
  price: number
  timeoutMs: number
  maxOutputTokens: number
  rank: number
  targets: SwiftModelTarget[]
  queue: {
    concurrency: number
    maxQueueDepth: number
  }
}

export const USER_FRIENDLY_AI_ENGINE_ERROR =
  "Swift AI sedang mengalami gangguan sementara. Saldo Rupiah kamu otomatis dikembalikan jika generate gagal. Coba lagi sebentar lagi."

export const USER_FRIENDLY_QUEUE_OVERLOAD_ERROR =
  "Swift sedang ramai. Coba lagi sebentar lagi."

export function getSwiftTierConfigs(): SwiftTierConfig[] {
  return [
    {
      key: SWIFT_2_MODEL_KEY,
      label: "Swift AI",
      shortLabel: "Swift",
      description: "AI utama Swift untuk chat, generate, debug, dan build fullstack.",
      note: "Satu-satunya AI aktif di Swift.",
      priceIdr: 4000,
      price: 4000,
      timeoutMs: 120_000,
      maxOutputTokens: 8000,
      rank: 1,
      queue: { concurrency: 4, maxQueueDepth: 50 },
      targets: [
        { modelId: DEEPSEEK_V4_FLASH_MODEL_ID, role: "primary" },
        { modelId: DEEPSEEK_V4_FLASH_NITRO_MODEL_ID, role: "fallback" },
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
  return getSwiftTierConfig(DEFAULT_SWIFT_TIER_KEY) || getSwiftTierConfigs()[0]
}

export function hasOpenRouterGatewayKey() {
  return Boolean(process.env.OPENROUTER_API_KEY?.trim())
}

export function getSwiftTierOptions() {
  return getSwiftTierConfigs().map((tier) => ({
    key: tier.key,
    label: tier.label,
    provider: SWIFT_PROVIDER,
    modelName: tier.key,
    price: tier.priceIdr,
    priceIdr: tier.priceIdr,
    isActive: true,
    rank: tier.rank,
    description: tier.description,
    note: tier.note,
  }))
}

/**
 * Maps the internal DeepSeek V4 Flash model ID to its Swift tier key.
 * Used to sanitize public API responses so they never expose provider names or internal model IDs.
 */
export function mapModelIdToTierKey(modelId: string): string | null {
  const configs = getSwiftTierConfigs()
  for (const tier of configs) {
    for (const target of tier.targets) {
      if (target.modelId === modelId) {
        return tier.key
      }
    }
  }
  return null
}

/**
 * Returns the public-facing provider name for all Swift tiers.
 * This should always be "swift" - never expose OpenRouter or underlying providers.
 */
export function getPublicProviderName(): string {
  return SWIFT_PROVIDER
}

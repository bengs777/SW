export const SWIFT_PROVIDER = "swift"
export const SWIFT_1_MODEL_KEY = "swift-1"
export const SWIFT_2_MODEL_KEY = "swift-2"
export const SWIFT_3_MODEL_KEY = "swift-3"
export const DEFAULT_SWIFT_TIER_KEY = SWIFT_2_MODEL_KEY

export type SwiftTierKey =
  | typeof SWIFT_1_MODEL_KEY
  | typeof SWIFT_2_MODEL_KEY
  | typeof SWIFT_3_MODEL_KEY

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
  "Swift sedang mengalami gangguan sementara pada AI engine. Saldo Rupiah kamu otomatis dikembalikan jika generate gagal. Coba lagi sebentar lagi atau pilih Swift 1 untuk mode lebih cepat."

export const USER_FRIENDLY_QUEUE_OVERLOAD_ERROR =
  "Swift sedang ramai. Coba lagi sebentar lagi."

function readEnv(name: string, fallback: string) {
  const value = process.env[name]
  return value && value.trim() ? value.trim() : fallback
}

export function getSwiftTierConfigs(): SwiftTierConfig[] {
  const swift1Primary = readEnv("OPENROUTER_SWIFT1_MODEL", "deepseek/deepseek-v4-flash")
  const swift1Fallback = readEnv("OPENROUTER_SWIFT1_FALLBACK_MODEL", "google/gemini-2.5-flash")
  const swift2Primary = readEnv("OPENROUTER_SWIFT2_MODEL", "openai/gpt-4.1-mini")
  const swift2Fallback = readEnv("OPENROUTER_SWIFT2_FALLBACK_MODEL", "deepseek/deepseek-v4-flash")
  const swift3Primary = readEnv("OPENROUTER_SWIFT3_MODEL", "anthropic/claude-sonnet-4.6")
  const swift3Fallback = readEnv("OPENROUTER_SWIFT3_FALLBACK_MODEL", "google/gemini-2.5-pro-preview")

  return [
    {
      key: SWIFT_1_MODEL_KEY,
      label: "Swift 1 — Fast",
      shortLabel: "Swift 1",
      description: "Cepat dan hemat untuk UI/component/simple coding.",
      note: "Cepat dan hemat untuk UI/component/simple coding.",
      priceIdr: 2000,
      price: 2000,
      timeoutMs: 20_000,
      maxOutputTokens: 4000,
      rank: 1,
      queue: { concurrency: 8, maxQueueDepth: 100 },
      targets: [
        { modelId: swift1Primary, role: "primary" },
        { modelId: swift1Fallback, role: "fallback" },
      ],
    },
    {
      key: SWIFT_2_MODEL_KEY,
      label: "Swift 2 — Builder",
      shortLabel: "Swift 2",
      description: "Seimbang untuk fullstack, CRUD, auth, APIs, dan dashboard.",
      note: "Seimbang untuk fullstack, CRUD, auth, APIs, dan dashboard.",
      priceIdr: 4000,
      price: 4000,
      timeoutMs: 35_000,
      maxOutputTokens: 8000,
      rank: 2,
      queue: { concurrency: 4, maxQueueDepth: 50 },
      targets: [
        { modelId: swift2Primary, role: "primary" },
        { modelId: swift2Fallback, role: "fallback" },
      ],
    },
    {
      key: SWIFT_3_MODEL_KEY,
      label: "Swift 3 — Engineer",
      shortLabel: "Swift 3",
      description: "Terbaik untuk debugging, repair, refactor, dan production hardening.",
      note: "Terbaik untuk debugging, repair, refactor, dan production hardening.",
      priceIdr: 10000,
      price: 10000,
      timeoutMs: 60_000,
      maxOutputTokens: 16000,
      rank: 3,
      queue: { concurrency: 2, maxQueueDepth: 20 },
      targets: [
        { modelId: swift3Primary, role: "primary" },
        { modelId: swift3Fallback, role: "fallback" },
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
 * Maps an internal model ID (e.g., "anthropic/claude-sonnet-4.6") to its Swift tier key.
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

export const SWIFT_PROVIDER = "swift"
export const SWIFT_FAST_MODEL_KEY = "swift-fast"
export const SWIFT_BUILDER_MODEL_KEY = "swift-builder"
export const SWIFT_PREMIUM_REPAIR_MODEL_KEY = "swift-premium-repair"
export const SWIFT_2_MODEL_KEY = SWIFT_BUILDER_MODEL_KEY
export const DEFAULT_SWIFT_TIER_KEY = SWIFT_BUILDER_MODEL_KEY
export const LEGACY_SWIFT_2_MODEL_KEY = "swift-2"

export const SWIFT_CANONICAL_MODEL_ID = "deepseek/deepseek-v4-pro"
export const SWIFT_FREE_ROUTER_MODEL_ID = "openrouter/free"
const freeAiMode = process.env.SWIFT_AI_FREE_MODE === "true"
const configuredFreeModel = process.env.OPENROUTER_FREE_MODEL?.trim()
const configuredCanonicalModel = process.env.OPENROUTER_DEEPSEEK_V4_PRO_MODEL?.trim()
export const DEEPSEEK_V4_PRO_MODEL_ID =
  freeAiMode
    ? configuredFreeModel || SWIFT_FREE_ROUTER_MODEL_ID
    : configuredCanonicalModel === SWIFT_CANONICAL_MODEL_ID
      ? configuredCanonicalModel
      : SWIFT_CANONICAL_MODEL_ID
export const DEEPSEEK_V32_MODEL_ID = DEEPSEEK_V4_PRO_MODEL_ID
export const DEEPSEEK_V32_PRO_MODEL_ID = DEEPSEEK_V4_PRO_MODEL_ID

export type SwiftTierKey =
  | typeof SWIFT_FAST_MODEL_KEY
  | typeof SWIFT_BUILDER_MODEL_KEY
  | typeof SWIFT_PREMIUM_REPAIR_MODEL_KEY
  | typeof LEGACY_SWIFT_2_MODEL_KEY

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
  role: "primary"
  timeoutMs?: number
  maxOutputTokens?: number
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
  public: boolean
  generationLayer: "fast" | "builder" | "premium-repair"
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

export const SWIFT_PUBLIC_PRICE_IDR = 3000
const SWIFT_FULLSTACK_TIMEOUT_MS = Math.max(
  180_000,
  Number(process.env.AI_TIMEOUT_MS || process.env.SWIFT_PROVIDER_TIMEOUT_MS || 240_000)
)
const SWIFT_FULLSTACK_OUTPUT_TOKENS = Math.max(
  12_000,
  Number(process.env.AI_MAX_OUTPUT_TOKENS || process.env.OPENROUTER_MAX_TOKENS || 16_000)
)

export function getSwiftTierConfigs(): SwiftTierConfig[] {
  const builderTier: SwiftTierConfig = {
    key: SWIFT_BUILDER_MODEL_KEY,
    label: "Swift AI Orchestrator",
    shortLabel: "Builder",
    description: "Satu-satunya engine produksi Swift untuk full-stack, dashboard, CRUD, Prisma, API route, repair, dan arsitektur project.",
    note: freeAiMode
      ? "Mode evaluasi gratis aktif. Request Swift dirutekan ke OpenRouter Free Models Router."
      : "Semua request Swift dirutekan ke DeepSeek V4 Pro melalui OpenRouter dengan routing internal yang efisien.",
    priceIdr: Number(process.env.SWIFT_BUILDER_PRICE_IDR || SWIFT_PUBLIC_PRICE_IDR),
    price: Number(process.env.SWIFT_BUILDER_PRICE_IDR || SWIFT_PUBLIC_PRICE_IDR),
    timeoutMs: SWIFT_FULLSTACK_TIMEOUT_MS,
    maxOutputTokens: SWIFT_FULLSTACK_OUTPUT_TOKENS,
    rank: 2,
    public: true,
    generationLayer: "builder",
    queue: { concurrency: 3, maxQueueDepth: 36 },
    targets: [
      { modelId: DEEPSEEK_V4_PRO_MODEL_ID, role: "primary", timeoutMs: SWIFT_FULLSTACK_TIMEOUT_MS, maxOutputTokens: SWIFT_FULLSTACK_OUTPUT_TOKENS },
    ],
  }

  return [
    {
      ...builderTier,
      rank: 1,
    },
    {
      ...builderTier,
      key: SWIFT_FAST_MODEL_KEY,
      label: "Swift AI Compatibility",
      shortLabel: "Swift",
      description: "Alias internal lama yang tetap diarahkan ke DeepSeek V4 Pro.",
      note: "Compatibility alias. Tidak ditampilkan ke user.",
      priceIdr: builderTier.priceIdr,
      price: builderTier.price,
      rank: 99,
      public: false,
    },
    {
      ...builderTier,
      key: LEGACY_SWIFT_2_MODEL_KEY,
      label: "Swift AI Compatibility",
      shortLabel: "Swift",
      description: "Legacy alias yang diarahkan ke DeepSeek V4 Pro agar request lama tetap berjalan.",
      note: "Compatibility alias. Tidak ditampilkan ke user.",
      rank: 100,
      public: false,
    },
    {
      ...builderTier,
      key: SWIFT_PREMIUM_REPAIR_MODEL_KEY,
      label: "Swift AI Compatibility",
      shortLabel: "Swift",
      description: "Alias repair lama yang tetap diarahkan ke DeepSeek V4 Pro.",
      note: "Compatibility alias. Tidak ditampilkan ke user.",
      rank: 101,
      public: false,
    },
  ]
}

export function getSwiftTierConfig(key: string | null | undefined) {
  const normalizedKey =
    key === LEGACY_SWIFT_2_MODEL_KEY ||
    key === SWIFT_FAST_MODEL_KEY ||
    key === SWIFT_PREMIUM_REPAIR_MODEL_KEY
      ? SWIFT_BUILDER_MODEL_KEY
      : key
  return getSwiftTierConfigs().find((tier) => tier.key === normalizedKey) || null
}

export function isSwiftTierKey(key: string | null | undefined): key is SwiftTierKey {
  if (!key) return false
  return Boolean(getSwiftTierConfig(key))
}

export function getDefaultSwiftTier() {
  return getSwiftTierConfig(DEFAULT_SWIFT_TIER_KEY) || getSwiftTierConfigs()[0]
}

export function hasOpenRouterGatewayKey() {
  return Boolean(process.env.OPENROUTER_API_KEY?.trim())
}

export function isSwiftFreeAiMode() {
  return freeAiMode
}

export function getSwiftTierOptions() {
  return getSwiftTierConfigs()
    .filter((tier) => tier.public)
    .map((tier) => ({
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

export function getPublicProviderName(): string {
  return SWIFT_PROVIDER
}

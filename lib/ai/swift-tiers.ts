export const SWIFT_PROVIDER = "swift"
export const SWIFT_FAST_MODEL_KEY = "swift-fast"
export const SWIFT_BUILDER_MODEL_KEY = "swift-builder"
export const SWIFT_PREMIUM_REPAIR_MODEL_KEY = "swift-premium-repair"
export const SWIFT_2_MODEL_KEY = SWIFT_BUILDER_MODEL_KEY
export const DEFAULT_SWIFT_TIER_KEY = SWIFT_BUILDER_MODEL_KEY
export const LEGACY_SWIFT_2_MODEL_KEY = "swift-2"

export const DEEPSEEK_V32_MODEL_ID =
  process.env.OPENROUTER_DEEPSEEK_V32_MODEL || process.env.OPENROUTER_DEEPSEEK_V32_PRO_MODEL || "deepseek/deepseek-v3.2"
export const DEEPSEEK_V32_PRO_MODEL_ID = DEEPSEEK_V32_MODEL_ID

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

export function getSwiftTierConfigs(): SwiftTierConfig[] {
  const builderTier: SwiftTierConfig = {
    key: SWIFT_BUILDER_MODEL_KEY,
    label: "Swift Builder",
    shortLabel: "Builder",
    description: "Core engine untuk full-stack SaaS, dashboard, CRUD, Prisma, API route, dan arsitektur project.",
    note: "Rute utama DeepSeek V3.2 untuk generasi full-stack yang butuh struktur stabil.",
    priceIdr: Number(process.env.SWIFT_BUILDER_PRICE_IDR || 22000),
    price: Number(process.env.SWIFT_BUILDER_PRICE_IDR || 22000),
    timeoutMs: 120_000,
    maxOutputTokens: 9000,
    rank: 2,
    public: true,
    generationLayer: "builder",
    queue: { concurrency: 3, maxQueueDepth: 36 },
    targets: [
      { modelId: DEEPSEEK_V32_MODEL_ID, role: "primary", timeoutMs: 95_000, maxOutputTokens: 8500 },
    ],
  }

  return [
    {
      key: SWIFT_FAST_MODEL_KEY,
      label: "Swift Fast",
      shortLabel: "Fast",
      description: "Murah dan cepat untuk UI kecil, landing page, copywriting, komponen, formatting, dan edit ringan.",
      note: "Tidak dipakai untuk repair otonom, dependency debugging, atau refactor besar.",
      priceIdr: Number(process.env.SWIFT_FAST_PRICE_IDR || 4000),
      price: Number(process.env.SWIFT_FAST_PRICE_IDR || 4000),
      timeoutMs: 75_000,
      maxOutputTokens: 4500,
      rank: 1,
      public: true,
      generationLayer: "fast",
      queue: { concurrency: 6, maxQueueDepth: 64 },
      targets: [
        { modelId: DEEPSEEK_V32_MODEL_ID, role: "primary", timeoutMs: 75_000, maxOutputTokens: 4500 },
      ],
    },
    builderTier,
    {
      ...builderTier,
      key: LEGACY_SWIFT_2_MODEL_KEY,
      label: "Swift AI",
      shortLabel: "Swift",
      description: "Legacy alias yang diarahkan ke Swift Builder agar request lama tetap berjalan.",
      note: "Alias kompatibilitas. Request baru otomatis dirutekan ke Swift Fast atau Swift Builder sesuai kompleksitas.",
      priceIdr: builderTier.priceIdr,
      price: builderTier.price,
      rank: 99,
      public: false,
    },
    {
      key: SWIFT_PREMIUM_REPAIR_MODEL_KEY,
      label: "Swift Premium Repair",
      shortLabel: "Premium Repair",
      description: "Repair runtime premium untuk crash berulang, dependency graph rusak, dan build error persisten.",
      note: "Hanya untuk eskalasi repair. Tidak pernah menjadi default generasi.",
      priceIdr: Number(process.env.SWIFT_PREMIUM_REPAIR_PRICE_IDR || 75000),
      price: Number(process.env.SWIFT_PREMIUM_REPAIR_PRICE_IDR || 75000),
      timeoutMs: 150_000,
      maxOutputTokens: 9000,
      rank: 100,
      public: false,
      generationLayer: "premium-repair",
      queue: { concurrency: 1, maxQueueDepth: 12 },
      targets: [
        { modelId: DEEPSEEK_V32_MODEL_ID, role: "primary", timeoutMs: 120_000, maxOutputTokens: 9000 },
      ],
    },
  ]
}

export function getSwiftTierConfig(key: string | null | undefined) {
  const normalizedKey = key === LEGACY_SWIFT_2_MODEL_KEY ? SWIFT_BUILDER_MODEL_KEY : key
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

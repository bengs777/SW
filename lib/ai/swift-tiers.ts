import { getOpenRouterModelChain, normalizeOpenRouterModelId } from "@/lib/ai/openrouter-config"

export const SWIFT_PROVIDER = "swift"
export const SWIFT_FAST_MODEL_KEY = "swift-fast"
export const SWIFT_BUILDER_MODEL_KEY = "swift-builder"
export const SWIFT_PREMIUM_REPAIR_MODEL_KEY = "swift-premium-repair"
export const SWIFT_2_MODEL_KEY = SWIFT_BUILDER_MODEL_KEY
export const DEFAULT_SWIFT_TIER_KEY = SWIFT_BUILDER_MODEL_KEY
export const LEGACY_SWIFT_2_MODEL_KEY = "swift-2"

const freeAiMode = process.env.SWIFT_AI_FREE_MODE === "true"
let warnedDefaultChain = false

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
  role: "primary" | "fallback"
  timeoutMs?: number
  maxOutputTokens?: number
}

export type SwiftModelRoutingTask = "large_generation" | "edit_patch"

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
  900_000,
  Number(
    process.env.SWIFT_PROVIDER_TIMEOUT_MS ||
      process.env.SWIFT_GENERATION_JOB_TIMEOUT_MS ||
      process.env.AI_TIMEOUT_MS ||
      900000
  )
)
const configuredOutputTokens = Number(process.env.AI_MAX_OUTPUT_TOKENS || process.env.OPENROUTER_MAX_TOKENS || 16_000)
const SWIFT_FULLSTACK_OUTPUT_TOKENS = Math.min(
  16_000,
  Math.max(3_000, Number.isFinite(configuredOutputTokens) && configuredOutputTokens > 0 ? configuredOutputTokens : 16_000)
)

function uniqueModelIds(modelIds: string[]) {
  const seen = new Set<string>()
  return modelIds.filter((modelId) => {
    const normalized = modelId.trim()
    if (!normalized || seen.has(normalized)) return false
    seen.add(normalized)
    return true
  })
}

export function getSwiftModelTargets(task: SwiftModelRoutingTask = "large_generation"): SwiftModelTarget[] {
  const chain = uniqueModelIds(getOpenRouterModelChain().map(normalizeOpenRouterModelId))

  if (!process.env.OPENROUTER_MODEL?.trim() && !warnedDefaultChain) {
    warnedDefaultChain = true
    console.warn("[swift-ai] OPENROUTER_MODEL is empty; using default OpenRouter free model.")
  }

  void task
  const orderedModelIds = uniqueModelIds(chain.map(normalizeOpenRouterModelId))

  return orderedModelIds.map((modelId, index) => ({
    modelId,
    role: index === 0 ? "primary" : "fallback",
    timeoutMs: SWIFT_FULLSTACK_TIMEOUT_MS,
    maxOutputTokens: SWIFT_FULLSTACK_OUTPUT_TOKENS,
  }))
}

export function getSwiftTierConfigs(): SwiftTierConfig[] {
  const targets = getSwiftModelTargets("large_generation")
  const builderTier: SwiftTierConfig = {
    key: SWIFT_BUILDER_MODEL_KEY,
    label: "Swift AI Orchestrator",
    shortLabel: "Builder",
    description: "Satu-satunya engine produksi Swift untuk full-stack, dashboard, CRUD, Prisma, API route, repair, dan arsitektur project.",
    note: freeAiMode
      ? "Mode evaluasi gratis aktif. Request Swift dirutekan melalui gateway AI kompatibel OpenAI."
      : "Semua request Swift dirutekan melalui chain model OpenRouter dari konfigurasi environment.",
    priceIdr: Number(process.env.SWIFT_BUILDER_PRICE_IDR || SWIFT_PUBLIC_PRICE_IDR),
    price: Number(process.env.SWIFT_BUILDER_PRICE_IDR || SWIFT_PUBLIC_PRICE_IDR),
    timeoutMs: SWIFT_FULLSTACK_TIMEOUT_MS,
    maxOutputTokens: SWIFT_FULLSTACK_OUTPUT_TOKENS,
    rank: 2,
    public: true,
    generationLayer: "builder",
    queue: { concurrency: 3, maxQueueDepth: 36 },
    targets,
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
      description: "Alias internal lama yang tetap diarahkan ke chain model Swift dari environment.",
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
      description: "Legacy alias yang diarahkan ke chain model Swift agar request lama tetap berjalan.",
      note: "Compatibility alias. Tidak ditampilkan ke user.",
      rank: 100,
      public: false,
    },
    {
      ...builderTier,
      key: SWIFT_PREMIUM_REPAIR_MODEL_KEY,
      label: "Swift AI Compatibility",
      shortLabel: "Swift",
      description: "Alias repair lama yang tetap diarahkan ke chain model Swift dari environment.",
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

export function getActiveSwiftModelChain() {
  return getSwiftModelTargets("large_generation").map((target) => `openrouter:${target.modelId}`)
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

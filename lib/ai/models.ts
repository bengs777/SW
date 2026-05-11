import type { ModelOption } from "@/lib/types"
import {
  DEFAULT_SWIFT_TIER_KEY,
  SWIFT_1_MODEL_KEY,
  SWIFT_2_MODEL_KEY,
  SWIFT_3_MODEL_KEY,
  getDefaultSwiftTier,
  getSwiftTierConfig,
  getSwiftTierOptions,
  isSwiftTierKey,
} from "@/lib/ai/model-tiers"

export const SWIFT_BASIC_MODEL_KEY = SWIFT_1_MODEL_KEY
export const SWIFT_BUILD_MODEL_KEY = SWIFT_2_MODEL_KEY
export const SWIFT_PRO_MODEL_KEY = SWIFT_3_MODEL_KEY
export const SWIFT_AI_MODEL_KEY = SWIFT_2_MODEL_KEY
export const SWIFT_AI_MODEL_NAME = SWIFT_2_MODEL_KEY
export const SWIFT_AI_DISPLAY_NAME = "Swift AI"

export const DEFAULT_MODEL_OPTIONS: ModelOption[] = getSwiftTierOptions() as ModelOption[]
export const DEFAULT_MODEL_KEY = DEFAULT_SWIFT_TIER_KEY
export const OPENROUTER_MODEL_KEYS: string[] = []
export const SWIFT_MODEL_KEYS = DEFAULT_MODEL_OPTIONS.map((model) => model.key)

export function isVisionCapableModel(modelName: string): boolean {
  return modelName === SWIFT_3_MODEL_KEY
}

export const isFreeModel = () => false
export const getModelPrice = (modelKey: string = DEFAULT_MODEL_KEY) =>
  getSwiftTierConfig(modelKey)?.price ?? getDefaultSwiftTier().price

export function isSupportedSwiftModelKey(modelKey: string) {
  return isSwiftTierKey(modelKey)
}

export function getModelDisplayMeta(modelKey: string = DEFAULT_MODEL_KEY) {
  const tier = getSwiftTierConfig(modelKey) || getDefaultSwiftTier()
  return {
    label: tier.label,
    description: tier.description,
    note: tier.note,
    rank: tier.rank,
  }
}

export const formatModelLabel = (modelKey: string = DEFAULT_MODEL_KEY) =>
  getModelDisplayMeta(modelKey).label

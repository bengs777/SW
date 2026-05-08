import type { ModelOption } from "@/lib/types"
import {
  BASIC_PROMPT_FEE_IDR,
  BUILD_PROMPT_FEE_IDR,
  OPENROUTER_MODEL_ID,
  OPENROUTER_PROVIDER,
  PRO_PROMPT_FEE_IDR,
  PUBLIC_AI_NAME,
} from "@/lib/ai/openrouter-config"

export const SWIFT_BASIC_MODEL_KEY = "swift-basic"
export const SWIFT_BUILD_MODEL_KEY = "swift-build"
export const SWIFT_PRO_MODEL_KEY = "swift-pro"
export const SWIFT_AI_MODEL_KEY = SWIFT_BUILD_MODEL_KEY
export const SWIFT_AI_MODEL_NAME = OPENROUTER_MODEL_ID
export const SWIFT_AI_DISPLAY_NAME = PUBLIC_AI_NAME

export const DEFAULT_MODEL_OPTIONS: ModelOption[] = [
  {
    key: SWIFT_BASIC_MODEL_KEY,
    label: "Swift Basic",
    provider: OPENROUTER_PROVIDER,
    modelName: OPENROUTER_MODEL_ID,
    price: BASIC_PROMPT_FEE_IDR,
    isActive: true,
    rank: 1,
    description: "Untuk chat, UI ringan, landing page, dan patch kecil.",
    note: "Rp 2.000/request. Pakai untuk tugas cepat dan murah.",
  },
  {
    key: SWIFT_BUILD_MODEL_KEY,
    label: "Swift Build",
    provider: OPENROUTER_PROVIDER,
    modelName: OPENROUTER_MODEL_ID,
    price: BUILD_PROMPT_FEE_IDR,
    isActive: true,
    rank: 2,
    description: "Untuk generate full-stack standar dengan validator dan auto-repair.",
    note: "Rp 5.000/request. Disarankan untuk CRUD, auth, API, dan Prisma.",
  },
  {
    key: SWIFT_PRO_MODEL_KEY,
    label: "Swift Pro Repair",
    provider: OPENROUTER_PROVIDER,
    modelName: OPENROUTER_MODEL_ID,
    price: PRO_PROMPT_FEE_IDR,
    isActive: true,
    rank: 3,
    description: "Untuk debug berat, konteks besar, dan recovery saat build gagal.",
    note: "Rp 15.000/request. Premium tier siap diarahkan ke GPT/Claude nanti.",
  },
]

export const DEFAULT_MODEL_KEY = SWIFT_BUILD_MODEL_KEY
export const OPENROUTER_MODEL_KEYS = DEFAULT_MODEL_OPTIONS.map((model) => model.key)
export const SWIFT_MODEL_KEYS = OPENROUTER_MODEL_KEYS

export function isVisionCapableModel(modelName: string): boolean {
  return modelName === SWIFT_PRO_MODEL_KEY
}

export const isFreeModel = () => false
export const getModelPrice = (modelKey: string = DEFAULT_MODEL_KEY) =>
  DEFAULT_MODEL_OPTIONS.find((model) => model.key === modelKey)?.price || BUILD_PROMPT_FEE_IDR

export function isSupportedSwiftModelKey(modelKey: string) {
  return SWIFT_MODEL_KEYS.includes(modelKey)
}

export function getModelDisplayMeta(modelKey: string = DEFAULT_MODEL_KEY) {
  const model = DEFAULT_MODEL_OPTIONS.find((option) => option.key === modelKey) || DEFAULT_MODEL_OPTIONS[1]
  return {
    label: model.label,
    description: model.description,
    note: model.note,
    rank: model.rank,
  }
}

export const formatModelLabel = (modelKey: string = DEFAULT_MODEL_KEY) =>
  getModelDisplayMeta(modelKey).label || PUBLIC_AI_NAME

import type { ModelOption } from "@/lib/types"
import { AGENTROUTER_PROVIDER } from "@/lib/ai/agentrouter-config"
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
export const AGENTROUTER_CLAUDE_HAIKU_KEY = "agentrouter-claude-haiku-4-5"
export const AGENTROUTER_CLAUDE_OPUS_KEY = "agentrouter-claude-opus-4-6"
export const AGENTROUTER_DEEPSEEK_R1_KEY = "agentrouter-deepseek-r1-0528"
export const AGENTROUTER_DEEPSEEK_V31_KEY = "agentrouter-deepseek-v3-1"
export const AGENTROUTER_DEEPSEEK_V32_KEY = "agentrouter-deepseek-v3-2"
export const AGENTROUTER_GLM_45_KEY = "agentrouter-glm-4-5"
export const AGENTROUTER_GLM_46_KEY = "agentrouter-glm-4-6"
export const AGENTROUTER_GLM_51_KEY = "agentrouter-glm-5-1"
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
  {
    key: AGENTROUTER_DEEPSEEK_V31_KEY,
    label: "DeepSeek V3.1",
    provider: AGENTROUTER_PROVIDER,
    modelName: "deepseek-v3.1",
    price: 7000,
    isActive: true,
    rank: 10,
    description: "AgentRouter hemat untuk generate app dan patch full-stack standar.",
    note: "Harga mengikuti estimasi token. Minimum Rp 7.000/request.",
  },
  {
    key: AGENTROUTER_DEEPSEEK_V32_KEY,
    label: "DeepSeek V3.2",
    provider: AGENTROUTER_PROVIDER,
    modelName: "deepseek-v3.2",
    price: 8000,
    isActive: true,
    rank: 11,
    description: "AgentRouter seimbang untuk build, edit, dan perbaikan konteks menengah.",
    note: "Harga mengikuti estimasi token. Minimum Rp 8.000/request.",
  },
  {
    key: AGENTROUTER_DEEPSEEK_R1_KEY,
    label: "DeepSeek R1 0528",
    provider: AGENTROUTER_PROVIDER,
    modelName: "deepseek-r1-0528",
    price: 12000,
    isActive: true,
    rank: 12,
    description: "AgentRouter reasoning untuk debugging dan instruksi yang butuh analisis.",
    note: "Lebih boros token. Minimum Rp 12.000/request.",
  },
  {
    key: AGENTROUTER_GLM_45_KEY,
    label: "GLM 4.5",
    provider: AGENTROUTER_PROVIDER,
    modelName: "glm-4.5",
    price: 7000,
    isActive: true,
    rank: 13,
    description: "AgentRouter hemat untuk UI, CRUD ringan, dan iterasi cepat.",
    note: "Harga mengikuti estimasi token. Minimum Rp 7.000/request.",
  },
  {
    key: AGENTROUTER_GLM_46_KEY,
    label: "GLM 4.6",
    provider: AGENTROUTER_PROVIDER,
    modelName: "glm-4.6",
    price: 9000,
    isActive: true,
    rank: 14,
    description: "AgentRouter middle tier untuk build lebih panjang dan repair.",
    note: "Harga mengikuti estimasi token. Minimum Rp 9.000/request.",
  },
  {
    key: AGENTROUTER_GLM_51_KEY,
    label: "GLM 5.1",
    provider: AGENTROUTER_PROVIDER,
    modelName: "glm-5.1",
    price: 12000,
    isActive: true,
    rank: 15,
    description: "AgentRouter kuat untuk konteks besar dan aplikasi lebih kompleks.",
    note: "Lebih boros token. Minimum Rp 12.000/request.",
  },
  {
    key: AGENTROUTER_CLAUDE_HAIKU_KEY,
    label: "Claude Haiku 4.5",
    provider: AGENTROUTER_PROVIDER,
    modelName: "claude-haiku-4-5-20251001",
    price: 6000,
    isActive: true,
    rank: 16,
    description: "AgentRouter cepat untuk patch, review, dan generate ringan.",
    note: "Harga mengikuti estimasi token. Minimum Rp 6.000/request.",
  },
  {
    key: AGENTROUTER_CLAUDE_OPUS_KEY,
    label: "Claude Opus 4.6",
    provider: AGENTROUTER_PROVIDER,
    modelName: "claude-opus-4-6",
    price: 30000,
    isActive: true,
    rank: 17,
    description: "AgentRouter premium untuk proyek besar, debugging berat, dan konteks panjang.",
    note: "Paling boros token. Minimum Rp 30.000/request.",
  },
]

export const DEFAULT_MODEL_KEY = SWIFT_BUILD_MODEL_KEY
export const OPENROUTER_MODEL_KEYS = DEFAULT_MODEL_OPTIONS
  .filter((model) => model.provider === OPENROUTER_PROVIDER)
  .map((model) => model.key)
export const AGENTROUTER_MODEL_KEYS = DEFAULT_MODEL_OPTIONS
  .filter((model) => model.provider === AGENTROUTER_PROVIDER)
  .map((model) => model.key)
export const SWIFT_MODEL_KEYS = DEFAULT_MODEL_OPTIONS.map((model) => model.key)

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

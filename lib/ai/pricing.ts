import { DEFAULT_MODEL_KEY, SWIFT_BUILD_MODEL_KEY } from "@/lib/ai/models"

type TokenPricing = {
  inputPer1k: number
  outputPer1k: number
  minimumCharge: number
}

type PricingResult = {
  estimatedInputTokens: number
  estimatedOutputTokens: number
  estimatedTokens: number
  estimatedCost: number
  minimumCharge: number
  pricingMode: "fixed" | "token-estimate"
}

const FIXED_MODEL_PRICES: Record<string, number> = {
  [SWIFT_BUILD_MODEL_KEY]: 4000,
}

const TOKEN_PRICING_BY_MODEL: Record<string, TokenPricing> = {
  "deepseek/deepseek-v4-flash": { inputPer1k: 350, outputPer1k: 1200, minimumCharge: 4000 },
  "deepseek/deepseek-v4-flash:nitro": { inputPer1k: 350, outputPer1k: 1200, minimumCharge: 4000 },
}

export function estimateRequestTokens(prompt: string) {
  return Math.max(64, Math.ceil(prompt.length / 4) + 120)
}

function estimateOutputTokens(inputTokens: number) {
  return Math.min(8000, Math.max(1200, Math.round(inputTokens * 0.35)))
}

function roundUpToNearest(value: number, unit: number) {
  return Math.ceil(value / unit) * unit
}

export function calculateModelRequestPrice({
  modelKey = DEFAULT_MODEL_KEY,
  modelName,
  prompt,
  outputTokens,
}: {
  modelKey?: string
  modelName?: string | null
  prompt: string
  outputTokens?: number
}): PricingResult {
  const estimatedInputTokens = estimateRequestTokens(prompt)
  const estimatedOutputTokens = outputTokens ?? estimateOutputTokens(estimatedInputTokens)
  const estimatedTokens = estimatedInputTokens + estimatedOutputTokens
  const fixedPrice = FIXED_MODEL_PRICES[modelKey]

  if (fixedPrice) {
    return {
      estimatedInputTokens,
      estimatedOutputTokens,
      estimatedTokens,
      estimatedCost: fixedPrice,
      minimumCharge: fixedPrice,
      pricingMode: "fixed",
    }
  }

  const pricing = modelName ? TOKEN_PRICING_BY_MODEL[modelName] : null
  if (!pricing) {
    return {
      estimatedInputTokens,
      estimatedOutputTokens,
      estimatedTokens,
      estimatedCost: FIXED_MODEL_PRICES[DEFAULT_MODEL_KEY] || 4000,
      minimumCharge: FIXED_MODEL_PRICES[DEFAULT_MODEL_KEY] || 4000,
      pricingMode: "fixed",
    }
  }

  const rawCost =
    (estimatedInputTokens / 1000) * pricing.inputPer1k +
    (estimatedOutputTokens / 1000) * pricing.outputPer1k
  const estimatedCost = Math.max(pricing.minimumCharge, roundUpToNearest(rawCost, 500))

  return {
    estimatedInputTokens,
    estimatedOutputTokens,
    estimatedTokens,
    estimatedCost,
    minimumCharge: pricing.minimumCharge,
    pricingMode: "token-estimate",
  }
}

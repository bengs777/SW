import { DEFAULT_MODEL_KEY, SWIFT_BUILD_MODEL_KEY } from "@/lib/ai/models"
import {
  DEEPSEEK_V32_MODEL_ID,
  SWIFT_FAST_MODEL_KEY,
  SWIFT_PUBLIC_PRICE_IDR,
  SWIFT_PREMIUM_REPAIR_MODEL_KEY,
} from "@/lib/ai/model-tiers"

type TokenPricing = {
  inputUsdPer1m: number
  outputUsdPer1m: number
  minimumCharge: number
}

type PricingResult = {
  estimatedInputTokens: number
  estimatedOutputTokens: number
  estimatedTokens: number
  estimatedRawCost: number
  profitMultiplier: number
  estimatedCost: number
  minimumCharge: number
  pricingMode: "fixed" | "token-estimate"
}

const USD_TO_IDR = Number(process.env.SWIFT_USD_TO_IDR || 16000)
const MIN_PROFIT_MULTIPLIER = 4
const DEFAULT_PROFIT_MULTIPLIER = 5

const FIXED_MODEL_PRICES: Record<string, number> = {
  [SWIFT_FAST_MODEL_KEY]: Number(process.env.SWIFT_FAST_PRICE_IDR || SWIFT_PUBLIC_PRICE_IDR),
  [SWIFT_BUILD_MODEL_KEY]: Number(process.env.SWIFT_BUILDER_PRICE_IDR || SWIFT_PUBLIC_PRICE_IDR),
  [SWIFT_PREMIUM_REPAIR_MODEL_KEY]: Number(process.env.SWIFT_PREMIUM_REPAIR_PRICE_IDR || SWIFT_PUBLIC_PRICE_IDR),
}

const TOKEN_PRICING_BY_MODEL: Record<string, TokenPricing> = {
  [DEEPSEEK_V32_MODEL_ID]: { inputUsdPer1m: 0.252, outputUsdPer1m: 0.378, minimumCharge: SWIFT_PUBLIC_PRICE_IDR },
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
  const rawCost = calculateDeepSeekRawCostIdr(estimatedInputTokens, estimatedOutputTokens)
  const fixedPrice = FIXED_MODEL_PRICES[modelKey]

  if (fixedPrice) {
    return {
      estimatedInputTokens,
      estimatedOutputTokens,
      estimatedTokens,
      estimatedRawCost: rawCost,
      profitMultiplier: calculateMultiplier(fixedPrice, rawCost),
      estimatedCost: fixedPrice,
      minimumCharge: fixedPrice,
      pricingMode: "fixed",
    }
  }

  const pricing = modelName ? TOKEN_PRICING_BY_MODEL[modelName] : null
  if (!pricing) {
    const estimatedCost = Math.max(FIXED_MODEL_PRICES[DEFAULT_MODEL_KEY] || SWIFT_PUBLIC_PRICE_IDR, enforceProfitFloor(rawCost))
    return {
      estimatedInputTokens,
      estimatedOutputTokens,
      estimatedTokens,
      estimatedRawCost: rawCost,
      profitMultiplier: calculateMultiplier(estimatedCost, rawCost),
      estimatedCost,
      minimumCharge: FIXED_MODEL_PRICES[DEFAULT_MODEL_KEY] || SWIFT_PUBLIC_PRICE_IDR,
      pricingMode: "fixed",
    }
  }

  const tokenRawCost =
    ((estimatedInputTokens / 1_000_000) * pricing.inputUsdPer1m +
      (estimatedOutputTokens / 1_000_000) * pricing.outputUsdPer1m) *
    USD_TO_IDR
  const estimatedCost = Math.max(pricing.minimumCharge, enforceProfitFloor(tokenRawCost))

  return {
    estimatedInputTokens,
    estimatedOutputTokens,
    estimatedTokens,
    estimatedRawCost: roundUpToNearest(tokenRawCost, 1),
    profitMultiplier: calculateMultiplier(estimatedCost, tokenRawCost),
    estimatedCost,
    minimumCharge: pricing.minimumCharge,
    pricingMode: "token-estimate",
  }
}

function calculateDeepSeekRawCostIdr(inputTokens: number, outputTokens: number) {
  const pricing = TOKEN_PRICING_BY_MODEL[DEEPSEEK_V32_MODEL_ID]
  return roundUpToNearest(
    ((inputTokens / 1_000_000) * pricing.inputUsdPer1m +
      (outputTokens / 1_000_000) * pricing.outputUsdPer1m) *
      USD_TO_IDR,
    1
  )
}

function enforceProfitFloor(rawCostIdr: number) {
  return roundUpToNearest(Math.max(1, rawCostIdr) * DEFAULT_PROFIT_MULTIPLIER, 500)
}

function calculateMultiplier(priceIdr: number, rawCostIdr: number) {
  if (rawCostIdr <= 0) return DEFAULT_PROFIT_MULTIPLIER
  return Math.max(MIN_PROFIT_MULTIPLIER, Number((priceIdr / rawCostIdr).toFixed(2)))
}

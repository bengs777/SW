import type { PromptLanguage } from "@/lib/ai/prompt-templates"
import type { PromptAttachment } from "@/lib/types"
import {
  DEFAULT_SWIFT_TIER_KEY,
  USER_FRIENDLY_AI_ENGINE_ERROR,
  getSwiftTierConfig,
  hasOpenRouterGatewayKey,
  type ProviderFailureReason,
  type SwiftModelTarget,
  type SwiftTierConfig,
  type SwiftTierKey,
} from "@/lib/ai/swift-tiers"
import { createOpenRouterChatCompletion } from "@/lib/ai/openrouter-client"
import { SwiftAiError, redactAiSecret } from "@/lib/ai/errors"
import { getHealthSnapshot, isModelTemporarilyUnavailable, markModelFailure, markModelSuccess } from "@/lib/ai/provider-health"
import { MAX_PROVIDER_ATTEMPTS_PER_REQUEST, retryDelayMs, shouldRetryModel, sleep } from "@/lib/ai/retries"
import { log } from "@/lib/logging"

export type ProviderName = string

type ProviderRegistryEntry = {
  id: ProviderName
  label: string
  enabled: boolean
}

export const PROVIDER_REGISTRY: Record<string, ProviderRegistryEntry> = {
  swift: {
    id: "swift",
    label: "Swift AI",
    enabled: true,
  },
  openrouter: {
    id: "openrouter",
    label: "OpenRouter gateway",
    enabled: false,
  },
}

function validateProvider(provider: ProviderName | undefined): ProviderName {
  const providerId = provider || "swift"
  const registered = PROVIDER_REGISTRY[providerId]

  if (!registered || !registered.enabled) {
    throw new Error(`Unsupported AI provider: ${providerId}`)
  }

  return registered.id
}

type ProviderRequest = {
  provider?: ProviderName
  modelName: string
  prompt: string
  mode?: "chat" | "files" | "inspect"
  promptLanguage?: PromptLanguage
  temperatureOverride?: number
  attachments?: PromptAttachment[]
  signal?: AbortSignal
}

export type ProviderAttemptLog = {
  provider: ProviderName
  modelName: string
  status: "success" | "failed" | "skipped"
  failureReason?: ProviderFailureReason
  statusCode?: number
  latencyMs: number
  requestId?: string | null
  errorMessage?: string
}

export type ProviderResponse = {
  message: string
  providerUsed: ProviderName
  modelUsed: SwiftTierKey
  selectedTier: SwiftTierKey
  usedFallback: boolean
  primaryError?: string
  attempts: ProviderAttemptLog[]
  tokenUsage?: {
    promptTokens?: number
    completionTokens?: number
    totalTokens?: number
  }
}

export class SwiftProviderFailureError extends Error {
  attempts: ProviderAttemptLog[]
  selectedTier: SwiftTierKey
  userMessage: string

  constructor(selectedTier: SwiftTierKey, attempts: ProviderAttemptLog[]) {
    super("SWIFT_AI_PROVIDER_FAILOVER_EXHAUSTED")
    this.name = "SwiftProviderFailureError"
    this.selectedTier = selectedTier
    this.attempts = attempts
    this.userMessage = USER_FRIENDLY_AI_ENGINE_ERROR
  }
}

const FILE_OUTPUT_SYSTEM_PROMPT = [
  "You are Swift AI, a Senior Fullstack Next.js Developer with deep context awareness.",
  "Return ONLY a valid JSON object. No markdown, no code fences, no preamble, no chat.",
  'JSON schema: {"message":"short summary","files":[{"path":"app/page.tsx","language":"tsx","content":"full file content"}]}',
  "Patch existing files first when the user asks for edits, but rebuild when the user asks for a new app direction.",
  "Use only existing stack: Next.js App Router, React, TypeScript, Tailwind CSS, lucide-react, zod, Prisma, next-auth, shadcn/ui.",
  "Always include responsive design, loading states, empty states, usable mobile layout, and full file contents.",
].join(" ")

const INSPECT_SYSTEM_PROMPTS: Record<PromptLanguage, string> = {
  id: [
    "Kamu adalah Swift AI, senior fullstack debugger untuk browser preview.",
    "Gunakan preview context, error browser, dan prompt user sebagai evidence.",
    "Jawab dalam bahasa Indonesia.",
    "Fokus pada root cause paling mungkin, evidence, patch minimal, dan langkah verifikasi.",
  ].join(" "),
  en: [
    "You are Swift AI, a senior fullstack debugger for browser preview.",
    "Use the preview context, browser error, and user prompt as evidence.",
    "Reply in English.",
    "Focus on likely root cause, evidence, the smallest patch, and verification steps.",
  ].join(" "),
}

const CHAT_SYSTEM_PROMPTS: Record<PromptLanguage, string> = {
  id: [
    "Kamu adalah Swift AI, AI percakapan yang membantu di dalam web app builder.",
    "Balas natural dalam bahasa Indonesia.",
    "Jangan keluarkan JSON, daftar file, atau kode kecuali user meminta implementasi.",
  ].join(" "),
  en: [
    "You are Swift AI, a conversational AI inside a web app builder.",
    "Reply naturally in English.",
    "Do not output JSON, file lists, or code unless the user asks for implementation.",
  ].join(" "),
}

export class ProviderRouter {
  static async generate({
    modelName,
    prompt,
    mode = "files",
    promptLanguage = "id",
    temperatureOverride,
    signal,
    provider,
  }: ProviderRequest): Promise<ProviderResponse> {
    validateProvider(provider)
    const tier = this.resolveTier(modelName, mode)
    const attempts: ProviderAttemptLog[] = []

    if (!hasOpenRouterGatewayKey()) {
      attempts.push({
        provider: "openrouter",
        modelName: tier.targets[0]?.modelId || tier.key,
        status: "failed",
        failureReason: "config",
        latencyMs: 0,
        errorMessage: "OPENROUTER_API_KEY is not configured",
      })
      throw new SwiftProviderFailureError(tier.key, attempts)
    }

    let totalAttempts = 0
    let firstError: string | undefined

    for (const target of tier.targets) {
      if (isModelTemporarilyUnavailable(target.modelId)) {
        attempts.push({
          provider: "openrouter",
          modelName: target.modelId,
          status: "skipped",
          failureReason: "server_error",
          latencyMs: 0,
          errorMessage: "Model is cooling down after repeated failures",
        })
        continue
      }

      let retryCount = 0
      while (true) {
        if (totalAttempts >= Math.min(MAX_PROVIDER_ATTEMPTS_PER_REQUEST, tier.targets.length * 2)) {
          throw new SwiftProviderFailureError(tier.key, attempts)
        }

        totalAttempts += 1
        const startedAt = Date.now()

        try {
          const result = await this.callOpenRouterTarget(target, {
            prompt,
            mode,
            promptLanguage,
            tier,
            temperatureOverride,
            signal,
          })
          const latencyMs = Date.now() - startedAt
          attempts.push({
            provider: "swift",
            modelName: tier.key,
            status: "success",
            latencyMs,
            requestId: result.requestId,
          })
          markModelSuccess(target.modelId, latencyMs)

          return {
            message: result.message,
            providerUsed: "swift",
            modelUsed: tier.key,
            selectedTier: tier.key,
            usedFallback: target.role === "fallback" || attempts.some((item) => item.status === "failed" || item.status === "skipped"),
            primaryError: firstError,
            attempts,
            tokenUsage: result.tokenUsage,
          }
        } catch (error) {
          const normalized = this.normalizeError(error, target)
          const latencyMs = Date.now() - startedAt
          firstError = firstError || normalized.message
          attempts.push({
            provider: "swift",
            modelName: tier.key,
            status: "failed",
            failureReason: normalized.reason,
            statusCode: normalized.statusCode,
            latencyMs,
            requestId: normalized.requestId,
            errorMessage: redactAiSecret(normalized.message),
          })
          markModelFailure(target.modelId, {
            reason: normalized.reason,
            latencyMs,
            statusCode: normalized.statusCode,
            message: redactAiSecret(normalized.message),
          })

          if (!shouldRetryModel(normalized.reason, retryCount)) {
            break
          }

          retryCount += 1
          await sleep(retryDelayMs(retryCount))
        }
      }
    }

    log("warn", "Swift AI OpenRouter failover exhausted", {
      selectedTier: tier.key,
      attempts: attempts.map((attempt) => ({
        provider: attempt.provider,
        internalModel: attempt.modelName,
        status: attempt.status,
        failureReason: attempt.failureReason,
        statusCode: attempt.statusCode,
        latencyMs: attempt.latencyMs,
      })),
    })

    throw new SwiftProviderFailureError(tier.key, attempts)
  }

  static async getConfiguredProviderHealth() {
    return getHealthSnapshot()
  }

  static async checkProviderHealth(modelId?: string) {
    const targetModelId = modelId || getSwiftTierConfig(DEFAULT_SWIFT_TIER_KEY)?.targets[0]?.modelId
    if (!targetModelId) {
      return {
        provider: "swift",
        status: "offline",
        failureReason: "config",
        latencyMs: 0,
        cached: false,
        message: "No Swift tier model is configured.",
      }
    }

    const startedAt = Date.now()
    try {
      await createOpenRouterChatCompletion({
        model: targetModelId,
        messages: [
          { role: "system", content: "You are a health probe. Reply with OK only." },
          { role: "user", content: "OK" },
        ],
        maxTokens: 64,
        timeoutMs: 8_000,
        temperature: 0,
      })
      const latencyMs = Date.now() - startedAt
      markModelSuccess(targetModelId, latencyMs)
      return {
        provider: "swift",
        modelId: targetModelId,
        status: "healthy",
        latencyMs,
        cached: false,
        checkedAt: new Date().toISOString(),
      }
      } catch (error) {
        const normalized = this.normalizeError(error, { modelId: targetModelId, role: "primary" })
        const latencyMs = Date.now() - startedAt
        markModelFailure(targetModelId, {
          reason: normalized.reason,
          latencyMs,
          statusCode: normalized.statusCode,
          message: redactAiSecret(normalized.message),
        })
        return {
          provider: "swift",
          modelId: targetModelId,
        status: normalized.reason === "auth" || normalized.reason === "config" ? "offline" : "degraded",
        failureReason: normalized.reason,
        statusCode: normalized.statusCode,
        latencyMs,
        cached: false,
        checkedAt: new Date().toISOString(),
        message: redactAiSecret(normalized.message),
      }
    }
  }

  private static resolveTier(modelName: string, mode: "chat" | "files" | "inspect"): SwiftTierConfig {
    void mode
    return getSwiftTierConfig(modelName) || getSwiftTierConfig(DEFAULT_SWIFT_TIER_KEY)!
  }

  private static async callOpenRouterTarget(
    target: SwiftModelTarget,
    input: {
      prompt: string
      mode: "chat" | "files" | "inspect"
      promptLanguage: PromptLanguage
      tier: SwiftTierConfig
      temperatureOverride?: number
      signal?: AbortSignal
    }
  ) {
    return createOpenRouterChatCompletion({
      model: target.modelId,
      messages: this.buildMessages(input.prompt, input.mode, input.promptLanguage),
      temperature: this.getTemperature(input.mode, input.temperatureOverride),
      maxTokens: target.maxOutputTokens || input.tier.maxOutputTokens,
      responseFormat: input.mode === "files" ? "json_object" : undefined,
      timeoutMs: target.timeoutMs || input.tier.timeoutMs,
      signal: input.signal,
    })
  }

  private static buildMessages(prompt: string, mode: "chat" | "files" | "inspect", promptLanguage: PromptLanguage) {
    return [
      { role: "system" as const, content: this.getSystemPrompt(mode, promptLanguage) },
      { role: "user" as const, content: prompt },
    ]
  }

  private static getSystemPrompt(mode: "chat" | "files" | "inspect", promptLanguage: PromptLanguage) {
    if (mode === "files") return FILE_OUTPUT_SYSTEM_PROMPT
    if (mode === "inspect") return INSPECT_SYSTEM_PROMPTS[promptLanguage] || INSPECT_SYSTEM_PROMPTS.id
    return CHAT_SYSTEM_PROMPTS[promptLanguage] || CHAT_SYSTEM_PROMPTS.id
  }

  private static getTemperature(mode: "chat" | "files" | "inspect", override?: number) {
    if (typeof override === "number") return override
    if (mode === "files") return 0.15
    if (mode === "inspect") return 0.2
    return 0.5
  }

  private static normalizeError(error: unknown, target: SwiftModelTarget) {
    if (error instanceof SwiftAiError) {
      return error
    }

    const reason: ProviderFailureReason = error instanceof Error && error.name === "AbortError" ? "cancelled" : "network"

    return new SwiftAiError(error instanceof Error ? error.message : String(error), {
      reason,
      internalModelId: target.modelId,
    })
  }
}

import type { PromptLanguage } from "@/lib/ai/prompt-templates"
import type { PromptAttachment } from "@/lib/types"
import { env } from "@/lib/env"
import {
  DEFAULT_SWIFT_TIER_KEY,
  USER_FRIENDLY_AI_ENGINE_ERROR,
  getSwiftTierConfig,
  hasProviderKey,
  type InternalProviderName,
  type ProviderFailureReason,
  type ProviderHealthStatus,
  type SwiftProviderTarget,
  type SwiftTierConfig,
  type SwiftTierKey,
} from "@/lib/ai/model-tiers"
import { log } from "@/lib/logging"

export type ProviderName = "swift" | InternalProviderName | "openrouter" | "agentrouter"

type ProviderRequest = {
  provider?: ProviderName
  modelName: string
  prompt: string
  mode?: "chat" | "files" | "inspect"
  promptLanguage?: PromptLanguage
  temperatureOverride?: number
  attachments?: PromptAttachment[]
}

export type ProviderAttemptLog = {
  provider: InternalProviderName
  modelName: string
  status: "success" | "failed" | "skipped"
  failureReason?: ProviderFailureReason
  statusCode?: number
  latencyMs: number
  requestId?: string | null
  errorMessage?: string
}

type ProviderResponse = {
  message: string
  providerUsed: InternalProviderName
  modelUsed: string
  selectedTier: SwiftTierKey
  usedFallback: boolean
  primaryError?: string
  attempts: ProviderAttemptLog[]
}

type ProviderMessage = {
  message: string
  requestId?: string | null
}

type HealthCacheValue = {
  provider: InternalProviderName
  status: ProviderHealthStatus
  failureReason?: ProviderFailureReason
  statusCode?: number
  latencyMs: number
  checkedAt: number
  message?: string
}

type ProviderErrorDetails = {
  provider: InternalProviderName
  modelName: string
  statusCode?: number
  failureReason: ProviderFailureReason
  requestId?: string | null
}

class ProviderError extends Error {
  provider: InternalProviderName
  modelName: string
  statusCode?: number
  failureReason: ProviderFailureReason
  requestId?: string | null

  constructor(message: string, details: ProviderErrorDetails) {
    super(message)
    this.name = "ProviderError"
    this.provider = details.provider
    this.modelName = details.modelName
    this.statusCode = details.statusCode
    this.failureReason = details.failureReason
    this.requestId = details.requestId
  }
}

class ProviderTimeoutError extends ProviderError {
  constructor(timeoutMs: number, details: Omit<ProviderErrorDetails, "failureReason">) {
    super(`Provider request timed out after ${Math.round(timeoutMs / 1000)} seconds`, {
      ...details,
      failureReason: "timeout",
    })
    this.name = "ProviderTimeoutError"
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

const healthCache = new Map<InternalProviderName, HealthCacheValue>()
const MAX_PROVIDER_ATTEMPTS_PER_REQUEST = 4
const HEALTH_CACHE_TTL_MS = 60_000

export class ProviderRouter {
  static async generate({
    modelName,
    prompt,
    mode = "files",
    promptLanguage = "id",
    temperatureOverride,
  }: ProviderRequest): Promise<ProviderResponse> {
    const tier = this.resolveTier(modelName, mode)
    const attempts: ProviderAttemptLog[] = []
    const availableTargets = this.getAvailableTargets(tier)

    if (availableTargets.length === 0) {
      throw new SwiftProviderFailureError(tier.key, attempts)
    }

    let totalAttempts = 0
    let firstError: string | undefined

    for (const target of availableTargets) {
      const cachedHealth = this.getCachedHealth(target.provider)
      if (cachedHealth?.status === "offline") {
        attempts.push({
          provider: target.provider,
          modelName: target.modelName,
          status: "skipped",
          failureReason: cachedHealth.failureReason || "unknown",
          statusCode: cachedHealth.statusCode,
          latencyMs: 0,
          errorMessage: cachedHealth.message,
        })
        continue
      }

      const maxAttemptsForTarget = 1
      for (let attempt = 0; attempt <= maxAttemptsForTarget; attempt += 1) {
        if (totalAttempts >= MAX_PROVIDER_ATTEMPTS_PER_REQUEST) {
          throw new SwiftProviderFailureError(tier.key, attempts)
        }

        totalAttempts += 1
        const startedAt = Date.now()

        try {
          const result = await this.callTarget(target, {
            prompt,
            mode,
            promptLanguage,
            tier,
            temperatureOverride,
          })
          const latencyMs = Date.now() - startedAt
          attempts.push({
            provider: target.provider,
            modelName: target.modelName,
            status: "success",
            latencyMs,
            requestId: result.requestId,
          })
          this.setCachedHealth(target.provider, {
            provider: target.provider,
            status: "healthy",
            latencyMs,
            checkedAt: Date.now(),
          })

          return {
            message: result.message,
            providerUsed: target.provider,
            modelUsed: target.modelName,
            selectedTier: tier.key,
            usedFallback: attempts.some((item) => item.status === "failed" || item.status === "skipped"),
            primaryError: firstError,
            attempts,
          }
        } catch (error) {
          const providerError = this.normalizeProviderError(error, target)
          const latencyMs = Date.now() - startedAt
          firstError = firstError || providerError.message
          attempts.push({
            provider: target.provider,
            modelName: target.modelName,
            status: "failed",
            failureReason: providerError.failureReason,
            statusCode: providerError.statusCode,
            latencyMs,
            requestId: providerError.requestId,
            errorMessage: providerError.message,
          })
          this.setCachedHealth(target.provider, {
            provider: target.provider,
            status: this.toHealthStatus(providerError.failureReason),
            failureReason: providerError.failureReason,
            statusCode: providerError.statusCode,
            latencyMs,
            checkedAt: Date.now(),
            message: providerError.message,
          })

          if (!this.isTransient(providerError.failureReason) || attempt === maxAttemptsForTarget) {
            break
          }

          await this.sleep(500)
        }
      }
    }

    log("warn", "Swift AI provider failover exhausted", {
      selectedTier: tier.key,
      attempts: attempts.map((attempt) => ({
        provider: attempt.provider,
        modelName: attempt.modelName,
        status: attempt.status,
        failureReason: attempt.failureReason,
        statusCode: attempt.statusCode,
        latencyMs: attempt.latencyMs,
      })),
    })

    throw new SwiftProviderFailureError(tier.key, attempts)
  }

  static async getConfiguredProviderHealth(options?: { refresh?: boolean }) {
    const providers: InternalProviderName[] = ["gemini", "deepseek", "openrouter", "openai", "agentrouter"]
    const results = []

    for (const provider of providers) {
      if (!hasProviderKey(provider)) {
        continue
      }

      const cached = this.getCachedHealth(provider)
      if (!options?.refresh && cached) {
        results.push(this.formatHealth(provider, cached, true))
        continue
      }

      results.push(await this.checkProviderHealth(provider))
    }

    return results
  }

  static async checkProviderHealth(provider: InternalProviderName) {
    const target = this.getHealthTarget(provider)
    const startedAt = Date.now()

    if (!target || !hasProviderKey(provider)) {
      const status: HealthCacheValue = {
        provider,
        status: "offline",
        failureReason: "config",
        latencyMs: 0,
        checkedAt: Date.now(),
        message: "Provider key is not configured.",
      }
      return this.formatHealth(provider, status, false)
    }

    try {
      const message = await this.callTarget(target, {
        prompt: "Reply with OK only.",
        mode: "chat",
        promptLanguage: "en",
        tier: {
          ...this.resolveTier(DEFAULT_SWIFT_TIER_KEY, "chat"),
          timeoutMs: 8_000,
          maxOutputTokens: 64,
        },
      })
      const latencyMs = Date.now() - startedAt
      const status: HealthCacheValue = {
        provider,
        status: message.message.trim() ? "healthy" : "degraded",
        failureReason: message.message.trim() ? undefined : "empty_response",
        latencyMs,
        checkedAt: Date.now(),
      }
      this.setCachedHealth(provider, status)
      return this.formatHealth(provider, status, false)
    } catch (error) {
      const providerError = this.normalizeProviderError(error, target)
      const status: HealthCacheValue = {
        provider,
        status: this.toHealthStatus(providerError.failureReason),
        failureReason: providerError.failureReason,
        statusCode: providerError.statusCode,
        latencyMs: Date.now() - startedAt,
        checkedAt: Date.now(),
        message: providerError.message,
      }
      this.setCachedHealth(provider, status)
      return this.formatHealth(provider, status, false)
    }
  }

  private static resolveTier(modelName: string, mode: "chat" | "files" | "inspect"): SwiftTierConfig {
    const fallbackKey = mode === "inspect" ? "swift-3" : DEFAULT_SWIFT_TIER_KEY
    return getSwiftTierConfig(modelName) || getSwiftTierConfig(fallbackKey) || getSwiftTierConfig(DEFAULT_SWIFT_TIER_KEY)!
  }

  private static getAvailableTargets(tier: SwiftTierConfig) {
    const seen = new Set<string>()
    return tier.targets.filter((target) => {
      if (!hasProviderKey(target.provider)) return false
      const key = `${target.provider}:${target.modelName}`
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
  }

  private static getHealthTarget(provider: InternalProviderName): SwiftProviderTarget | null {
    for (const tier of ["swift-1", "swift-2", "swift-3"]) {
      const target = getSwiftTierConfig(tier)?.targets.find((item) => item.provider === provider)
      if (target) return target
    }

    return null
  }

  private static async callTarget(
    target: SwiftProviderTarget,
    input: {
      prompt: string
      mode: "chat" | "files" | "inspect"
      promptLanguage: PromptLanguage
      tier: SwiftTierConfig
      temperatureOverride?: number
    }
  ): Promise<ProviderMessage> {
    if (target.provider === "gemini") {
      return this.callGemini(target, input)
    }

    return this.callChatCompletions(target, input)
  }

  private static async callGemini(
    target: SwiftProviderTarget,
    input: {
      prompt: string
      mode: "chat" | "files" | "inspect"
      promptLanguage: PromptLanguage
      tier: SwiftTierConfig
      temperatureOverride?: number
    }
  ): Promise<ProviderMessage> {
    const apiKey = env.geminiApiKey
    if (!apiKey) {
      throw new ProviderError("Provider API key is not configured", {
        provider: target.provider,
        modelName: target.modelName,
        failureReason: "config",
      })
    }

    const systemPrompt = this.getSystemPrompt(input.mode, input.promptLanguage)
    const response = await this.fetchWithTimeout(
      `https://generativelanguage.googleapis.com/v1beta/models/${target.modelName}:generateContent?key=${encodeURIComponent(apiKey)}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [
            {
              role: "user",
              parts: [{ text: `${systemPrompt}\n\n${input.prompt}` }],
            },
          ],
          generationConfig: {
            temperature: this.getTemperature(input.mode, input.temperatureOverride),
            maxOutputTokens: input.tier.maxOutputTokens,
          },
        }),
      },
      input.tier.timeoutMs,
      target
    )

    if (!response.ok) {
      throw await this.errorFromResponse(response, target)
    }

    const data = await response.json()
    const message = data.candidates?.[0]?.content?.parts?.map((part: { text?: string }) => part.text || "").join("") || ""

    if (!message.trim()) {
      throw new ProviderError("Provider returned an empty response", {
        provider: target.provider,
        modelName: target.modelName,
        failureReason: "empty_response",
      })
    }

    return {
      message,
      requestId: response.headers.get("x-request-id"),
    }
  }

  private static async callChatCompletions(
    target: SwiftProviderTarget,
    input: {
      prompt: string
      mode: "chat" | "files" | "inspect"
      promptLanguage: PromptLanguage
      tier: SwiftTierConfig
      temperatureOverride?: number
    }
  ): Promise<ProviderMessage> {
    const config = this.getChatProviderConfig(target.provider)
    if (!config.apiKey) {
      throw new ProviderError("Provider API key is not configured", {
        provider: target.provider,
        modelName: target.modelName,
        failureReason: "config",
      })
    }

    const response = await this.fetchWithTimeout(
      `${config.baseUrl}/chat/completions`,
      {
        method: "POST",
        headers: this.buildProviderHeaders(target.provider, config.apiKey),
        body: JSON.stringify({
          model: target.modelName,
          messages: this.buildMessages(input.prompt, input.mode, input.promptLanguage),
          temperature: this.getTemperature(input.mode, input.temperatureOverride),
          top_p: 0.9,
          max_tokens: input.tier.maxOutputTokens,
          ...(input.mode === "files" ? { response_format: { type: "json_object" } } : {}),
        }),
      },
      input.tier.timeoutMs,
      target
    )

    if (!response.ok) {
      throw await this.errorFromResponse(response, target)
    }

    const data = await response.json()
    const message = data.choices?.[0]?.message?.content || ""
    if (!message.trim()) {
      throw new ProviderError("Provider returned an empty response", {
        provider: target.provider,
        modelName: target.modelName,
        failureReason: "empty_response",
        requestId: response.headers.get("x-request-id"),
      })
    }

    return {
      message,
      requestId: response.headers.get("x-request-id"),
    }
  }

  private static getChatProviderConfig(provider: InternalProviderName) {
    if (provider === "deepseek") {
      return {
        apiKey: env.deepSeekApiKey,
        baseUrl: process.env.DEEPSEEK_API_URL?.replace(/\/+$/, "") || "https://api.deepseek.com/v1",
      }
    }

    if (provider === "openai") {
      return {
        apiKey: env.openAiApiKey,
        baseUrl: env.openAiApiUrl || "https://api.openai.com/v1",
      }
    }

    if (provider === "agentrouter") {
      return {
        apiKey: env.agentRouterApiKey,
        baseUrl: env.agentRouterApiUrl || "https://agentrouter.org/v1",
      }
    }

    return {
      apiKey: env.openRouterApiKey,
      baseUrl: env.openRouterApiUrl || "https://openrouter.ai/api/v1",
    }
  }

  private static buildProviderHeaders(provider: InternalProviderName, apiKey: string) {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    }

    if (provider === "openrouter") {
      headers["HTTP-Referer"] = env.nextAuthUrl || env.appUrl || "http://localhost:3000"
      headers["X-Title"] = "Swift AI Web Builder"
    }

    return headers
  }

  private static buildMessages(prompt: string, mode: "chat" | "files" | "inspect", promptLanguage: PromptLanguage) {
    return [
      { role: "system", content: this.getSystemPrompt(mode, promptLanguage) },
      { role: "user", content: prompt },
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

  private static async fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number, target: SwiftProviderTarget) {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), timeoutMs)

    try {
      return await fetch(url, {
        ...init,
        signal: controller.signal,
      })
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        throw new ProviderTimeoutError(timeoutMs, {
          provider: target.provider,
          modelName: target.modelName,
        })
      }

      throw new ProviderError(error instanceof Error ? error.message : "Network error", {
        provider: target.provider,
        modelName: target.modelName,
        failureReason: "network",
      })
    } finally {
      clearTimeout(timeout)
    }
  }

  private static async errorFromResponse(response: Response, target: SwiftProviderTarget) {
    const text = await response.text().catch(() => "")
    let message = text

    try {
      const parsed = JSON.parse(text)
      message = parsed.error?.message || parsed.message || text
    } catch {
      // keep raw text
    }

    return new ProviderError(`Provider API error (${response.status}): ${message}`.trim(), {
      provider: target.provider,
      modelName: target.modelName,
      statusCode: response.status,
      failureReason: this.reasonFromStatus(response.status),
      requestId: response.headers.get("x-request-id"),
    })
  }

  private static normalizeProviderError(error: unknown, target: SwiftProviderTarget) {
    if (error instanceof ProviderError) {
      return error
    }

    return new ProviderError(error instanceof Error ? error.message : String(error), {
      provider: target.provider,
      modelName: target.modelName,
      failureReason: "unknown",
    })
  }

  private static reasonFromStatus(status: number): ProviderFailureReason {
    if (status === 401 || status === 403) return "auth"
    if (status === 408) return "timeout"
    if (status === 429 || status === 402) return "rate_limit"
    if (status >= 500) return "server_error"
    return "unknown"
  }

  private static isTransient(reason: ProviderFailureReason) {
    return reason === "timeout" || reason === "network" || reason === "server_error" || reason === "rate_limit"
  }

  private static toHealthStatus(reason: ProviderFailureReason): ProviderHealthStatus {
    if (reason === "auth" || reason === "config") return "offline"
    if (reason === "rate_limit" || reason === "timeout" || reason === "empty_response") return "degraded"
    return "offline"
  }

  private static getCachedHealth(provider: InternalProviderName) {
    const cached = healthCache.get(provider)
    if (!cached) return null
    if (Date.now() - cached.checkedAt > HEALTH_CACHE_TTL_MS) return null
    return cached
  }

  private static setCachedHealth(provider: InternalProviderName, value: HealthCacheValue) {
    healthCache.set(provider, value)
  }

  private static formatHealth(provider: InternalProviderName, status: HealthCacheValue, cached: boolean) {
    return {
      provider,
      status: status.status,
      failureReason: status.failureReason,
      statusCode: status.statusCode,
      latencyMs: status.latencyMs,
      checkedAt: new Date(status.checkedAt).toISOString(),
      cached,
      message: status.message ? this.redact(status.message) : undefined,
    }
  }

  private static redact(message: string) {
    return message.replace(/sk-[A-Za-z0-9_-]+/g, "[redacted]").replace(/Bearer\s+[A-Za-z0-9._-]+/gi, "Bearer [redacted]")
  }

  private static sleep(ms: number) {
    return new Promise((resolve) => setTimeout(resolve, ms))
  }
}

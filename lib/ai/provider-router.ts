import { assertAgentRouterReady, AGENTROUTER_PROVIDER } from "@/lib/ai/agentrouter-config"
import { assertOpenRouterReady, OPENROUTER_MODEL_ID, OPENROUTER_PROVIDER } from "@/lib/ai/openrouter-config"
import type { PromptLanguage } from "@/lib/ai/prompt-templates"
import type { PromptAttachment } from "@/lib/types"
import { env } from "@/lib/env"

export type ProviderName = typeof OPENROUTER_PROVIDER | typeof AGENTROUTER_PROVIDER

type ProviderRequest = {
  provider: ProviderName
  modelName: string
  prompt: string
  mode?: "chat" | "files" | "inspect"
  promptLanguage?: PromptLanguage
  temperatureOverride?: number
  attachments?: PromptAttachment[]
}

type ProviderResponse = {
  message: string
  providerUsed: ProviderName
  modelUsed: string
  usedFallback: boolean
  primaryError?: string
}

type ProviderMessage = {
  message: string
}

const DEFAULT_AGENTROUTER_FALLBACK_MODELS = [
  "deepseek-v3.2",
  "deepseek-v3.1",
  "glm-4.6",
  "glm-5.1",
  "claude-haiku-4-5-20251001",
  "deepseek-r1-0528",
  "claude-opus-4-6",
]

class ProviderTimeoutError extends Error {
  constructor(timeoutMs: number, providerLabel = "Provider") {
    super(`${providerLabel} request timed out after ${Math.round(timeoutMs / 1000)} seconds`)
    this.name = "ProviderTimeoutError"
  }
}

const FILE_OUTPUT_SYSTEM_PROMPT = [
  "You are a Senior Fullstack Next.js Developer with deep context awareness.",
  "Your primary job: understand user intent from file explorer interactions, preview errors, and prompts, then return ONLY a valid JSON object with file changes.",
  "Return ONLY a valid JSON object. No markdown, no code fences, no preamble, no chat.",
  'JSON schema: {"message":"short summary","files":[{"path":"app/page.tsx","language":"tsx","content":"full file content"}]}',
  "Patch existing files first when the user asks for edits, but rebuild when the user asks for a new app direction.",
  "Respect AI_CONTEXT_JSON, PREVIEW_CONTEXT_JSON, WORKPLAN_JSON, and the structured brief as context, while the latest user request remains the highest-priority source of truth.",
  "Use only existing stack: Next.js App Router, React, TypeScript, Tailwind CSS, lucide-react, zod, Prisma, next-auth, shadcn/ui.",
  "Always include responsive design, loading states, empty states, usable mobile layout, and full file contents.",
].join(" ")

const INSPECT_SYSTEM_PROMPTS: Record<PromptLanguage, string> = {
  id: [
    "Kamu adalah senior fullstack debugger untuk browser preview.",
    "Gunakan preview context, error browser, dan prompt user sebagai evidence.",
    "Jawab dalam bahasa Indonesia.",
    "Fokus pada root cause paling mungkin, evidence, patch minimal, dan langkah verifikasi.",
  ].join(" "),
  en: [
    "You are a senior fullstack debugger for browser preview.",
    "Use the preview context, browser error, and user prompt as evidence.",
    "Reply in English.",
    "Focus on likely root cause, evidence, the smallest patch, and verification steps.",
  ].join(" "),
}

const CHAT_SYSTEM_PROMPTS: Record<PromptLanguage, string> = {
  id: [
    "Kamu adalah AI percakapan yang membantu di dalam web app builder.",
    "Balas natural dalam bahasa Indonesia.",
    "Jangan keluarkan JSON, daftar file, atau kode kecuali user meminta implementasi.",
  ].join(" "),
  en: [
    "You are a conversational AI inside a web app builder.",
    "Reply naturally in English.",
    "Do not output JSON, file lists, or code unless the user asks for implementation.",
  ].join(" "),
}

export class ProviderRouter {
  static async generate({
    provider,
    modelName,
    prompt,
    mode = "files",
    promptLanguage = "id",
    temperatureOverride,
  }: ProviderRequest): Promise<ProviderResponse> {
    if (provider !== OPENROUTER_PROVIDER && provider !== AGENTROUTER_PROVIDER) {
      throw new Error(`Unsupported AI provider: ${provider}`)
    }

    if (provider === OPENROUTER_PROVIDER && modelName !== OPENROUTER_MODEL_ID) {
      throw new Error(`Unsupported AI model: ${modelName}`)
    }

    try {
      const result =
        provider === AGENTROUTER_PROVIDER
          ? await this.callAgentRouter(modelName, prompt, mode, promptLanguage, temperatureOverride)
          : await this.callOpenRouter(modelName, prompt, mode, promptLanguage, temperatureOverride)

      return {
        message: result.message,
        providerUsed: provider,
        modelUsed: modelName,
        usedFallback: false,
      }
    } catch (primaryError) {
      const primaryErrorMessage = primaryError instanceof Error ? primaryError.message : String(primaryError)
      const fallbackModels = this.getAgentRouterFallbackModels(modelName)

      if (!this.shouldUseAgentRouterFallback(primaryErrorMessage, fallbackModels)) {
        throw primaryError
      }

      let lastFallbackError: Error | null = null

      for (const fallbackModel of fallbackModels) {
        try {
          const result = await this.callAgentRouter(fallbackModel, prompt, mode, promptLanguage, temperatureOverride)
          return {
            message: result.message,
            providerUsed: AGENTROUTER_PROVIDER,
            modelUsed: fallbackModel,
            usedFallback: true,
            primaryError: primaryErrorMessage,
          }
        } catch (fallbackError) {
          lastFallbackError = fallbackError instanceof Error ? fallbackError : new Error(String(fallbackError))
        }
      }

      throw lastFallbackError || primaryError
    }
  }

  private static getAgentRouterFallbackModels(primaryModelName: string) {
    const configuredModels =
      env.agentRouterFallbackModels.length > 0
        ? env.agentRouterFallbackModels
        : DEFAULT_AGENTROUTER_FALLBACK_MODELS

    return Array.from(new Set(configuredModels.map((model) => model.trim()).filter(Boolean))).filter(
      (model) => model !== primaryModelName
    )
  }

  private static shouldUseAgentRouterFallback(primaryErrorMessage: string, fallbackModels: string[]) {
    if (!env.agentRouterApiKey || fallbackModels.length === 0) {
      return false
    }

    const normalized = primaryErrorMessage.toLowerCase()
    return !(
      normalized.includes("unsupported ai provider") ||
      normalized.includes("unsupported ai model") ||
      normalized.includes("agentrouter_api_key is not configured")
    )
  }

  private static async callOpenRouter(
    modelName: string,
    prompt: string,
    mode: "chat" | "files" | "inspect",
    promptLanguage: PromptLanguage = "id",
    temperatureOverride?: number
  ): Promise<ProviderMessage> {
    const config = assertOpenRouterReady()
    return this.callChatCompletions({
      providerLabel: "OpenRouter",
      apiKey: config.apiKey,
      baseUrl: config.baseUrl,
      modelName,
      prompt,
      mode,
      promptLanguage,
      temperatureOverride,
    })
  }

  private static async callAgentRouter(
    modelName: string,
    prompt: string,
    mode: "chat" | "files" | "inspect",
    promptLanguage: PromptLanguage = "id",
    temperatureOverride?: number
  ): Promise<ProviderMessage> {
    const config = assertAgentRouterReady()
    return this.callChatCompletions({
      providerLabel: "AgentRouter",
      apiKey: config.apiKey,
      baseUrl: config.baseUrl,
      modelName,
      prompt,
      mode,
      promptLanguage,
      temperatureOverride,
    })
  }

  private static async callChatCompletions({
    providerLabel,
    apiKey,
    baseUrl,
    modelName,
    prompt,
    mode,
    promptLanguage,
    temperatureOverride,
  }: {
    providerLabel: string
    apiKey: string
    baseUrl: string
    modelName: string
    prompt: string
    mode: "chat" | "files" | "inspect"
    promptLanguage: PromptLanguage
    temperatureOverride?: number
  }): Promise<ProviderMessage> {
    let lastError: Error | null = null
    const maxAttempts = this.getMaxAttempts(mode)

    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      try {
        const response = await this.fetchWithTimeout(
          `${baseUrl}/chat/completions`,
          {
            method: "POST",
            headers: this.buildProviderHeaders(apiKey),
            body: JSON.stringify(this.buildProviderPayload(modelName, prompt, mode, promptLanguage, temperatureOverride)),
          },
          this.getTimeoutMs(mode),
          providerLabel
        )

        if (response.ok) {
          const data = await response.json()
          return {
            message: data.choices?.[0]?.message?.content || `No response returned by ${providerLabel}.`,
          }
        }

        lastError = new Error(await this.extractError(response, providerLabel))

        const shouldRetrySameModel = response.status === 408 || response.status === 429 || response.status >= 500
        if (!shouldRetrySameModel || attempt === maxAttempts - 1) {
          break
        }

        await this.sleep(800 * (attempt + 1))
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error))
        if (lastError instanceof ProviderTimeoutError) {
          break
        }

        if (attempt < maxAttempts - 1) {
          await this.sleep(800 * (attempt + 1))
          continue
        }
      }
    }

    throw lastError || new Error(`${providerLabel} request failed.`)
  }

  private static buildProviderPayload(
    modelName: string,
    prompt: string,
    mode: "chat" | "files" | "inspect",
    promptLanguage: PromptLanguage = "id",
    temperatureOverride?: number
  ) {
    const payload: Record<string, unknown> = {
      model: modelName,
      messages: this.buildMessages(prompt, mode, promptLanguage),
      temperature: this.getTemperature(mode, temperatureOverride),
      top_p: 0.9,
      max_tokens: this.getMaxTokens(mode),
    }

    if (mode === "files") {
      payload.response_format = {
        type: "json_object",
      }
    }

    return payload
  }

  private static buildProviderHeaders(apiKey: string) {
    return {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "HTTP-Referer": env.nextAuthUrl || env.appUrl || "http://localhost:3000",
      "X-Title": "Swift AI Web Builder",
    }
  }

  private static buildMessages(
    prompt: string,
    mode: "chat" | "files" | "inspect",
    promptLanguage: PromptLanguage = "id"
  ) {
    if (mode === "files") {
      return [
        { role: "system", content: FILE_OUTPUT_SYSTEM_PROMPT },
        { role: "user", content: prompt },
      ]
    }

    if (mode === "inspect") {
      return [
        { role: "system", content: INSPECT_SYSTEM_PROMPTS[promptLanguage] || INSPECT_SYSTEM_PROMPTS.id },
        { role: "user", content: prompt },
      ]
    }

    return [
      { role: "system", content: CHAT_SYSTEM_PROMPTS[promptLanguage] || CHAT_SYSTEM_PROMPTS.id },
      { role: "user", content: prompt },
    ]
  }

  private static getTemperature(mode: "chat" | "files" | "inspect", override?: number) {
    if (typeof override === "number") {
      return override
    }

    if (mode === "files") {
      return 0.15
    }

    if (mode === "inspect") {
      return 0.2
    }

    return 0.5
  }

  private static getMaxTokens(mode: "chat" | "files" | "inspect") {
    if (mode === "files") {
      return env.aiMaxOutputTokens
    }

    if (mode === "inspect") {
      return Math.min(env.aiMaxOutputTokens, 2500)
    }

    return Math.min(env.aiMaxOutputTokens, 1200)
  }

  private static getTimeoutMs(mode: "chat" | "files" | "inspect") {
    if (mode === "files") {
      return Math.min(Math.max(env.aiTimeoutMs, 30_000), 45_000)
    }

    if (mode === "inspect") {
      return Math.max(env.aiTimeoutMs, 30_000)
    }

    return env.aiTimeoutMs
  }

  private static getMaxAttempts(mode: "chat" | "files" | "inspect") {
    if (mode === "files") {
      return 1
    }

    return env.aiMaxRetries
  }

  private static async fetchWithTimeout(
    url: string,
    init: RequestInit,
    timeoutMs: number,
    providerLabel?: string
  ) {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), timeoutMs)

    try {
      return await fetch(url, {
        ...init,
        signal: controller.signal,
      })
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        throw new ProviderTimeoutError(timeoutMs, providerLabel)
      }

      throw error
    } finally {
      clearTimeout(timeout)
    }
  }

  private static async extractError(response: Response, providerLabel: string) {
    const text = await response.text()

    try {
      const parsed = JSON.parse(text)
      const baseMessage = parsed.error?.message || parsed.message || text
      const metadataRaw =
        typeof parsed.error?.metadata?.raw === "string"
          ? parsed.error.metadata.raw
          : ""
      const detail = metadataRaw ? ` ${metadataRaw}` : ""
      return `${providerLabel} API error (${response.status}): ${baseMessage}${detail}`.trim()
    } catch {
      return `${providerLabel} API error (${response.status}): ${text}`
    }
  }

  private static sleep(ms: number) {
    return new Promise((resolve) => setTimeout(resolve, ms))
  }
}

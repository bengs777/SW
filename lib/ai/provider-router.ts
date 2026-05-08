import { assertOpenRouterReady, OPENROUTER_MODEL_ID, OPENROUTER_PROVIDER } from "@/lib/ai/openrouter-config"
import type { PromptLanguage } from "@/lib/ai/prompt-templates"
import type { PromptAttachment } from "@/lib/types"
import { env } from "@/lib/env"

export type ProviderName = typeof OPENROUTER_PROVIDER

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
  usedFallback: false
  primaryError?: string
}

type ProviderMessage = {
  message: string
}

class ProviderTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`OpenRouter request timed out after ${Math.round(timeoutMs / 1000)} seconds`)
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
    if (provider !== OPENROUTER_PROVIDER) {
      throw new Error(`Unsupported AI provider: ${provider}`)
    }

    if (modelName !== OPENROUTER_MODEL_ID) {
      throw new Error(`Unsupported AI model: ${modelName}`)
    }

    const result = await this.callOpenRouter(prompt, mode, promptLanguage, temperatureOverride)

    return {
      message: result.message,
      providerUsed: OPENROUTER_PROVIDER,
      modelUsed: OPENROUTER_MODEL_ID,
      usedFallback: false,
    }
  }

  private static async callOpenRouter(
    prompt: string,
    mode: "chat" | "files" | "inspect",
    promptLanguage: PromptLanguage = "id",
    temperatureOverride?: number
  ): Promise<ProviderMessage> {
    const config = assertOpenRouterReady()
    let lastError: Error | null = null

    for (let attempt = 0; attempt < env.aiMaxRetries; attempt += 1) {
      try {
        const response = await this.fetchWithTimeout(
          `${config.baseUrl}/chat/completions`,
          {
            method: "POST",
            headers: this.buildOpenRouterHeaders(config.apiKey),
            body: JSON.stringify(this.buildOpenRouterPayload(prompt, mode, promptLanguage, temperatureOverride)),
          },
          this.getTimeoutMs(mode)
        )

        if (response.ok) {
          const data = await response.json()
          return {
            message: data.choices?.[0]?.message?.content || "No response returned by OpenRouter.",
          }
        }

        lastError = new Error(await this.extractError(response))

        const shouldRetrySameModel = response.status === 408 || response.status === 429 || response.status >= 500
        if (!shouldRetrySameModel || attempt === env.aiMaxRetries - 1) {
          break
        }

        await this.sleep(800 * (attempt + 1))
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error))
        if (attempt < env.aiMaxRetries - 1) {
          await this.sleep(800 * (attempt + 1))
          continue
        }
      }
    }

    throw lastError || new Error("OpenRouter request failed.")
  }

  private static buildOpenRouterPayload(
    prompt: string,
    mode: "chat" | "files" | "inspect",
    promptLanguage: PromptLanguage = "id",
    temperatureOverride?: number
  ) {
    const payload: Record<string, unknown> = {
      model: OPENROUTER_MODEL_ID,
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

  private static buildOpenRouterHeaders(apiKey: string) {
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
      return Math.max(env.aiTimeoutMs, 60_000)
    }

    if (mode === "inspect") {
      return Math.max(env.aiTimeoutMs, 30_000)
    }

    return env.aiTimeoutMs
  }

  private static async fetchWithTimeout(
    url: string,
    init: RequestInit,
    timeoutMs: number
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
        throw new ProviderTimeoutError(timeoutMs)
      }

      throw error
    } finally {
      clearTimeout(timeout)
    }
  }

  private static async extractError(response: Response) {
    const text = await response.text()

    try {
      const parsed = JSON.parse(text)
      const baseMessage = parsed.error?.message || parsed.message || text
      const metadataRaw =
        typeof parsed.error?.metadata?.raw === "string"
          ? parsed.error.metadata.raw
          : ""
      const detail = metadataRaw ? ` ${metadataRaw}` : ""
      return `OpenRouter API error (${response.status}): ${baseMessage}${detail}`.trim()
    } catch {
      return `OpenRouter API error (${response.status}): ${text}`
    }
  }

  private static sleep(ms: number) {
    return new Promise((resolve) => setTimeout(resolve, ms))
  }
}

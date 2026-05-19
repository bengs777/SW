import type { PromptLanguage } from "@/lib/ai/prompt-templates"
import type { PromptAttachment } from "@/lib/types"
import {
  DEFAULT_SWIFT_TIER_KEY,
  USER_FRIENDLY_AI_ENGINE_ERROR,
  getSwiftTierConfig,
  getSwiftModelTargets,
  hasOpenRouterGatewayKey,
  isSwiftFreeAiMode,
  type ProviderFailureReason,
  type SwiftModelTarget,
  type SwiftModelRoutingTask,
  type SwiftTierConfig,
  type SwiftTierKey,
} from "@/lib/ai/swift-tiers"
import { createOpenRouterChatCompletion } from "@/lib/ai/openrouter-client"
import { SwiftAiError, redactAiSecret } from "@/lib/ai/errors"
import { getHealthSnapshot, isModelTemporarilyUnavailable, markModelFailure, markModelSuccess } from "@/lib/ai/provider-health"
import { MAX_PROVIDER_ATTEMPTS_PER_REQUEST, retryDelayMs, shouldRetryModel, sleep } from "@/lib/ai/retries"
import { buildCacheKey, getCachedResponse, setCachedResponse } from "@/lib/ai/response-cache"
import { buildDomainAnchorDirective } from "@/lib/ai/prompt-guard"
import { env } from "@/lib/env"
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
  routingTask?: SwiftModelRoutingTask
  signal?: AbortSignal
}

function nextAvailableTarget(targets: SwiftModelTarget[], currentModelId: string) {
  const currentIndex = targets.findIndex((target) => target.modelId === currentModelId)
  const next = targets.slice(currentIndex + 1).find((target) => !isModelTemporarilyUnavailable(target.modelId))
  return next?.modelId || null
}

function modelRoutingTaskForRequest(prompt: string, mode: "chat" | "files" | "inspect"): SwiftModelRoutingTask {
  const text = String(prompt || "")
  if (mode !== "files") return "edit_patch"

  if (
    /PARTIAL_REGENERATION_CONTRACT|component_scoped_edit|file_scoped_edit|style_copy_edit|runtime_fix|Current file objective/i.test(text)
  ) {
    return "edit_patch"
  }

  return "large_generation"
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
  "KAMU ADALAH ORCHESTRATOR SWIFT BUILDER. TUGASMU: RENCANAKAN DAN EKSEKUSI FILE SESUAI MODE PIPELINE.",
  "ATURAN INTERNAL: preview mode kecil dan cepat; production full-stack mode wajib menghasilkan slice deployable yang mencakup UI, API, data layer, config, dan integrasi server-side sesuai prompt.",
  "You are Swift AI.",
  "[STRICT RULE] Anda adalah mesin generator Next.js 14+ App Router.",
  "Hasilkan kode bersih yang HANYA berfokus pada industri yang diminta oleh pengguna.",
  "DILARANG KERAS berasumsi atau memasukkan komponen finansial, dasbor SaaS, metrik pendapatan, tingkat konversi bisnis, atau grafik keuangan jika pengguna meminta kategori non-komersial seperti portal berita desa, portofolio pribadi, atau web hobi.",
  "Fokus pada fungsionalitas murni sesuai teks prompt pengguna.",
  "Public identity: Swift AI only. Never mention other AI providers, model brands, competitors, or model switching.",
  isSwiftFreeAiMode()
    ? "Swift AI is running in free evaluation mode for internal cost control. Keep output compact, valid, and deterministic."
    : "Swift AI is a production-grade AI full-stack generator platform with a single internal orchestrator route.",
  "Public pricing is fixed at Rp3.000 per generation.",
  "Optimize every response for token efficiency, generation cost, high correctness, deploy-ready structure, and minimal hallucination.",
  "ATURAN KERAS SWIFT BUILDER: ikuti EXECUTION_RULES dari prompt user. Preview mode dibatasi kecil; PRODUCTION_FULLSTACK_MODE boleh multi-file dan wajib mencakup backend bila prompt meminta full-stack.",
  "PAKAI DATA DUMMY hanya untuk preview mode. Dalam PRODUCTION_FULLSTACK_MODE, buat Prisma schema, API routes, service layer, env placeholder, auth/payment/API boundaries sesuai permintaan prompt.",
  "MAX 4000 TOKEN PER FILE dan jangan bikin file lebih dari 150 baris bila bisa dibuat ringkas.",
  "PATH HARUS BENAR: root Next.js adalah /app. Jangan buat /src/app.",
  "Jangan pernah generate next-auth.d.ts. Untuk jalur NextAuth gunakan auth.ts atau file allowed di lib/ dan app/ saja.",
  "Kalau prompt user terlalu besar, pecah otomatis menjadi slice produksi yang tetap deployable. Sertakan next_steps di metadata untuk tahap lanjutan.",
  "Return ONLY a valid JSON object. No markdown, no code fences, no preamble, no chat.",
  'Preferred JSON schema: {"taskGraph":{"intent":"domain-specific intent","summary":"short execution summary","dependencies":["lucide-react"],"operations":[{"id":"op-1","action":"create|modify|delete","path":"app/page.tsx","language":"tsx","content":"full file content","reason":"why this operation is needed"}]},"files":[],"dependencies":[],"diagnostics":[],"metadata":{},"repairs":[]}',
  'For planning metadata, use metadata.next_steps like ["Hubungkan ke Turso","Ganti dummy jadi Prisma query"].',
  "Use taskGraph.operations for every file mutation. Use action delete only when the user asks to remove a file or a file is clearly obsolete.",
  "Never generate an entire application at once, never regenerate the whole repository, and never rewrite unrelated files.",
  "Pipeline: analyze intent, build a JSON task graph, execute create/modify/delete operations, install declared dependencies, validate runtime safety, run focused repairs only when needed, then return the final patch.",
  "Analyze intent, create a small roadmap internally, then implement exactly one feature/module per response.",
  "Return changed files only, with complete file contents.",
  "MAX 3 FILE PER GENERATE applies only when EXECUTION_RULES says PREVIEW_MODE. It does not apply to PRODUCTION_FULLSTACK_MODE.",
  "Use only existing stack: Next.js App Router, React, TypeScript, Tailwind CSS, Prisma, Route Handlers, lucide-react, zod, next-auth, shadcn/ui.",
  "Always keep output compile-safe: valid imports, aliases, dependencies, jsx-runtime compatibility, TypeScript, App Router compatibility, and Prisma consistency.",
  "Generated TSX must parse cleanly with @babel/parser using jsx + typescript plugins. Do not output raw emoji or decorative non-ASCII symbols in code; use text labels or lucide-react icons only when already imported.",
  "Never split a quoted string across lines. For long copy, use JSX text nodes, arrays of short strings, or template literals that are properly closed.",
  "Use diff-only execution: no full repo injection, no unrelated files, focused logs only, no broad context dumps.",
  "For SaaS/web app requests include folder structure only when requested, database schema/API routes only when needed, responsive UI, loading/error states, clean state handling, and scalable architecture.",
  "Prioritize correctness, runtime stability, token efficiency, speed, and visual polish.",
].join(" ")

const INSPECT_SYSTEM_PROMPTS: Record<PromptLanguage, string> = {
  id: [
    "Kamu adalah Swift AI, senior fullstack debugger untuk browser preview.",
    "Identitas publik hanya Swift AI. Jangan sebut provider, model kompetitor, atau saran ganti model.",
    "Gunakan preview context, error browser, dan prompt user sebagai evidence.",
    "Jawab dalam bahasa Indonesia.",
    "Fokus pada root cause, patch minimal, token efisien, dan verifikasi.",
  ].join(" "),
  en: [
    "You are Swift AI, a senior fullstack debugger for browser preview.",
    "Public identity is Swift AI only. Never mention providers, competitor models, or model switching.",
    "Use the preview context, browser error, and user prompt as evidence.",
    "Reply in English.",
    "Focus on root cause, the smallest patch, token efficiency, and verification.",
  ].join(" "),
}

const CHAT_SYSTEM_PROMPTS: Record<PromptLanguage, string> = {
  id: [
    "Kamu adalah Swift AI, AI percakapan yang membantu di dalam web app builder.",
    "Identitas publik hanya Swift AI. Jangan sebut provider, model kompetitor, atau saran ganti model.",
    "Balas natural dalam bahasa Indonesia.",
    "Jawab ringkas dan padat. Jangan keluarkan JSON, daftar file, atau kode kecuali user meminta implementasi.",
  ].join(" "),
  en: [
    "You are Swift AI, a conversational AI inside a web app builder.",
    "Public identity is Swift AI only. Never mention providers, competitor models, or model switching.",
    "Reply naturally in English.",
    "Keep responses compact. Do not output JSON, file lists, or code unless the user asks for implementation.",
  ].join(" "),
}

export class ProviderRouter {
  static async generate({
    modelName,
    prompt,
    mode = "files",
    promptLanguage = "id",
    temperatureOverride,
    routingTask,
    signal,
    provider,
  }: ProviderRequest): Promise<ProviderResponse> {
    validateProvider(provider)
    const tier = this.resolveTier(modelName, mode)
    const resolvedRoutingTask = routingTask || modelRoutingTaskForRequest(prompt, mode)
    const targets = getSwiftModelTargets(resolvedRoutingTask)
    const attempts: ProviderAttemptLog[] = []
    log("info", "swift_model_route", {
      mode,
      routingTask: resolvedRoutingTask,
      targetCount: targets.length,
      models: targets.map((target) => target.modelId),
    })

    if (targets.length === 0) {
      console.log("provider_attempt", "openrouter")
      console.log("model", tier.key)
      console.log("provider_error", "No Swift AI model chain is configured")
      console.log("failover_exhausted")
      attempts.push({
        provider: "openrouter",
        modelName: tier.key,
        status: "failed",
        failureReason: "config",
        latencyMs: 0,
        errorMessage: "No Swift AI model chain is configured",
      })
      throw new SwiftProviderFailureError(tier.key, attempts)
    }

    if (!hasOpenRouterGatewayKey()) {
      console.log("provider_attempt", "openrouter")
      console.log("model", targets[0]?.modelId || tier.key)
      console.log("provider_error", "OPENROUTER_API_KEY is not configured")
      console.log("failover_exhausted")
      attempts.push({
        provider: "openrouter",
        modelName: targets[0]?.modelId || tier.key,
        status: "failed",
        failureReason: "config",
        latencyMs: 0,
        errorMessage: "OPENROUTER_API_KEY is not configured",
      })
      throw new SwiftProviderFailureError(tier.key, attempts)
    }

    // --- Inject domain anchor for files mode to keep AI directionally accurate ---
    const groundedPrompt =
      mode === "files" ? `${prompt}${buildDomainAnchorDirective(prompt, promptLanguage)}` : prompt

    // --- Cache lookup for cacheable modes (chat, inspect) ---
    // Files mode is NEVER cached because outputs depend on per-request project state.
    const cacheable = mode === "chat" || mode === "inspect"
    const systemPrompt = this.getSystemPrompt(mode, promptLanguage)
    const temperature = this.getTemperature(mode, temperatureOverride)
    const primaryModelId = targets[0]?.modelId || tier.key
    const cacheKey = cacheable
      ? buildCacheKey({
          mode,
          modelId: primaryModelId,
          prompt: groundedPrompt,
          systemPrompt,
          temperature,
        })
      : null

    if (cacheKey) {
      const cached = await getCachedResponse(cacheKey)
      if (cached) {
        attempts.push({
          provider: "swift",
          modelName: tier.key,
          status: "success",
          latencyMs: 0,
        })
        log("info", "ai_cache_hit", {
          mode,
          tier: tier.key,
          cachedAt: cached.cachedAt,
        })
        return {
          message: cached.message,
          providerUsed: "swift",
          modelUsed: tier.key,
          selectedTier: tier.key,
          usedFallback: false,
          attempts,
          tokenUsage: cached.tokenUsage,
        }
      }
    }

    let totalAttempts = 0
    let firstError: string | undefined

    const maxAttemptsForChain = Math.min(MAX_PROVIDER_ATTEMPTS_PER_REQUEST, targets.length * 3)

    for (const [targetIndex, target] of targets.entries()) {
      if (isModelTemporarilyUnavailable(target.modelId)) {
        const nextProvider = nextAvailableTarget(targets, target.modelId)
        console.log("provider_attempt", "openrouter")
        console.log("model", target.modelId)
        console.log("provider_error", "Model is cooling down after repeated failures")
        console.log("failover_next", nextProvider || null)
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
        if (totalAttempts >= maxAttemptsForChain) {
          console.log("failover_exhausted")
          throw new SwiftProviderFailureError(tier.key, attempts)
        }

        totalAttempts += 1
        const startedAt = Date.now()
        console.log("provider_attempt", "openrouter")
        console.log("model", target.modelId)

        try {
          const result = await this.callOpenRouterTarget(target, {
            prompt: groundedPrompt,
            mode,
            promptLanguage,
            tier,
            temperatureOverride,
            signal,
          })
          const latencyMs = Date.now() - startedAt
          attempts.push({
            provider: "openrouter",
            modelName: target.modelId,
            status: "success",
            latencyMs,
            requestId: result.requestId,
          })
          markModelSuccess(target.modelId, latencyMs)

          // Persist to cache (fire and forget, never blocks response)
          if (cacheKey) {
            void setCachedResponse(cacheKey, mode as "chat" | "inspect", {
              message: result.message,
              tokenUsage: result.tokenUsage,
            }).catch(() => null)
          }

          return {
            message: result.message,
            providerUsed: "swift",
            modelUsed: tier.key,
            selectedTier: tier.key,
            usedFallback: targetIndex > 0,
            primaryError: firstError,
            attempts,
            tokenUsage: result.tokenUsage,
          }
        } catch (error) {
          const normalized = this.normalizeError(error, target)
          const latencyMs = Date.now() - startedAt
          const redactedErrorMessage = redactAiSecret(normalized.message)
          const willRetrySameModel = shouldRetryModel(normalized.reason, retryCount)
          const nextProvider = willRetrySameModel
            ? target.modelId
            : nextAvailableTarget(targets, target.modelId)
          console.log("provider_error", redactedErrorMessage)
          console.log("failover_next", nextProvider || null)
          firstError = firstError || normalized.message
          attempts.push({
            provider: "openrouter",
            modelName: target.modelId,
            status: "failed",
            failureReason: normalized.reason,
            statusCode: normalized.statusCode,
            latencyMs,
            requestId: normalized.requestId,
            errorMessage: redactedErrorMessage,
          })
          markModelFailure(target.modelId, {
            reason: normalized.reason,
            latencyMs,
            statusCode: normalized.statusCode,
            message: redactedErrorMessage,
          })

          if (!willRetrySameModel) {
            break
          }

          retryCount += 1
          const delayMs = retryDelayMs(retryCount)
          log("warn", "ai_provider_retry_scheduled", {
            mode,
            tier: tier.key,
            targetRole: target.role,
            failureReason: normalized.reason,
            statusCode: normalized.statusCode,
            retryCount,
            delayMs,
            requestId: normalized.requestId,
          })
          await sleep(delayMs)
        }
      }
    }

    log("warn", "Swift AI OpenRouter request exhausted", {
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

    console.log("failover_exhausted")
    throw new SwiftProviderFailureError(tier.key, attempts)
  }

  static async getConfiguredProviderHealth() {
    return getHealthSnapshot({ ttlMs: env.providerStatusCacheTtlMs })
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
    if (mode === "files") return 0.2
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

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
import {
  createOpenRouterChatCompletion,
  streamOpenRouterChatCompletion,
  type OpenRouterLifecycleEvent,
} from "@/lib/ai/openrouter-client"
import { SwiftAiError, redactAiSecret } from "@/lib/ai/errors"
import { getHealthSnapshot, isModelTemporarilyUnavailable, markModelFailure, markModelSuccess } from "@/lib/ai/provider-health"
import { MAX_PROVIDER_ATTEMPTS_PER_REQUEST, retryDelayMs, shouldRetryModel, sleep } from "@/lib/ai/retries"
import { buildCacheKey, getCachedResponse, setCachedResponse } from "@/lib/ai/response-cache"
import { buildDomainAnchorDirective } from "@/lib/ai/prompt-guard"
import {
  recordProviderAttemptMetric,
  recordProviderFailoverMetric,
  recordProviderTokenUsageMetric,
} from "@/lib/ai/provider-metrics"
import {
  isProviderCircuitOpen,
  markProviderCircuitFailure,
  markProviderCircuitSuccess,
} from "@/lib/ai/provider-circuit-breaker"
import { env } from "@/lib/env"
import { log } from "@/lib/logging"

const PROVIDER_REQUEST_BUDGET_MS = Math.max(
  30_000,
  Math.min(240_000, Number(process.env.AI_PROVIDER_REQUEST_BUDGET_MS || 180_000))
)

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

function createProviderBudget(upstreamSignal: AbortSignal | undefined, budgetMs: number) {
  const startedAt = Date.now()
  const controller = new AbortController()
  const abortForBudget = () => controller.abort()
  const abortForUpstream = () => controller.abort()
  const timeout = setTimeout(abortForBudget, budgetMs)

  if (upstreamSignal) {
    if (upstreamSignal.aborted) {
      abortForUpstream()
    } else {
      upstreamSignal.addEventListener("abort", abortForUpstream, { once: true })
    }
  }

  return {
    signal: controller.signal,
    expired: () => Date.now() - startedAt >= budgetMs,
    cleanup: () => {
      clearTimeout(timeout)
      upstreamSignal?.removeEventListener("abort", abortForUpstream)
    },
  }
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
  lifecycle?: (event: OpenRouterLifecycleEvent) => void
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

function recordAttempt(attempts: ProviderAttemptLog[], attempt: ProviderAttemptLog) {
  attempts.push(attempt)
  recordProviderAttemptMetric(attempt)
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
  "ATURAN INTERNAL: FULL_FRONTEND_MODE adalah default untuk website lengkap dan wajib menghasilkan arsitektur frontend multi-file; production full-stack mode wajib menghasilkan slice deployable yang mencakup UI, API, data layer, config, dan integrasi server-side sesuai prompt.",
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
  "ATURAN KERAS SWIFT BUILDER: ikuti EXECUTION_RULES dari prompt user. FULL_FRONTEND_MODE harus multi-file dan production-like; PREVIEW_MODE hanya untuk preview eksplisit; PRODUCTION_FULLSTACK_MODE boleh multi-file dan wajib mencakup backend bila prompt meminta full-stack.",
  "FRONTEND_ONLY_CONTRACT: if the prompt says UI-only, frontend-only, static page, homepage, landing, storefront, menu, cart, or checkout without explicit backend/API/auth/database/admin/dashboard/payment/server-action requirements, generate only frontend files in the approved scope. Do not infer Prisma, NextAuth, API routes, dashboard, admin, services, or database from storefront/menu/cart/product words alone.",
  "PAKAI DATA PREVIEW hanya untuk PREVIEW_MODE eksplisit. Dalam FULL_FRONTEND_MODE, buat data realistis di lib/data.ts, reusable components, sections, responsive navigation, footer, CTA, dan loading/empty states. Dalam PRODUCTION_FULLSTACK_MODE, buat Prisma schema, API routes, service layer, env placeholder, auth/payment/API boundaries sesuai permintaan prompt.",
  "MAX 4000 TOKEN PER FILE dan jangan bikin file lebih dari 150 baris bila bisa dibuat ringkas.",
  "PATH POLICY: every generated path must be canonical workspace-relative POSIX form, and must start with src/, app/, components/, sections/, component-registry/, lib/, prisma/, or an allowlisted root file such as package.json, tsconfig.json, next.config.ts, tailwind.config.ts, postcss.config.js, README.md, or .env.example. Use app/page.tsx, component-registry/hero.tsx, sections/hero-section.tsx, components/Button.tsx, lib/utils.ts, or package.json; never use /app/page.tsx, ./components/Button.tsx, or ../lib/utils.ts.",
  "BLOCKED PATHS: never use .., ~, absolute paths, node_modules, .env files, .git, package-lock.json, pnpm-lock.yaml, or yarn.lock.",
  "PATH HARUS BENAR: root Next.js adalah /app. Jangan buat /src/app kecuali user secara eksplisit meminta src/ layout.",
  "Jangan pernah generate next-auth.d.ts. Untuk jalur NextAuth gunakan file allowed di lib/ dan app/ saja.",
  "Kalau prompt user terlalu besar, pecah otomatis menjadi slice produksi yang tetap deployable. Sertakan next_steps di metadata untuk tahap lanjutan.",
  "Return ONLY a valid JSON object parseable directly by JSON.parse. No markdown, no code fences, no preamble, no chat, no prose explanations.",
  'Required BUILD JSON schema: {"files":[{"path":"app/page.tsx","content":"full file content"}]}.',
  "The root object must contain only files when generating BUILD artifacts. files must be non-empty. Every file requires path and content. Do not output taskGraph, operations, commands, diagnostics, metadata, repairs, or summary for BUILD artifacts.",
  "Never ask to run shell commands, write files directly, delete files directly, mutate arbitrary paths, or modify lockfiles.",
  "Use file content to include config/placeholders. Do not include separate planning metadata in the response.",
  "Generate a complete frontend architecture when FULL_FRONTEND_MODE or REBUILD is requested; do not rewrite unrelated files in PATCH mode.",
  "Pipeline: analyze intent, build a JSON task graph, execute create/modify/delete operations, install declared dependencies, validate runtime safety, run focused repairs only when needed, then return the final patch.",
  "Analyze intent, create a small roadmap internally, then implement exactly one feature/module per response.",
  "Return changed files only, with complete file contents.",
  "Tiny file budgets apply only when EXECUTION_RULES says explicit PREVIEW_MODE. They do not apply to FULL_FRONTEND_MODE or PRODUCTION_FULLSTACK_MODE.",
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
    lifecycle,
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
      log("error", "provider_attempt_failed", {
        provider: "openrouter",
        model: tier.key,
        error: "No Swift AI model chain is configured",
        failover: "exhausted",
      })
      recordAttempt(attempts, {
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
      log("error", "provider_attempt_failed", {
        provider: "openrouter",
        model: targets[0]?.modelId || tier.key,
        error: "OPENROUTER_API_KEY is not configured",
        failover: "exhausted",
      })
      recordAttempt(attempts, {
        provider: "openrouter",
        modelName: targets[0]?.modelId || tier.key,
        status: "failed",
        failureReason: "config",
        latencyMs: 0,
        errorMessage: "OPENROUTER_API_KEY is not configured",
      })
      throw new SwiftProviderFailureError(tier.key, attempts)
    }

    if (isProviderCircuitOpen("openrouter")) {
      recordAttempt(attempts, {
        provider: "openrouter",
        modelName: targets[0]?.modelId || tier.key,
        status: "failed",
        failureReason: "overloaded",
        latencyMs: 0,
        errorMessage: "OpenRouter circuit breaker is cooling down after repeated failures.",
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
        recordAttempt(attempts, {
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
    const providerBudget = createProviderBudget(signal, PROVIDER_REQUEST_BUDGET_MS)

    try {
      for (const [targetIndex, target] of targets.entries()) {
      if (isModelTemporarilyUnavailable(target.modelId)) {
        const nextProvider = nextAvailableTarget(targets, target.modelId)
        log("warn", "provider_attempt_skipped", {
          provider: "openrouter",
          model: target.modelId,
          error: "Model is cooling down after repeated failures",
          failoverNext: nextProvider || null,
        })
        recordAttempt(attempts, {
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
        if (providerBudget.signal.aborted) {
          recordAttempt(attempts, {
            provider: "openrouter",
            modelName: target.modelId,
            status: "failed",
            failureReason: "cancelled",
            latencyMs: 0,
            errorMessage: "Request was cancelled before provider attempt started.",
          })
          throw new SwiftProviderFailureError(tier.key, attempts)
        }

        if (totalAttempts >= maxAttemptsForChain) {
          log("error", "provider_failover_exhausted", {
            provider: "openrouter",
            tier: tier.key,
            totalAttempts,
          })
          throw new SwiftProviderFailureError(tier.key, attempts)
        }

        if (providerBudget.expired()) {
          log("warn", "provider_request_budget_exhausted", {
            provider: "openrouter",
            tier: tier.key,
            budgetMs: PROVIDER_REQUEST_BUDGET_MS,
            totalAttempts,
          })
          throw new SwiftAiError(`Provider request budget exceeded after ${Math.round(PROVIDER_REQUEST_BUDGET_MS / 1000)} seconds`, {
            reason: "timeout",
            internalModelId: target.modelId,
          })
        }

        totalAttempts += 1
        const startedAt = Date.now()
        log("info", "provider_attempt", {
          provider: "openrouter",
          model: target.modelId,
          attempt: totalAttempts,
        })

        try {
          const result = await this.callOpenRouterTarget(target, {
            prompt: groundedPrompt,
            mode,
            promptLanguage,
            tier,
            temperatureOverride,
            signal: providerBudget.signal,
            lifecycle,
          })
          const latencyMs = Date.now() - startedAt
          recordAttempt(attempts, {
            provider: "openrouter",
            modelName: target.modelId,
            status: "success",
            latencyMs,
            requestId: result.requestId,
          })
          markModelSuccess(target.modelId, latencyMs)
          markProviderCircuitSuccess("openrouter")
          recordProviderTokenUsageMetric(result.tokenUsage)

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
          const normalized =
            providerBudget.expired() && error instanceof Error && error.name === "AbortError"
              ? new SwiftAiError(`Provider request budget exceeded after ${Math.round(PROVIDER_REQUEST_BUDGET_MS / 1000)} seconds`, {
                  reason: "timeout",
                  internalModelId: target.modelId,
                })
              : this.normalizeError(error, target)
          const latencyMs = Date.now() - startedAt
          const redactedErrorMessage = redactAiSecret(normalized.message)
          const willRetrySameModel = normalized.reason === "timeout" ? false : shouldRetryModel(normalized.reason, retryCount)
          const nextProvider = willRetrySameModel
            ? target.modelId
            : nextAvailableTarget(targets, target.modelId)
          log("warn", "provider_attempt_failed", {
            provider: "openrouter",
            model: target.modelId,
            error: redactedErrorMessage,
            failureReason: normalized.reason,
            statusCode: normalized.statusCode,
            failoverNext: nextProvider || null,
            latencyMs,
          })
          firstError = firstError || normalized.message
          recordAttempt(attempts, {
            provider: "openrouter",
            modelName: target.modelId,
            status: "failed",
            failureReason: normalized.reason,
            statusCode: normalized.statusCode,
            latencyMs,
            requestId: normalized.requestId,
            errorMessage: redactedErrorMessage,
          })
          if (normalized.reason === "cancelled") {
            log("warn", "provider_request_cancelled", {
              provider: "openrouter",
              model: target.modelId,
              requestId: normalized.requestId,
              latencyMs,
            })
            throw new SwiftProviderFailureError(tier.key, attempts)
          }
          markModelFailure(target.modelId, {
            reason: normalized.reason,
            latencyMs,
            statusCode: normalized.statusCode,
            message: redactedErrorMessage,
          })
          markProviderCircuitFailure("openrouter", {
            reason: normalized.reason,
            message: redactedErrorMessage,
          })

          if (!willRetrySameModel) {
            if (nextProvider) {
              recordProviderFailoverMetric()
            }
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
          await sleep(delayMs, providerBudget.signal)
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

      log("error", "provider_failover_exhausted", {
      provider: "openrouter",
      tier: tier.key,
      totalAttempts,
    })
      throw new SwiftProviderFailureError(tier.key, attempts)
    } finally {
      providerBudget.cleanup()
    }
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
      lifecycle?: (event: OpenRouterLifecycleEvent) => void
    }
  ) {
    const stream = streamOpenRouterChatCompletion({
      model: target.modelId,
      messages: this.buildMessages(input.prompt, input.mode, input.promptLanguage),
      temperature: this.getTemperature(input.mode, input.temperatureOverride),
      maxTokens: target.maxOutputTokens || input.tier.maxOutputTokens,
      responseFormat: input.mode === "files" ? "json_object" : undefined,
      timeoutMs: target.timeoutMs || input.tier.timeoutMs,
      signal: input.signal,
      lifecycle: input.lifecycle,
    })

    let message = ""
    let requestId: string | null | undefined = null
    for await (const event of stream) {
      if (event.type === "delta") {
        message += event.delta
        if (isCompleteTaskGraphJson(message)) {
          break
        }
      } else if (event.type === "done") {
        requestId = event.requestId
      }
    }

    if (!message.trim()) {
      throw new SwiftAiError("OpenRouter returned an empty streamed response", {
        reason: "empty_response",
        requestId,
        internalModelId: target.modelId,
      })
    }

    return {
      message,
      requestId,
      tokenUsage: undefined,
    }
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

function isCompleteTaskGraphJson(value: string) {
  const raw = String(value || "").trim()
  if (!raw.endsWith("}")) return false
  if (!isBalancedJsonObject(raw)) return false
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed?.taskGraph?.operations)
  } catch {
    return false
  }
}

function isBalancedJsonObject(value: string) {
  let depth = 0
  let inString = false
  let escaped = false
  for (const char of value) {
    if (escaped) {
      escaped = false
      continue
    }
    if (char === "\\") {
      escaped = inString
      continue
    }
    if (char === "\"") {
      inString = !inString
      continue
    }
    if (inString) continue
    if (char === "{") depth += 1
    if (char === "}") depth -= 1
    if (depth < 0) return false
  }
  return depth === 0 && !inString
}

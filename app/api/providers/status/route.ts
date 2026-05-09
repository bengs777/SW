import { NextRequest, NextResponse } from "next/server"
import { auth } from "@/auth"
import { ModelConfigService } from "@/lib/services/model-config.service"
import { AGENTROUTER_PROVIDER, getAgentRouterConfig } from "@/lib/ai/agentrouter-config"
import { OPENROUTER_BASE_URL, OPENROUTER_MODEL_ID, OPENROUTER_PROVIDER, getOpenRouterConfig } from "@/lib/ai/openrouter-config"
import { env } from "@/lib/env"

type ProviderState = "connected" | "slow" | "timeout"
type ProviderIssue = "healthy" | "latency" | "auth" | "quota" | "config" | "unknown"

type ProviderStatus = {
  status: ProviderState
  issue: ProviderIssue
  checkedAt?: number
  responseTimeMs: number
  reason: string
  action: string
  provider: string
  modelName: string
  usedFallback?: boolean
}

const REQUEST_TIMEOUT_MS = 8_000
const DEFAULT_AGENTROUTER_STATUS_MODELS = [
  "deepseek-v3.2",
  "deepseek-v3.1",
  "glm-4.6",
  "glm-5.1",
  "claude-haiku-4-5-20251001",
  "deepseek-r1-0528",
  "claude-opus-4-6",
]
const statusCache = new Map<string, ProviderStatus>()

export async function GET(request: NextRequest) {
  const session = await auth()
  if (!session?.user?.email) {
    return NextResponse.json({ error: "Authentication required" }, { status: 401 })
  }

  const modelKey = request.nextUrl.searchParams.get("modelKey")?.trim()
  if (!modelKey) {
    return NextResponse.json({ error: "modelKey is required" }, { status: 400 })
  }

  const model = await ModelConfigService.getActiveModelByKey(modelKey)
  if (!model) {
    return NextResponse.json({ error: "Model not available" }, { status: 404 })
  }

  const shouldRefresh = request.nextUrl.searchParams.get("refresh") === "true"
  const now = Date.now()
  const cacheKey = `${model.provider}:${model.modelName}:${getAgentRouterStatusModels(model.modelName).join("|")}`
  const cached = statusCache.get(cacheKey)

  if (!shouldRefresh && cached?.checkedAt && now - cached.checkedAt < env.providerStatusCacheTtlMs) {
    return NextResponse.json(formatStatusResponse(modelKey, cached, true))
  }

  const status = await checkModelAndFallbackStatus(model.provider, model.modelName)
  statusCache.set(cacheKey, {
    ...status,
    checkedAt: now,
  })

  return NextResponse.json(formatStatusResponse(modelKey, { ...status, checkedAt: now }, false))
}

function formatStatusResponse(modelKey: string, status: ProviderStatus, cached: boolean) {
  return {
    modelKey,
    status: status.status,
    issue: status.issue,
    checkedAt: new Date(status.checkedAt || Date.now()).toISOString(),
    responseTimeMs: status.responseTimeMs,
    reason: status.reason,
    action: status.action,
    provider: status.provider,
    modelName: status.modelName,
    usedFallback: Boolean(status.usedFallback),
    cached,
  }
}

async function checkModelAndFallbackStatus(provider: string, modelName: string): Promise<ProviderStatus> {
  const primaryStatus = await checkProviderStatus(provider, modelName)
  if (primaryStatus.status === "connected" || primaryStatus.status === "slow") {
    return primaryStatus
  }

  const fallbackStatus = await checkAgentRouterFallbackStatus(modelName)
  if (fallbackStatus) {
    return {
      ...fallbackStatus,
      usedFallback: true,
      reason: `Primary provider failed: ${primaryStatus.reason}. Fallback ${fallbackStatus.provider}/${fallbackStatus.modelName} responded.`,
      action: "Fallback AgentRouter siap. Generate akan otomatis mencoba fallback yang tersedia di env.",
    }
  }

  const openRouterFallbackStatus = await checkOpenRouterFallbackStatus(provider, modelName)
  if (openRouterFallbackStatus) {
    return {
      ...openRouterFallbackStatus,
      usedFallback: true,
      reason: `Primary provider failed: ${primaryStatus.reason}. Fallback ${openRouterFallbackStatus.provider}/${openRouterFallbackStatus.modelName} responded.`,
      action: "Fallback OpenRouter siap. Generate akan otomatis memakai provider yang ready di env.",
    }
  }

  return {
    ...primaryStatus,
    action: `${primaryStatus.action} Tidak ada fallback AgentRouter yang siap dari env saat pengecekan ini.`,
  }
}

async function checkOpenRouterFallbackStatus(provider: string, modelName: string) {
  if (provider === OPENROUTER_PROVIDER && modelName === OPENROUTER_MODEL_ID) {
    return null
  }

  const config = getOpenRouterConfig()
  if (!config.apiKey) {
    return null
  }

  const status = await checkSingleSource({
    provider: OPENROUTER_PROVIDER,
    label: "OpenRouter",
    url: `${OPENROUTER_BASE_URL}/chat/completions`,
    modelName: OPENROUTER_MODEL_ID,
    apiKey: config.apiKey,
  })

  return status.status === "connected" || status.status === "slow" ? status : null
}

async function checkProviderStatus(provider: string, modelName: string): Promise<ProviderStatus> {
  if (provider === AGENTROUTER_PROVIDER) {
    const config = getAgentRouterConfig()
    if (!config.apiKey) {
      return buildConfigStatus(provider, modelName, "AGENTROUTER_API_KEY is not configured")
    }

    return checkSingleSource({
      provider,
      label: "AgentRouter",
      url: `${config.baseUrl}/chat/completions`,
      modelName,
      apiKey: config.apiKey,
    })
  }

  const config = getOpenRouterConfig()
  if (!config.apiKey) {
    return buildConfigStatus(provider, modelName, "OPENROUTER_API_KEY is not configured")
  }

  return checkSingleSource({
    provider: OPENROUTER_PROVIDER,
    label: "OpenRouter",
    url: `${OPENROUTER_BASE_URL}/chat/completions`,
    modelName: OPENROUTER_MODEL_ID,
    apiKey: config.apiKey,
  })
}

async function checkAgentRouterFallbackStatus(primaryModelName: string) {
  const config = getAgentRouterConfig()
  if (!config.apiKey) {
    return null
  }

  for (const modelName of getAgentRouterStatusModels(primaryModelName)) {
    const status = await checkSingleSource({
      provider: AGENTROUTER_PROVIDER,
      label: "AgentRouter",
      url: `${config.baseUrl}/chat/completions`,
      modelName,
      apiKey: config.apiKey,
    })

    if (status.status === "connected" || status.status === "slow") {
      return status
    }

    if (status.issue === "auth") {
      return {
        ...status,
        reason: `AgentRouter authentication failed for all models. API key may be invalid or expired.`,
        action: "Periksa AGENTROUTER_API_KEY di .env. Jika key sudah tidak valid, kosongkan agar Swift hanya memakai OpenRouter.",
      }
    }
  }

  return null
}

function getAgentRouterStatusModels(primaryModelName: string) {
  const models =
    env.agentRouterFallbackModels.length > 0
      ? env.agentRouterFallbackModels
      : DEFAULT_AGENTROUTER_STATUS_MODELS

  return Array.from(new Set(models.map((model) => model.trim()).filter(Boolean))).filter(
    (model) => model !== primaryModelName
  )
}

function buildConfigStatus(provider: string, modelName: string, reason: string): ProviderStatus {
  return {
    status: "timeout",
    issue: "config",
    responseTimeMs: 0,
    reason,
    action: "Tambahkan API key provider di .env atau Vercel env, lalu restart dev server/redeploy.",
    provider,
    modelName,
  }
}

async function checkSingleSource({
  provider,
  label,
  url,
  modelName,
  apiKey,
}: {
  provider: string
  label: string
  url: string
  modelName: string
  apiKey: string
}): Promise<ProviderStatus> {
  const startedAt = Date.now()
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)

  try {
    const response = await fetch(url, {
      method: "POST",
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
        "HTTP-Referer": env.nextAuthUrl || env.appUrl || "http://localhost:3000",
        "X-Title": "Swift AI Web Builder",
      },
      body: JSON.stringify({
        model: modelName,
        messages: [
          { role: "system", content: "Respond with one word." },
          { role: "user", content: "ping" },
        ],
        max_tokens: 1,
      }),
    })

    const elapsedMs = Date.now() - startedAt
    if (response.ok) {
      return {
        status: elapsedMs > 2_500 ? "slow" : "connected",
        issue: elapsedMs > 2_500 ? "latency" : "healthy",
        responseTimeMs: elapsedMs,
        reason: `${label} responded normally`,
        action: elapsedMs > 2_500 ? `${label} hidup tapi agak lambat. Generate tetap bisa dicoba.` : `${label} siap dipakai.`,
        provider,
        modelName,
      }
    }

    const rawText = await response.text()
    if (response.status === 402 || response.status === 429) {
      return {
        status: "slow",
        issue: "quota",
        responseTimeMs: elapsedMs,
        reason: `${label} returned ${response.status}: ${rawText}`,
        action: `Periksa credit/rate limit ${label}, atau biarkan Swift mencoba fallback berikutnya.`,
        provider,
        modelName,
      }
    }

    if (response.status === 401 || response.status === 403) {
      return {
        status: "timeout",
        issue: "auth",
        responseTimeMs: elapsedMs,
        reason: `${label} rejected authentication or model access: ${rawText}`,
        action: `Periksa API key ${label} dan akses model ${modelName}.`,
        provider,
        modelName,
      }
    }

    if (response.status === 404) {
      return {
        status: "timeout",
        issue: "config",
        responseTimeMs: elapsedMs,
        reason: `${label} model not available: ${rawText}`,
        action: `Pastikan model ${modelName} tersedia di ${label}.`,
        provider,
        modelName,
      }
    }

    return {
      status: "timeout",
      issue: "unknown",
      responseTimeMs: elapsedMs,
      reason: `${label} returned ${response.status}: ${rawText}`,
      action: `Periksa endpoint ${label} dan log server.`,
      provider,
      modelName,
    }
  } catch (error) {
    const elapsedMs = Date.now() - startedAt
    const isAbort = error instanceof Error && error.name === "AbortError"
    return {
      status: "timeout",
      issue: isAbort ? "latency" : "unknown",
      responseTimeMs: elapsedMs,
      reason: isAbort ? `${label} status check timed out` : `${label} status check failed`,
      action: isAbort ? `${label} sedang lambat. Swift akan mencoba fallback lain.` : `Periksa koneksi server ke ${label}.`,
      provider,
      modelName,
    }
  } finally {
    clearTimeout(timeout)
  }
}

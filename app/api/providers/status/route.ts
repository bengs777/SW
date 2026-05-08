import { NextRequest, NextResponse } from "next/server"
import { auth } from "@/auth"
import { ModelConfigService } from "@/lib/services/model-config.service"
import { assertOpenRouterReady, OPENROUTER_BASE_URL, OPENROUTER_MODEL_ID } from "@/lib/ai/openrouter-config"
import { env } from "@/lib/env"

type ProviderState = "connected" | "slow" | "timeout"
type ProviderIssue = "healthy" | "latency" | "auth" | "quota" | "config" | "unknown"

type CachedStatus = {
  status: ProviderState
  issue: ProviderIssue
  checkedAt: number
  responseTimeMs: number
  reason: string
  action: string
}

const REQUEST_TIMEOUT_MS = 10_000
const statusCache = new Map<string, CachedStatus>()

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
  const cacheKey = `openrouter:${OPENROUTER_MODEL_ID}`
  const cached = statusCache.get(cacheKey)

  if (!shouldRefresh && cached && now - cached.checkedAt < env.providerStatusCacheTtlMs) {
    return NextResponse.json({
      modelKey,
      status: cached.status,
      issue: cached.issue,
      checkedAt: new Date(cached.checkedAt).toISOString(),
      responseTimeMs: cached.responseTimeMs,
      reason: cached.reason,
      action: cached.action,
      cached: true,
    })
  }

  const status = await checkOpenRouterStatus()
  statusCache.set(cacheKey, {
    ...status,
    checkedAt: now,
  })

  return NextResponse.json({
    modelKey,
    status: status.status,
    issue: status.issue,
    checkedAt: new Date(now).toISOString(),
    responseTimeMs: status.responseTimeMs,
    reason: status.reason,
    action: status.action,
    cached: false,
  })
}

async function checkOpenRouterStatus() {
  const startedAt = Date.now()

  try {
    const config = assertOpenRouterReady()
    return checkSingleSource({
      url: `${OPENROUTER_BASE_URL}/chat/completions`,
      modelName: OPENROUTER_MODEL_ID,
      apiKey: config.apiKey,
    })
  } catch (error) {
    const elapsedMs = Date.now() - startedAt
    return {
      status: "timeout" as ProviderState,
      issue: "config" as ProviderIssue,
      responseTimeMs: elapsedMs,
      reason: error instanceof Error ? error.message : "OpenRouter configuration failed",
      action: "Tambahkan OPENROUTER_API_KEY di .env atau Vercel env, lalu restart dev server/redeploy.",
    }
  }
}

async function checkSingleSource({
  url,
  modelName,
  apiKey,
}: {
  url: string
  modelName: string
  apiKey: string
}) {
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
        status: elapsedMs > 2_500 ? ("slow" as ProviderState) : ("connected" as ProviderState),
        issue: elapsedMs > 2_500 ? ("latency" as ProviderIssue) : ("healthy" as ProviderIssue),
        responseTimeMs: elapsedMs,
        reason: "OpenRouter responded normally",
        action: elapsedMs > 2_500 ? "OpenRouter hidup tapi agak lambat. Generate tetap bisa dicoba." : "OpenRouter siap dipakai.",
      }
    }

    const rawText = await response.text()
    if (response.status === 402 || response.status === 429) {
      return {
        status: "slow" as ProviderState,
        issue: "quota" as ProviderIssue,
        responseTimeMs: elapsedMs,
        reason: `OpenRouter returned ${response.status}: ${rawText}`,
        action: "Periksa credit/rate limit OpenRouter atau turunkan OPENROUTER_MAX_TOKENS.",
      }
    }

    if (response.status === 401 || response.status === 403) {
      return {
        status: "timeout" as ProviderState,
        issue: "auth" as ProviderIssue,
        responseTimeMs: elapsedMs,
        reason: `OpenRouter rejected authentication or model access: ${rawText}`,
        action: "Periksa OPENROUTER_API_KEY dan akses model deepseek/deepseek-v4-flash.",
      }
    }

    if (response.status === 404) {
      return {
        status: "timeout" as ProviderState,
        issue: "config" as ProviderIssue,
        responseTimeMs: elapsedMs,
        reason: `OpenRouter model not available: ${rawText}`,
        action: "Pastikan model deepseek/deepseek-v4-flash tersedia di akun OpenRouter.",
      }
    }

    return {
      status: "timeout" as ProviderState,
      issue: "unknown" as ProviderIssue,
      responseTimeMs: elapsedMs,
      reason: `OpenRouter returned ${response.status}: ${rawText}`,
      action: "Periksa endpoint OpenRouter dan log server.",
    }
  } catch (error) {
    const elapsedMs = Date.now() - startedAt
    const isAbort = error instanceof Error && error.name === "AbortError"
    return {
      status: "timeout" as ProviderState,
      issue: isAbort ? ("latency" as ProviderIssue) : ("unknown" as ProviderIssue),
      responseTimeMs: elapsedMs,
      reason: isAbort ? "OpenRouter status check timed out" : "OpenRouter status check failed",
      action: isAbort ? "OpenRouter sedang lambat. Tunggu sebentar." : "Periksa koneksi server ke OpenRouter.",
    }
  } finally {
    clearTimeout(timeout)
  }
}

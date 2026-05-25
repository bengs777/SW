/* eslint-disable @typescript-eslint/no-explicit-any -- Validation script records provider lifecycle payloads from dynamic runtime imports. */
import fs from "node:fs"
import { mkdir, writeFile } from "node:fs/promises"
import path from "node:path"
import { getReportStoragePath } from "@/lib/runtime/report-storage"

const REPORT_ROOT = path.join(getReportStoragePath(), "provider-live-samples")
const SAMPLE_COUNT = Math.max(1, Number(process.env.SWIFT_PROVIDER_SAMPLE_COUNT || 5))
const SAMPLE_TIMEOUT_MS = Number(process.env.SWIFT_PROVIDER_SAMPLE_TIMEOUT_MS || 25_000)

function loadLocalEnv() {
  for (const file of [".env.local", ".env"]) {
    const filePath = path.join(process.cwd(), file)
    if (!fs.existsSync(filePath)) continue

    for (const line of fs.readFileSync(filePath, "utf8").split(/\r?\n/)) {
      const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)=(.*)\s*$/)
      if (!match) continue
      const [, key, rawValue] = match
      if (process.env[key]) continue
      process.env[key] = rawValue.replace(/^['"]|['"]$/g, "")
    }
  }
}

function rate(value: number, total: number) {
  return total === 0 ? 0 : Math.round((value / total) * 1000) / 10
}

async function main() {
  loadLocalEnv()
  process.env.AI_MAX_RETRIES = "0"
  process.env.SWIFT_PROVIDER_TIMEOUT_MS = String(SAMPLE_TIMEOUT_MS)
  process.env.AI_TIMEOUT_MS = String(SAMPLE_TIMEOUT_MS)

  const { ProviderRouter } = await import("@/lib/ai/provider-router")
  const { getProviderMetricsSnapshot } = await import("@/lib/ai/provider-metrics")
  const { DEFAULT_SWIFT_TIER_KEY, getActiveSwiftModelChain } = await import("@/lib/ai/swift-tiers")

  const runId = `provider-live-${new Date().toISOString().replace(/[:.]/g, "-")}`
  const reportDir = path.join(REPORT_ROOT, runId)
  await mkdir(reportDir, { recursive: true })

  const results = []
  for (let index = 0; index < SAMPLE_COUNT; index += 1) {
    const startedAt = Date.now()
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), SAMPLE_TIMEOUT_MS)
    const lifecycleLog: any[] = []
    try {
      const response = await ProviderRouter.generate({
        modelName: DEFAULT_SWIFT_TIER_KEY,
        mode: "chat",
        promptLanguage: "en",
        routingTask: "large_generation",
        temperatureOverride: 0,
        signal: controller.signal,
        lifecycle: (event: any) => {
          lifecycleLog.push(event)
        },
        prompt: [
          `Provider live sample ${index + 1}/${SAMPLE_COUNT}.`,
          `Run id: ${runId}.`,
          "Reply with one compact sentence confirming Swift AI provider generation is working.",
        ].join("\n"),
      })
      results.push({
        index: index + 1,
        status: "success",
        durationMs: Date.now() - startedAt,
        usedFallback: response.usedFallback,
        attempts: response.attempts,
        lifecycleLog,
        lifecycle: lifecycleLog.map((event) => event.event),
        tokenReceivedCount: lifecycleLog.filter((event) => event.event === "token_received").length,
        chunkReceivedCount: lifecycleLog.filter((event) => event.event === "chunk_received").length,
        tokenUsage: response.tokenUsage || null,
      })
    } catch (error) {
      results.push({
        index: index + 1,
        status: "failure",
        durationMs: Date.now() - startedAt,
        lifecycleLog,
        lifecycle: lifecycleLog.map((event) => event.event),
        tokenReceivedCount: lifecycleLog.filter((event) => event.event === "token_received").length,
        chunkReceivedCount: lifecycleLog.filter((event) => event.event === "chunk_received").length,
        error: error instanceof Error ? error.message : String(error),
      })
    } finally {
      clearTimeout(timeout)
    }
  }

  const successes = results.filter((item) => item.status === "success").length
  const providerFailoverCount = results.reduce((count, item: any) => {
    const attempts = Array.isArray(item.attempts) ? item.attempts : []
    const attemptedModels = new Set(
      attempts
        .filter((attempt: any) => attempt.provider === "openrouter")
        .map((attempt: any) => attempt.modelName)
        .filter(Boolean)
    )
    return count + Math.max(0, attemptedModels.size - 1)
  }, 0)
  const tokenReceivedCount = results.reduce((count, item: any) => count + Number(item.tokenReceivedCount || 0), 0)
  const streamClosedCount = results.reduce((count, item: any) => {
    const lifecycle = Array.isArray(item.lifecycle) ? item.lifecycle : []
    return count + lifecycle.filter((event: string) => event === "stream_closed").length
  }, 0)
  const readinessScore = Math.round(
    (rate(successes, SAMPLE_COUNT) >= 80 ? 55 : rate(successes, SAMPLE_COUNT) * 0.55) +
      (tokenReceivedCount >= successes ? 25 : 0) +
      (streamClosedCount >= successes ? 10 : 0) +
      (results.every((item: any) => Array.isArray(item.lifecycle) && item.lifecycle.includes("request_stream_started")) ? 10 : 0)
  )
  const summary = {
    runId,
    sampleCount: SAMPLE_COUNT,
    successes,
    failures: SAMPLE_COUNT - successes,
    liveSuccessRate: rate(successes, SAMPLE_COUNT),
    generationSuccessRate: rate(successes, SAMPLE_COUNT),
    tokenReceivedCount,
    providerFailoverCount,
    readinessScore,
    providerChain: getActiveSwiftModelChain(),
    providerMetrics: getProviderMetricsSnapshot(),
    results,
  }

  await writeFile(path.join(reportDir, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`, "utf8")
  await writeFile(path.join(REPORT_ROOT, "latest.json"), `${JSON.stringify(summary, null, 2)}\n`, "utf8")
  console.log(JSON.stringify(summary, null, 2))

  if (summary.generationSuccessRate <= 50) {
    process.exit(2)
  }
  process.exit(0)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})

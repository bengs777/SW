import fs from "node:fs"
import { mkdir, writeFile } from "node:fs/promises"
import path from "node:path"

const REPORT_ROOT = path.join(process.cwd(), ".swift-reports", "provider-live-samples")
const SAMPLE_COUNT = 10
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
    try {
      const response = await ProviderRouter.generate({
        modelName: DEFAULT_SWIFT_TIER_KEY,
        mode: "chat",
        promptLanguage: "en",
        routingTask: "large_generation",
        temperatureOverride: 0,
        signal: controller.signal,
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
        tokenUsage: response.tokenUsage || null,
      })
    } catch (error) {
      results.push({
        index: index + 1,
        status: "failure",
        durationMs: Date.now() - startedAt,
        error: error instanceof Error ? error.message : String(error),
      })
    } finally {
      clearTimeout(timeout)
    }
  }

  const successes = results.filter((item) => item.status === "success").length
  const summary = {
    runId,
    sampleCount: SAMPLE_COUNT,
    successes,
    failures: SAMPLE_COUNT - successes,
    generationSuccessRate: rate(successes, SAMPLE_COUNT),
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

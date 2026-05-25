import fs from "node:fs"
import os from "node:os"
import { mkdir, writeFile } from "node:fs/promises"
import path from "node:path"
import { getReportStoragePath } from "@/lib/runtime/report-storage"

const REPORT_ROOT = path.join(getReportStoragePath(), "production-load")
const CONCURRENCY_LEVELS = [10, 25, 50, 100]
const PROVIDER_TIMEOUT_MS = Number(process.env.SWIFT_LOAD_PROVIDER_TIMEOUT_MS || 15_000)

function loadLocalEnv() {
  for (const file of [".env.local", ".env.production", ".env"]) {
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

function percentile(values: number[], pct: number) {
  if (values.length === 0) return 0
  const sorted = [...values].sort((left, right) => left - right)
  const index = Math.min(sorted.length - 1, Math.ceil((pct / 100) * sorted.length) - 1)
  return sorted[index]
}

function average(values: number[]) {
  if (values.length === 0) return 0
  return Math.round(values.reduce((sum, value) => sum + value, 0) / values.length)
}

function memoryMb() {
  return Math.round(process.memoryUsage().rss / 1024 / 1024)
}

async function main() {
  loadLocalEnv()
  process.env.AI_MAX_RETRIES = process.env.AI_MAX_RETRIES || "0"

  const { prisma } = await import("@/lib/db/client")
  const { getGenerationQueueHealth } = await import("@/lib/queue/generation-queue")
  const { ProviderRouter } = await import("@/lib/ai/provider-router")
  const { DEFAULT_SWIFT_TIER_KEY, getSwiftModelTargets, getActiveSwiftModelChain } = await import("@/lib/ai/swift-tiers")
  const { getProviderMetricsSnapshot } = await import("@/lib/ai/provider-metrics")
  const { getProviderCircuitState } = await import("@/lib/ai/provider-circuit-breaker")
  const { getDatabaseMetricsSnapshot } = await import("@/lib/db/metrics")
  const { getDatabaseCircuitState } = await import("@/lib/db/circuit-breaker")
  const { getProductionReadiness } = await import("@/lib/production/readiness")
  const { startGenerationWorker } = await import("@/lib/workers/generation-worker")

  const runId = `production-load-${new Date().toISOString().replace(/[:.]/g, "-")}`
  const reportDir = path.join(REPORT_ROOT, runId)
  await mkdir(reportDir, { recursive: true })

  const model = getSwiftModelTargets("large_generation")[0]?.modelId
  if (!model) throw new Error("No provider model available for load validation")
  const loadWorker = process.env.SWIFT_LOAD_START_WORKER === "false" ? null : startGenerationWorker()
  if (loadWorker) {
    await new Promise((resolve) => setTimeout(resolve, 1_500))
  }

  const levels = []
  for (const concurrency of CONCURRENCY_LEVELS) {
    const cpuStart = process.cpuUsage()
    const wallStart = Date.now()
    const memoryStartMb = memoryMb()
    const beforeQueue = await getGenerationQueueHealth().catch(() => null)

    const settled = await Promise.allSettled(
      Array.from({ length: concurrency }, async (_item, index) => {
        const startedAt = Date.now()
        const dbStartedAt = Date.now()
        await prisma.$queryRaw`SELECT 1`
        const dbLatencyMs = Date.now() - dbStartedAt

        const queueStartedAt = Date.now()
        const queue = await getGenerationQueueHealth()
        const queueLatencyMs = Date.now() - queueStartedAt
        const queueDelay = Number(queue.counts?.waiting || 0) + Number(queue.counts?.delayed || 0)

        const providerStartedAt = Date.now()
        const controller = new AbortController()
        const providerTimeout = setTimeout(() => controller.abort(), PROVIDER_TIMEOUT_MS)
        await ProviderRouter.generate({
          modelName: DEFAULT_SWIFT_TIER_KEY,
          mode: "chat",
          promptLanguage: "en",
          routingTask: "large_generation",
          temperatureOverride: 0,
          signal: controller.signal,
          prompt: [
            `Production load probe ${runId}.`,
            `Concurrency ${concurrency}, user ${index}.`,
            "Reply with exactly: OK",
          ].join("\n"),
        })
        clearTimeout(providerTimeout)
        const providerLatencyMs = Date.now() - providerStartedAt

        return {
          latencyMs: Date.now() - startedAt,
          dbLatencyMs,
          queueLatencyMs,
          queueDelay,
          providerLatencyMs,
          workerStatus: queue.status,
          redisStatus: queue.redis.status,
          memoryMb: memoryMb(),
        }
      })
    )

    const durationMs = Date.now() - wallStart
    const cpuDelta = process.cpuUsage(cpuStart)
    const cpuMs = (cpuDelta.user + cpuDelta.system) / 1000
    const cpuUsagePct = Math.round((cpuMs / Math.max(1, durationMs) / Math.max(1, os.cpus().length)) * 1000) / 10
    type LoadSample = {
      latencyMs: number
      dbLatencyMs: number
      queueLatencyMs: number
      queueDelay: number
      providerLatencyMs: number
      workerStatus: string
      redisStatus: string
      memoryMb: number
    }
    const fulfilled: LoadSample[] = []
    for (const item of settled) {
      if (item.status === "fulfilled") {
        fulfilled.push(item.value)
      }
    }
    const rejected = settled.filter((item) => item.status === "rejected") as PromiseRejectedResult[]
    const afterQueue = await getGenerationQueueHealth().catch(() => null)

    levels.push({
      concurrency,
      requests: concurrency,
      successes: fulfilled.length,
      failures: rejected.length,
      errorRate: Math.round((rejected.length / concurrency) * 1000) / 10,
      averageLatencyMs: average(fulfilled.map((item) => item.latencyMs)),
      p95LatencyMs: percentile(fulfilled.map((item) => item.latencyMs), 95),
      queueDelay: {
        average: average(fulfilled.map((item) => item.queueDelay)),
        beforeWaiting: beforeQueue?.counts?.waiting || 0,
        afterWaiting: afterQueue?.counts?.waiting || 0,
        beforeActive: beforeQueue?.counts?.active || 0,
        afterActive: afterQueue?.counts?.active || 0,
      },
      redis: {
        averageLatencyMs: average(fulfilled.map((item) => item.queueLatencyMs)),
        status: afterQueue?.redis.status || "unknown",
        memory: afterQueue?.redis.memory || null,
      },
      database: {
        averageLatencyMs: average(fulfilled.map((item) => item.dbLatencyMs)),
        p95LatencyMs: percentile(fulfilled.map((item) => item.dbLatencyMs), 95),
      },
      provider: {
        model,
        averageLatencyMs: average(fulfilled.map((item) => item.providerLatencyMs)),
        p95LatencyMs: percentile(fulfilled.map((item) => item.providerLatencyMs), 95),
      },
      worker: {
        status: afterQueue?.status || "unknown",
        heartbeatAgeMs: afterQueue?.workerHeartbeat?.ageMs ?? null,
        stable: afterQueue?.status === "healthy" || afterQueue?.status === "degraded",
      },
      resources: {
        memoryStartMb,
        memoryEndMb: memoryMb(),
        memoryPeakMb: Math.max(memoryStartMb, ...fulfilled.map((item) => item.memoryMb)),
        cpuUsagePct,
      },
      errors: rejected.slice(0, 5).map((item) => item.reason instanceof Error ? item.reason.message : String(item.reason)),
    })
  }

  const maxErrorRate = Math.max(...levels.map((item) => item.errorRate))
  const maxP95 = Math.max(...levels.map((item) => item.p95LatencyMs))
  const generationSuccessRate = Math.round(
    (levels.reduce((sum, item) => sum + item.successes, 0) /
      Math.max(1, levels.reduce((sum, item) => sum + item.requests, 0))) * 1000
  ) / 10
  const workerStable = levels.every((item) => item.worker.stable)
  const queueStable = levels.every((item) => item.redis.status !== "unavailable")
  const targetPass = maxErrorRate < 2 && maxP95 < 15_000 && generationSuccessRate > 90 && workerStable && queueStable
  const readiness = getProductionReadiness()
  const productionReadinessScore = Math.max(
    0,
    Math.min(
      100,
      Math.round(
        (targetPass ? 60 : 30) +
          (readiness.ok ? 20 : 0) +
          (workerStable ? 10 : 0) +
          (queueStable ? 10 : 0) -
          readiness.blockingFailures.length * 5
      )
    )
  )

  const summary = {
    runId,
    providerChain: getActiveSwiftModelChain(),
    providerMetrics: getProviderMetricsSnapshot(),
    circuitBreaker: getProviderCircuitState("openrouter"),
    databaseMetrics: getDatabaseMetricsSnapshot(),
    databaseCircuitBreaker: getDatabaseCircuitState(),
    generationSuccessRate,
    targets: {
      errorRateLtPct: 2,
      p95LatencyLtMs: 15_000,
      generationSuccessRateGtPct: 90,
      workerStable: true,
      queueStable: true,
    },
    targetPass,
    productionReadinessScore,
    bottleneck:
      maxP95 >= 15_000
        ? "provider_latency"
        : maxErrorRate >= 2
          ? "request_errors"
          : !workerStable
            ? "worker_health"
            : !queueStable
              ? "queue_or_redis"
              : "none",
    levels,
  }

  await writeFile(path.join(reportDir, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`, "utf8")
  await writeFile(path.join(REPORT_ROOT, "latest.json"), `${JSON.stringify(summary, null, 2)}\n`, "utf8")
  console.log(JSON.stringify(summary, null, 2))
  await loadWorker?.close().catch(() => null)
  await prisma.$disconnect()
  process.exit(targetPass ? 0 : 2)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})

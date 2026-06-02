// Main worker entry point
// Usage: node scripts/run-ts-script.js workers/index.ts --type=generation|repair|sandbox
// Or set SWIFT_WORKER_TYPE environment variable
/* eslint-disable @typescript-eslint/no-require-imports */

import http from "node:http"
import { cleanupReportStorage, getReportRetentionPolicy, getReportStoragePath } from "@/lib/runtime/report-storage"

const WORKER_TYPES = ["generation", "repair", "sandbox"] as const
type SwiftWorkerType = (typeof WORKER_TYPES)[number]

type WorkerRuntimeState = {
  workerType: SwiftWorkerType
  startedAt: string
  healthy: boolean
  ready: boolean
  error: string | null
}

const runtimeState: WorkerRuntimeState = {
  workerType: "generation",
  startedAt: new Date().toISOString(),
  healthy: false,
  ready: false,
  error: null,
}

function markRuntimeReady() {
  runtimeState.ready = true
  runtimeState.healthy = true
  runtimeState.error = null
}

// Parse command line arguments
function parseArgs(): SwiftWorkerType | undefined {
  const args = process.argv.slice(2)
  const typeArg = args.find((arg) => arg.startsWith("--type="))
  const type = typeArg ? (typeArg.split("=")[1] as SwiftWorkerType) : undefined

  if (type && !WORKER_TYPES.includes(type)) {
    console.error(`[Worker] Invalid worker type: ${type}`)
    console.error(`[Worker] Valid types: ${WORKER_TYPES.join(", ")}`)
    process.exit(1)
  }

  return type
}

// Load environment without depending on dotenv at runtime.
try {
  const { loadEnvConfig } = require("@next/env")
  loadEnvConfig(process.cwd())
} catch (error) {
  console.warn("[Worker] Failed to load .env via @next/env", error instanceof Error ? error.message : String(error))
}

function assertRuntimeDatabaseSchema() {
  if (process.env.SWIFT_SKIP_SCHEMA_GUARD === "true") {
    console.warn("[Worker] SWIFT_SKIP_SCHEMA_GUARD=true; database schema compatibility guard skipped")
    return
  }

  const { execFileSync } = require("node:child_process")
  execFileSync(process.execPath, ["scripts/schema-health-check.js"], { stdio: "inherit" })
}

async function startWorker(workerType: SwiftWorkerType) {
  console.log(`[Worker] Starting ${workerType} worker...`)
  console.log(
    '[report-storage]',
    getReportStoragePath(),
    getReportRetentionPolicy()
  )
  cleanupReportStorage()
    .then((result) => {
      if (result.removed > 0 || result.errors.length > 0) {
        console.log("[report-storage:cleanup]", result)
      }
    })
    .catch((error) => {
      console.warn("[report-storage:cleanup] failed", error instanceof Error ? error.message : String(error))
    })
  runtimeState.workerType = workerType
  assertRuntimeDatabaseSchema()

  // Setup shutdown handlers
  const { setupShutdownHandlers, registerWorker } = require("./graceful-shutdown")
  setupShutdownHandlers()

  switch (workerType) {
    case "generation": {
      const { createGenerationWorker } = require("./generation-worker")
      const worker = createGenerationWorker()
      registerWorker(worker)
      markRuntimeReady()
      worker.on("ready", markRuntimeReady)
      worker.on("error", (error: Error) => {
        runtimeState.healthy = false
        runtimeState.error = error.message
      })
      worker.on("closed", () => {
        runtimeState.ready = false
        runtimeState.healthy = false
      })
      console.log("[GenerationWorker] Listening for generation jobs")
      break
    }
    case "repair": {
      const { createRepairWorker } = require("./repair-worker")
      const worker = createRepairWorker()
      registerWorker(worker)
      console.log("[RepairWorker] Listening for repair jobs")
      break
    }
    case "sandbox": {
      const { createSandboxWorker } = require("./sandbox-worker")
      const worker = createSandboxWorker()
      registerWorker(worker)
      console.log("[SandboxWorker] Listening for sandbox jobs")
      break
    }
  }
}

function startHealthServer() {
  const rawPort = process.env.SWIFT_WORKER_HEALTH_PORT || process.env.PORT
  const port = rawPort ? Number(rawPort) : 0
  if (!Number.isFinite(port) || port <= 0) {
    return
  }

  const server = http.createServer(async (request, response) => {
    const url = request.url || "/"
    if (url !== "/health" && url !== "/api/worker/health") {
      response.writeHead(404, { "content-type": "application/json" })
      response.end(JSON.stringify({ ok: false, error: "not_found" }))
      return
    }

    let queueHealth: unknown = null
    try {
      const { getGenerationQueueHealth } = require("../lib/queue/generation-queue")
      queueHealth = await getGenerationQueueHealth()
    } catch (error) {
      queueHealth = {
        status: "unhealthy",
        error: error instanceof Error ? error.message : String(error),
      }
    }

    const status = runtimeState.healthy ? 200 : 503
    response.writeHead(status, {
      "cache-control": "no-store",
      "content-type": "application/json",
    })
    response.end(JSON.stringify({
      status: runtimeState.healthy ? "healthy" : "unhealthy",
      mode: "queue",
      worker: runtimeState,
      queue: queueHealth,
      checkedAt: new Date().toISOString(),
    }))
  })

  server.listen(port, "0.0.0.0", () => {
    console.log(`[Worker] Health endpoint listening on :${port}/health`)
  })
}

async function main() {
  const workerType = parseArgs() ?? (process.env.SWIFT_WORKER_TYPE as SwiftWorkerType) ?? "generation"
  startHealthServer()
  await startWorker(workerType)
}

main().catch((err) => {
  console.error("[Worker] Fatal error:", err)
  process.exit(1)
})

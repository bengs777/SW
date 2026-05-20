// Main worker entry point
// Usage: node workers/index.js --type=generation|repair|sandbox
// Or set SWIFT_WORKER_TYPE environment variable
/* eslint-disable @typescript-eslint/no-require-imports */

const WORKER_TYPES = ["generation", "repair", "sandbox"] as const
type SwiftWorkerType = (typeof WORKER_TYPES)[number]

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

// Load environment
require("dotenv").config()

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
  assertRuntimeDatabaseSchema()

  // Setup shutdown handlers
  const { setupShutdownHandlers, registerWorker } = require("./graceful-shutdown")
  setupShutdownHandlers()

  switch (workerType) {
    case "generation": {
      const { createGenerationWorker } = require("./generation-worker")
      const worker = createGenerationWorker()
      registerWorker(worker)
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

async function main() {
  const workerType = parseArgs() ?? (process.env.SWIFT_WORKER_TYPE as SwiftWorkerType) ?? "generation"
  await startWorker(workerType)
}

main().catch((err) => {
  console.error("[Worker] Fatal error:", err)
  process.exit(1)
})

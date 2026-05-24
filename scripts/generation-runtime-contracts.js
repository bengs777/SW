const fs = require("node:fs")
const path = require("node:path")

const root = process.cwd()

function read(file) {
  return fs.readFileSync(path.join(root, file), "utf8")
}

function assert(name, pass, detail) {
  if (!pass) {
    const error = new Error(`${name}: ${detail}`)
    error.name = "GenerationRuntimeContractError"
    throw error
  }
  console.log(`PASS ${name} - ${detail}`)
}

function main() {
  const packageJson = JSON.parse(read("package.json"))
  const workerEntry = read("workers/index.ts")
  const workerDockerfile = read("workers/Dockerfile")
  const workerHealthRoute = read("app/api/worker/health/route.ts")
  const generationQueue = read("lib/queue/generation-queue.ts")
  const generationWorker = read("lib/workers/generation-worker.ts")
  const generationPipeline = read("lib/ai/generation-pipeline.ts")
  const importGraph = read("lib/ai/import-graph.ts")
  const orchestrator = read("lib/services/generation-orchestrator.service.ts")
  const qualityService = read("lib/services/generation-quality.service.ts")
  const schema = read("prisma/schema.prisma")

  assert(
    "worker.standalone-script",
    packageJson.scripts["worker:generation"] === "node scripts/run-ts-script.js workers/index.ts --type=generation",
    "dedicated worker starts without next start"
  )

  assert(
    "worker.docker-standalone",
    /CMD \["npm", "run", "worker:generation"\]/.test(workerDockerfile) &&
      /SWIFT_GENERATION_EXECUTION_MODE=queue/.test(workerDockerfile),
    "worker image runs queue mode standalone"
  )

  assert(
    "worker.health-server",
    /http\.createServer/.test(workerEntry) &&
      /\/api\/worker\/health/.test(workerEntry) &&
      /mode:\s*"queue"/.test(workerEntry),
    "standalone worker exposes process health"
  )

  assert(
    "worker.health-route",
    /getGenerationQueueHealth/.test(workerHealthRoute) &&
      /deadLetter/.test(workerHealthRoute) &&
      /heartbeat/.test(workerHealthRoute) &&
      /mode:\s*"queue"/.test(workerHealthRoute),
    "app health endpoint reports queue, heartbeat, and DLQ status"
  )

  assert(
    "queue.dead-letter",
    /DEAD_LETTER_QUEUE_NAME/.test(generationQueue) &&
      /moveGenerationJobToDeadLetter/.test(generationQueue) &&
      /replayGenerationDeadLetterJob/.test(generationQueue) &&
      /getGenerationDeadLetterQueue/.test(generationQueue),
    "generation DLQ supports write and replay"
  )

  assert(
    "worker.heartbeat",
    /recordGenerationWorkerHeartbeat/.test(generationQueue) &&
      /GENERATION_WORKER_HEARTBEAT_KEY/.test(generationQueue) &&
      /recordGenerationWorkerHeartbeat\(workerId/.test(generationWorker),
    "worker heartbeat is recorded by the dedicated worker"
  )

  assert(
    "dependency.graph",
    /export function buildImportGraph/.test(importGraph) &&
      /importedBy/.test(importGraph) &&
      /getTransitiveImpactPaths/.test(importGraph) &&
      /buildDependencyMap/.test(generationPipeline),
    "dependency graph tracks imports, importers, and impact paths"
  )

  assert(
    "context.budget",
    /export type ContextBudget/.test(generationPipeline) &&
      /DEFAULT_CONTEXT_BUDGETS/.test(generationPipeline) &&
      /trimContextForGeneration/.test(generationPipeline) &&
      /contextBudget/.test(orchestrator),
    "context budget trims generation context and is persisted into orchestration plan"
  )

  assert(
    "generation.metrics",
    /model GenerationQualityMetric/.test(schema) &&
      /generationSuccessRate/.test(qualityService) &&
      /GenerationQualityService\.recordSummary/.test(orchestrator) &&
      /buildPassed/.test(qualityService) &&
      /runtimePassed/.test(qualityService),
    "generation metrics persist success, build, runtime, repair, latency, and cost"
  )

  console.log("\n[generation-runtime-contracts] passed")
}

try {
  main()
} catch (error) {
  console.error("\n[generation-runtime-contracts] failed")
  console.error(error)
  process.exit(1)
}

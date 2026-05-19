const fs = require("node:fs")
const path = require("node:path")

const root = process.cwd()

function read(file) {
  return fs.readFileSync(path.join(root, file), "utf8")
}

function assert(name, pass, detail) {
  if (!pass) {
    const error = new Error(`${name}: ${detail}`)
    error.name = "HardeningRegressionError"
    throw error
  }
  console.log(`PASS ${name} - ${detail}`)
}

function main() {
  const packageJson = JSON.parse(read("package.json"))
  const filesystemService = read("lib/services/project-filesystem.service.ts")
  const persistenceService = read("lib/services/project-file-persistence.service.ts")
  const orchestrator = read("lib/services/generation-orchestrator.service.ts")
  const projectApi = read("app/api/projects/[id]/route.ts")
  const projectPage = read("app/dashboard/project/[id]/page.tsx")
  const artifactParser = read("lib/ai/generated-artifact.ts")
  const taskGraphExecutor = read("lib/ai/task-graph-executor.ts")
  const filePolicy = read("lib/ai/file-policy.ts")
  const canonicalPath = read("lib/ai/canonical-path.ts")
  const generationPipeline = read("lib/ai/generation-pipeline.ts")
  const adminMonitoring = read("lib/services/admin-monitoring.service.ts")
  const systemPage = read("app/dashboard/system/page.tsx")
  const schema = read("prisma/schema.prisma")
  const runtimeService = read("lib/services/orchestration-runtime.service.ts")
  const generationWorker = read("lib/workers/generation-worker.ts")
  const sandboxRuntime = read("lib/sandbox/runtime.ts")
  const metricsRoute = read("app/api/metrics/route.ts")

  assert(
    "script.registered",
    packageJson.scripts && packageJson.scripts["test:hardening"] === "node scripts/pipeline-hardening-regression.js",
    "package.json exposes npm run test:hardening"
  )

  assert(
    "filesystem.canonical-service",
    /class ProjectFilesystemService/.test(filesystemService) &&
      /readFiles\(/.test(filesystemService) &&
      /writeBatch\(/.test(filesystemService) &&
      /replaceFiles\(/.test(filesystemService) &&
      /verify\(/.test(filesystemService),
    "ProjectFilesystemService owns read/write/verify"
  )

  assert(
    "manifest.content-hash",
    /contentHash\s*=\s*createHash\("sha256"\)\.update\(content\)/.test(filesystemService) &&
      /fileHashes\[file\.path\]\s*=\s*fileHash/.test(filesystemService) &&
      /hash\.update\(fileHash\)/.test(filesystemService),
    "manifest hashes file content hashes, not metadata only"
  )

  assert(
    "manifest.stable-order",
    /sort\(\(left,\s*right\)\s*=>\s*left\.path\.localeCompare\(right\.path\)\)/.test(filesystemService),
    "manifest input is sorted by path before hashing"
  )

  assert(
    "explorer.api-source-of-truth",
    /ProjectFilesystemService\.readFiles\(id\)/.test(projectApi) &&
      /fileState:\s*\{[\s\S]*manifest/.test(projectApi),
    "project API reads canonical filesystem and returns manifest"
  )

  assert(
    "sse.refresh-only",
    /source !== "persisted"/.test(projectPage) &&
      /refreshProjectState\("filesystem-persisted"\)/.test(projectPage) &&
      !/setGeneratedFiles\(\(currentFiles\)[\s\S]*streamed_files_applied/.test(projectPage),
    "Explorer ignores streamed file payloads and refreshes API after persisted event"
  )

  assert(
    "path.allowed-roots",
    /ALLOWED_GENERATED_ROOTS\s*=\s*\["src",\s*"app",\s*"components",\s*"lib",\s*"prisma"\]/.test(filePolicy) &&
      /canonicalizeGeneratedPath/.test(canonicalPath) &&
      /normalizeGeneratedPath/.test(filePolicy) &&
      /resolveGeneratedPath/.test(filePolicy) &&
      /validateGeneratedPath/.test(filesystemService) &&
      /validateGeneratedPath/.test(taskGraphExecutor) &&
      /Path must start with an allowed generated root/.test(filePolicy),
    "filesystem and executor reject paths outside strict generated roots"
  )

  assert(
    "taskgraph.semantic-collapse",
    /function collapseOperations/.test(taskGraphExecutor) &&
      /createdPaths\.has\(path\)\s*\|\|\s*previous\?\.action === "create"/.test(taskGraphExecutor) &&
      /\?\s*"create"\s*:\s*operation\.action/.test(taskGraphExecutor),
    "create+modify collapses to create(finalContent)"
  )

  assert(
    "dependency.allowlist",
    /export const PACKAGE_VERSION_ALLOWLIST/.test(generationPipeline) &&
      /PACKAGE_VERSION_ALLOWLIST\[parsed\.name\]/.test(taskGraphExecutor) &&
      /Dependency is not allowed by Swift policy/.test(taskGraphExecutor) &&
      !/parsed\.version\s*\|\|\s*"latest"/.test(taskGraphExecutor),
    "TaskGraph dependency installer uses allowlist versions only"
  )

  assert(
    "resource.limits",
    /MAX_OPERATIONS\s*=\s*100/.test(taskGraphExecutor) &&
      /MAX_TOTAL_BYTES\s*=\s*5\s*\*\s*1024\s*\*\s*1024/.test(taskGraphExecutor) &&
      /MAX_FILE_BYTES\s*=\s*200\s*\*\s*1024/.test(taskGraphExecutor) &&
      /MAX_PROJECT_FILES\s*=\s*100/.test(filesystemService) &&
      /MAX_SINGLE_FILE_BYTES\s*=\s*200\s*\*\s*1024/.test(artifactParser),
    "parser, executor, and filesystem enforce operation/file/byte limits"
  )

  assert(
    "stale-generation.guard",
    /pg_advisory_xact_lock\(hashtext/.test(persistenceService) &&
      /assertLatestProjectGeneration/.test(persistenceService) &&
      /createdAt:\s*\{\s*gt:\s*currentJob\.createdAt\s*\}/.test(persistenceService) &&
      /StaleGenerationRejected/.test(persistenceService) &&
      /generationJobId:\s*input\.jobId/.test(orchestrator),
    "persistence rejects older jobs when newer project generation exists"
  )

  assert(
    "json.strict-schema",
    /generatedArtifactSchema/.test(artifactParser) &&
      /\.strict\(\)/.test(artifactParser) &&
      /runtimeCommandSchema/.test(artifactParser) &&
      /runtime commands are metadata only and are not accepted as executable artifacts/.test(artifactParser) &&
      /strict-json-schema-required/.test(artifactParser) &&
      !/extractJsonFragments/.test(artifactParser),
    "AI JSON parser rejects freeform text, executable command intents, and schema drift"
  )

  assert(
    "alerts.threshold-constants",
    /const ALERT_THRESHOLDS\s*=\s*\{[\s\S]*workerHeartbeatStaleMs:\s*90_000[\s\S]*queueFailedJobsWarning:\s*1[\s\S]*deadLetterWaitingWarning:\s*1[\s\S]*databaseLatencyWarningMs:\s*1000[\s\S]*apiLatencyWarningMs:\s*2000[\s\S]*queueLatencyWarningMs:\s*1000[\s\S]*generationFailureRateWarningPct:\s*10/.test(adminMonitoring),
    "monitoring alert thresholds are centralized"
  )

  assert(
    "alerts.helper-isolated",
    /export function buildMonitoringAlerts\(metrics: MonitoringAlertMetrics\)/.test(adminMonitoring) &&
      /buildMonitoringAlerts\(\{[\s\S]*databaseLatencyMs[\s\S]*apiLatencyMs[\s\S]*queueLatencyMs/.test(adminMonitoring),
    "alert logic is separated from DB and Redis fetches"
  )

  assert(
    "alerts.latency-and-deadletter",
    /type:\s*"database_latency_high"[\s\S]*severity:\s*"warning"/.test(adminMonitoring) &&
      /type:\s*"api_latency_high"[\s\S]*severity:\s*"warning"/.test(adminMonitoring) &&
      /type:\s*"queue_latency_high"[\s\S]*severity:\s*"warning"/.test(adminMonitoring) &&
      /type:\s*"dead_letter_jobs"[\s\S]*ALERT_THRESHOLDS\.deadLetterWaitingWarning/.test(adminMonitoring),
    "DB/API/queue latency and dead-letter thresholds produce warning alerts"
  )

  assert(
    "alerts.failure-rate-denominator",
    /countMetric\(metrics\.queueCounts\.completed\)\s*\+\s*failedJobs\s*\+\s*countMetric\(metrics\.queueCounts\.active\)\s*\+\s*countMetric\(metrics\.queueCounts\.waiting\)/.test(adminMonitoring) &&
      !/failed\s*\|\|\s*0\)\s*\/\s*generation\.latency\.sampleCount/.test(systemPage) &&
      /const totalJobs\s*=[\s\S]*queueCounts\.completed[\s\S]*queueCounts\.failed[\s\S]*queueCounts\.active[\s\S]*queueCounts\.waiting/.test(systemPage),
    "failure rate uses completed + failed + active + waiting jobs, not sampleCount"
  )

  assert(
    "alerts.severity",
    /type:\s*"worker_heartbeat_stale"[\s\S]*severity:\s*"critical"/.test(adminMonitoring) &&
      /type:\s*"generation_failure_rate_high"[\s\S]*severity:\s*"warning"/.test(adminMonitoring),
    "worker heartbeat is critical and generation failure rate is warning"
  )

  assert(
    "orchestration.durable-schema",
    /model RepairAttempt/.test(schema) &&
      /model PreviewSession/.test(schema) &&
      /model WorkerHeartbeat/.test(schema) &&
      /model OrchestrationFailure/.test(schema) &&
      /orchestrationState/.test(schema) &&
      /leaseOwner/.test(schema) &&
      /terminationReason/.test(schema),
    "durable orchestration state, repair history, preview sessions, worker leases, and failures are persisted"
  )

  assert(
    "orchestration.lease-recovery",
    /acquireLease/.test(runtimeService) &&
      /renewLease/.test(runtimeService) &&
      /releaseLease/.test(runtimeService) &&
      /recoverOrphanedJobs/.test(runtimeService) &&
      /duplicate_job_execution_prevented/.test(generationWorker),
    "worker lease ownership prevents duplicate execution and supports orphan recovery"
  )

  assert(
    "orchestration.replay-metrics-cleanup",
    /static async replay/.test(runtimeService) &&
      /prometheusMetrics/.test(runtimeService) &&
      /cleanupExpiredLifecycle/.test(runtimeService) &&
      /Content-Type"[\s\S]*text\/plain; version=0\.0\.4/.test(metricsRoute),
    "orchestration replay, cleanup, and Prometheus metrics are implemented"
  )

  assert(
    "sandbox.ttl-cleanup",
    /cleanupExpiredRuntimeSandboxes/.test(sandboxRuntime) &&
      /preview_terminated: ttl cleanup/.test(sandboxRuntime) &&
      /SWIFT_PREVIEW_TTL_MS/.test(sandboxRuntime),
    "runtime sandboxes have TTL cleanup and zombie process termination"
  )

  console.log("\n[hardening] pipeline hardening regression checks passed")
}

try {
  main()
} catch (error) {
  console.error("\n[hardening] pipeline hardening regression checks failed")
  console.error(error)
  process.exit(1)
}

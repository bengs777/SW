import fs from "node:fs"
import path from "node:path"
import assert from "node:assert/strict"
import {
  MAX_JOB_RECOVERY_ATTEMPTS,
  buildDurableOrchestrationSnapshot,
  classifyRetryReason,
} from "@/lib/services/orchestration-runtime.service"

const root = process.cwd()
const read = (file: string) => fs.readFileSync(path.join(root, file), "utf8")

const runtime = read("lib/services/orchestration-runtime.service.ts")
const worker = read("lib/workers/generation-worker.ts")
const queue = read("lib/queue/generation-queue.ts")
const statusRoute = read("app/api/generate/jobs/[jobId]/status/route.ts")

function includes(source: string, pattern: RegExp, message: string) {
  assert.match(source, pattern, message)
}

const first = buildDurableOrchestrationSnapshot({
  jobId: "job_1",
  orchestrationState: "running",
  currentPhase: "validating",
  phaseDurations: { planning: 10, validating: 20 },
  replayHash: "replay_hash",
  repairIterations: 1,
  validationState: { ok: true },
  generationProgress: 70,
  workerId: "worker_a",
  queueAttempt: 1,
  recoveryState: { restoredCheckpoint: true },
})
const second = buildDurableOrchestrationSnapshot({
  recoveryState: { restoredCheckpoint: true },
  queueAttempt: 1,
  workerId: "worker_a",
  generationProgress: 70,
  validationState: { ok: true },
  repairIterations: 1,
  replayHash: "replay_hash",
  phaseDurations: { validating: 20, planning: 10 },
  currentPhase: "validating",
  orchestrationState: "running",
  jobId: "job_1",
})

assert.equal(first.orchestrationStateHash, second.orchestrationStateHash, "durable orchestration hash must be deterministic")
assert.equal(MAX_JOB_RECOVERY_ATTEMPTS, 3, "recovery attempts must stay bounded at 3")
assert.equal(classifyRetryReason(new Error("security violation")), "terminal", "security violations must not be retryable")
assert.equal(classifyRetryReason(new Error("provider timeout")), "provider_transient", "provider timeouts should remain retryable")

includes(runtime, /persistDurableState/, "runtime must persist durable orchestration state")
includes(runtime, /leaseId/, "runtime must persist worker lease ownership metadata")
includes(runtime, /orchestrationStateHash/, "runtime must persist idempotent orchestration state hash")
includes(runtime, /reconcileQueueState/, "runtime must expose queue reconciliation")
includes(runtime, /getWorkerPressure/, "runtime must expose worker pressure metrics")
includes(worker, /recoverOrphanedJobs/, "worker must trigger orphan recovery loop")
includes(worker, /recordGenerationWorkerHeartbeat/, "worker must emit heartbeat")
includes(worker, /processGenerationQueueJob\(job, workerId\)/, "worker must pass stable worker id into processing")
includes(queue, /GENERATION_QUEUE_PRIORITY/, "queue must define deterministic priority model")
includes(statusRoute, /progressStreamingReady/, "status API must expose progress streaming readiness")

console.log("orchestration-recovery-regression: ok")

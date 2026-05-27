import assert from "node:assert/strict"
import {
  MAX_JOB_RECOVERY_ATTEMPTS,
  buildDurableOrchestrationSnapshot,
  classifyRetryReason,
} from "@/lib/services/orchestration-runtime.service"
import { resolveGenerationQueuePriority } from "@/lib/queue/generation-queue"

function simulateRecoverySequence(reason: string) {
  const retryClass = classifyRetryReason(new Error(reason), { stage: "generating", reason })
  const attempts = Array.from({ length: MAX_JOB_RECOVERY_ATTEMPTS + 1 }, (_, index) => index + 1)
  return attempts.map((attempt) => ({
    attempt,
    retryClass,
    abandoned: attempt > MAX_JOB_RECOVERY_ATTEMPTS || retryClass === "terminal" || retryClass === "user_cancelled",
  }))
}

const workerCrash = simulateRecoverySequence("worker heartbeat stale after process crash")
assert.equal(workerCrash[0].abandoned, false, "first crash recovery attempt should be recoverable")
assert.equal(workerCrash[2].abandoned, false, "third crash recovery attempt is still within boundary")
assert.equal(workerCrash[3].abandoned, true, "fourth crash recovery attempt must be abandoned")

const security = simulateRecoverySequence("security violation: forbidden execution")
assert.equal(security[0].retryClass, "terminal", "security violation must be terminal")
assert.equal(security[0].abandoned, true, "terminal failures must not be retried")

const checkpoint = buildDurableOrchestrationSnapshot({
  jobId: "job_crash",
  orchestrationState: "recovering",
  currentPhase: "validating",
  replayHash: "stable_replay_hash",
  repairIterations: 2,
  validationState: { ok: false, failure: "provider_timeout" },
  generationProgress: 68,
  workerId: "worker_dead",
  queueAttempt: 2,
  recoveryState: {
    recoveryReason: "heartbeat_stale",
    restoredCheckpoint: true,
    recoveryDurationMs: 25,
  },
})
assert.equal(checkpoint.replayHash, "stable_replay_hash", "checkpoint restore must preserve replay hash")
assert.equal(resolveGenerationQueuePriority({ priority: "recovery" }), 2, "recovery jobs must outrank normal jobs")
assert.equal(resolveGenerationQueuePriority({ priority: "normal" }), 4, "normal jobs must keep bounded priority")

console.log("worker-crash-simulation: ok")

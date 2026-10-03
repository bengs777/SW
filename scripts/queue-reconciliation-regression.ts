import fs from "node:fs"
import path from "node:path"
import assert from "node:assert/strict"

const root = process.cwd()
const read = (file: string) => fs.readFileSync(path.join(root, file), "utf8")

const runtime = read("lib/services/orchestration-runtime.service.ts")
const queue = read("lib/queue/generation-queue.ts")
const monitoring = read("lib/services/admin-monitoring.service.ts")

function check(name: string, condition: boolean) {
  assert.ok(condition, name)
}

check("stuck jobs detected", /stuckJobs/.test(runtime) && /lt\(generationJobs\.updatedAt, staleCutoff\)/.test(runtime))
check("duplicate jobs detected", /duplicateJobs/.test(runtime) && /isNotNull\(generationJobs\.idempotencyKey\)/.test(runtime))
check("zombie workers detected", /zombieWorkers/.test(runtime) && /lt\(workerHeartbeats\.heartbeatAt, staleCutoff\)/.test(runtime))
check("orphan leases detected", /orphanLeases/.test(runtime) && /lt\(generationJobs\.leaseExpiresAt, now\)/.test(runtime))
check("abandoned checkpoints detected", /abandonedCheckpoints/.test(runtime) && /recovering/.test(runtime))
check("automatic cleanup calls recovery", /recoverOrphanedJobs/.test(runtime) && /cleanup:\s*recovery/.test(runtime))
check("retry containment honors terminal class", /retryAllowed/.test(runtime) && /TERMINAL_RETRY_PATTERNS/.test(runtime))
check("priority has admin recovery retry normal", /admin:\s*1/.test(queue) && /recovery:\s*2/.test(queue) && /retry:\s*3/.test(queue) && /normal:\s*4/.test(queue))
check("monitoring exposes scaling recommendation", /workerPressure/.test(monitoring) && /scalingRecommendation/.test(monitoring))

console.log("queue-reconciliation-regression: ok")

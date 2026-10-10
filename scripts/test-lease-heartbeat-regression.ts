import assert from "node:assert/strict"
import { db } from "@/lib/db/client"
import { generationJobs } from "@/lib/db/schema"
import { eq } from "drizzle-orm"
import { OrchestrationRuntimeService } from "@/lib/services/orchestration-runtime.service"
import { GenerationJobService } from "@/lib/services/generation-job.service"

async function runLeaseHeartbeatRegressionTest() {
  console.log("=== RUNNING REGRESSION TEST: Job >5m + active lease + heartbeat renew => NOT orphaned ===")

  const testJobId = `test-lease-${Date.now()}`
  const workerId = `generation:local:test-${process.pid}`
  const now = new Date()
  const sixMinutesAgo = new Date(now.getTime() - 6 * 60 * 1000)

  // 1. Create a simulated job that started 6 minutes ago (> 5 minutes ORPHANED_JOB_MINUTES)
  await db.insert(generationJobs).values({
    id: testJobId,
    userId: "usr_test_heartbeat",
    projectId: "prj_test_heartbeat",
    prompt: "Test laundry prompt",
    model: "swift-builder",
    provider: "swift",
    status: "running",
    stage: "generating",
    progress: 50,
    orchestrationState: "assigned",
    workerId,
    leaseOwner: workerId,
    leaseExpiresAt: new Date(now.getTime() + 10 * 60 * 1000), // active lease
    lastHeartbeatAt: sixMinutesAgo, // initially stale
    startedAt: sixMinutesAgo,
    createdAt: sixMinutesAgo,
    updatedAt: sixMinutesAgo,
    version: 1,
  })

  try {
    // 2. Worker heartbeat fires: renewLease is called
    console.log("[1] Simulating worker heartbeat renewing lease and lastHeartbeatAt...")
    const renewed = await OrchestrationRuntimeService.renewLease({
      jobId: testJobId,
      workerId,
      currentStage: "generating",
      lastSuccessfulTransition: "slice_completed",
      leaseMs: 900_000,
    })

    assert.equal(renewed, true, "renewLease must return true for active lease owner")

    const [jobAfterRenew] = await db.select().from(generationJobs).where(eq(generationJobs.id, testJobId))
    assert.ok(jobAfterRenew, "Job must exist in DB")
    assert.ok(jobAfterRenew.lastHeartbeatAt, "lastHeartbeatAt must be set")
    const heartbeatAgeMs = Date.now() - jobAfterRenew.lastHeartbeatAt.getTime()
    assert.ok(heartbeatAgeMs < 5000, `lastHeartbeatAt must be fresh (<5s), got ${heartbeatAgeMs}ms`)
    assert.ok(jobAfterRenew.leaseExpiresAt && jobAfterRenew.leaseExpiresAt.getTime() > Date.now(), "leaseExpiresAt must be in future")
    console.log("-> Proved: renewLease refreshed lastHeartbeatAt and extended leaseExpiresAt")

    // 3. recoverOrphanedJobs runs
    console.log("[2] Running recoverOrphanedJobs while worker lease is active...")
    const recoveryResult = await OrchestrationRuntimeService.recoverOrphanedJobs(25)
    console.log("-> recoverOrphanedJobs result:", recoveryResult)

    const [jobAfterRecovery] = await db.select().from(generationJobs).where(eq(generationJobs.id, testJobId))
    assert.equal(jobAfterRecovery.status, "running", "Job status must remain 'running' (MUST NOT BE ABANDONED OR DEAD-LETTERED)")
    assert.notEqual(jobAfterRecovery.status, "dead_lettered", "Active job must NOT be dead_lettered")
    assert.notEqual(jobAfterRecovery.status, "retrying", "Active job must NOT be marked retrying")
    console.log("-> Proved: Active running job >5m is NOT misidentified as orphan")

    // 4. Job completes successfully
    console.log("[3] Completing job and releasing lease...")
    await GenerationJobService.transition(testJobId, {
      type: "job.completed",
      status: "completed",
      stage: "completed",
      message: "Job completed",
      progress: 100,
      completedAt: new Date(),
    })

    await OrchestrationRuntimeService.releaseLease(testJobId, workerId, "completed")

    const [finalJob] = await db.select().from(generationJobs).where(eq(generationJobs.id, testJobId))
    assert.equal(finalJob.status, "completed", "Job must reach 'completed'")
    assert.equal(finalJob.leaseOwner, null, "leaseOwner must be cleared on completion")
    console.log("-> Proved: Job successfully reached terminal status 'completed'")

    // 5. Safety Mechanism Test: A truly abandoned job (expired lease + stale heartbeat) IS recovered
    console.log("[4] Testing Safety Mechanism: Truly abandoned job (expired lease)...")
    const deadJobId = `test-dead-${Date.now()}`
    const tenMinutesAgo = new Date(Date.now() - 10 * 60 * 1000)
    await db.insert(generationJobs).values({
      id: deadJobId,
      userId: "usr_test_heartbeat",
      projectId: "prj_test_heartbeat",
      prompt: "Dead job prompt",
      model: "swift-builder",
      provider: "swift",
      status: "running",
      stage: "generating",
      progress: 20,
      orchestrationState: "running",
      workerId: "generation:local:dead-worker",
      leaseOwner: "generation:local:dead-worker",
      leaseExpiresAt: tenMinutesAgo, // lease EXPIRED 10 minutes ago
      lastHeartbeatAt: tenMinutesAgo, // stale
      startedAt: tenMinutesAgo,
      createdAt: tenMinutesAgo,
      updatedAt: tenMinutesAgo,
      version: 1,
    })

    try {
      const deadRecoveryResult = await OrchestrationRuntimeService.recoverOrphanedJobs(25)
      console.log("-> Truly expired lease recovery result:", deadRecoveryResult)
      assert.ok(deadRecoveryResult.recovered > 0, "Safety mechanism must recover truly expired leases")
      const [recoveredDeadJob] = await db.select().from(generationJobs).where(eq(generationJobs.id, deadJobId))
      assert.equal(recoveredDeadJob.status, "retrying", "Truly dead job must be recovered to 'retrying'")
      console.log("-> Proved: Safety mechanism is fully intact; truly dead jobs are recovered")
    } finally {
      await db.delete(generationJobs).where(eq(generationJobs.id, deadJobId)).catch(() => null)
    }

    console.log("\n=== ALL LEASE & RECOVERY REGRESSION TESTS PASSED ===")
  } finally {
    // Cleanup mock row
    await db.delete(generationJobs).where(eq(generationJobs.id, testJobId)).catch(() => null)
  }
}

runLeaseHeartbeatRegressionTest().catch((err) => {
  console.error("Test failed:", err)
  process.exit(1)
})

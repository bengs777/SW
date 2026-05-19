function errorPayload(error: unknown) {
  return {
    error: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error ? error.stack : undefined,
  }
}

async function runFailOpen(stage: string, task: () => Promise<void> | void) {
  console.info("[INSTRUMENTATION_INIT]", {
    stage,
    runtime: process.env.NEXT_RUNTIME || "nodejs",
  })

  try {
    await task()
  } catch (error) {
    console.error("[INSTRUMENTATION_INIT_FAILED]", {
      stage,
      ...errorPayload(error),
    })
  }
}

async function warnMissingProductionEnv() {
  if (typeof window !== "undefined" || process.env.NODE_ENV !== "production") {
    return
  }

  const { getMissingProductionEnvVars } = await import("@/lib/env")
  const missing = getMissingProductionEnvVars()
  for (const key of missing) {
    console.warn("[INSTRUMENTATION_WARNING]", `${key} missing`)
  }
}

function shouldStartGenerationWorker() {
  if (process.env.SWIFT_ENABLE_GENERATION_WORKER !== "true") {
    return false
  }

  if (process.env.VERCEL === "1") {
    console.warn("[INSTRUMENTATION_WARNING]", "SWIFT_ENABLE_GENERATION_WORKER ignored on Vercel serverless runtime. Run BullMQ workers in a dedicated Node process.")
    return false
  }

  return true
}

function shouldStartOrchestrationCleanup() {
  if (process.env.SWIFT_ENABLE_ORCHESTRATION_CLEANUP === "false") return false
  if (process.env.VERCEL === "1") return false
  return true
}

export async function register() {
  await runFailOpen("environment", warnMissingProductionEnv)

  await runFailOpen("generation_worker", async () => {
    if (shouldStartGenerationWorker()) {
      const globalState = globalThis as typeof globalThis & { swiftGenerationWorkerStarted?: boolean }
      if (!globalState.swiftGenerationWorkerStarted) {
        const { startGenerationWorker } = await import("@/lib/workers/generation-worker")
        startGenerationWorker()
        globalState.swiftGenerationWorkerStarted = true
      }
    }
  })

  await runFailOpen("orchestration_cleanup", async () => {
    if (!shouldStartOrchestrationCleanup()) return
    const globalState = globalThis as typeof globalThis & { swiftOrchestrationCleanupStarted?: boolean }
    if (globalState.swiftOrchestrationCleanupStarted) return
    const { OrchestrationRuntimeService } = await import("@/lib/services/orchestration-runtime.service")
    const { cleanupExpiredRuntimeSandboxes } = await import("@/lib/sandbox/runtime")
    const runCleanup = () => {
      OrchestrationRuntimeService.cleanupExpiredLifecycle().catch((error) => {
        console.error("[ORCHESTRATION_CLEANUP_FAILED]", errorPayload(error))
      })
      OrchestrationRuntimeService.recoverOrphanedJobs().catch((error) => {
        console.error("[ORCHESTRATION_RECOVERY_FAILED]", errorPayload(error))
      })
      cleanupExpiredRuntimeSandboxes().catch((error) => {
        console.error("[SANDBOX_CLEANUP_FAILED]", errorPayload(error))
      })
    }
    runCleanup()
    setInterval(runCleanup, Number(process.env.SWIFT_ORCHESTRATION_CLEANUP_INTERVAL_MS || 60_000))
    globalState.swiftOrchestrationCleanupStarted = true
  })
}

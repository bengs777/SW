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
  // Skip during build phase — env vars won't be available until runtime.
  // NEXT_PHASE is "phase-production-build" during `next build`.
  if (
    typeof window !== "undefined" ||
    process.env.NODE_ENV !== "production" ||
    process.env.NEXT_PHASE === "phase-production-build"
  ) {
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
}

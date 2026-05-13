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

export async function register() {
  await runFailOpen("environment", warnMissingProductionEnv)

  await runFailOpen("generation_worker", async () => {
    if (process.env.SWIFT_ENABLE_GENERATION_WORKER === "true") {
      const globalState = globalThis as typeof globalThis & { swiftGenerationWorkerStarted?: boolean }
      if (!globalState.swiftGenerationWorkerStarted) {
        const { startGenerationWorker } = await import("@/lib/workers/generation-worker")
        startGenerationWorker()
        globalState.swiftGenerationWorkerStarted = true
      }
    }
  })
}

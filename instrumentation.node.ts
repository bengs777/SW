// Standalone Node.js worker instrumentation (non-Next.js runtime)
// Used by BullMQ workers running in dedicated processes.

function isBuildPhase() {
  return process.env.NEXT_PHASE === "phase-production-build"
}

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

async function validateRuntimeEnv() {
  // Never run during build phase
  if (typeof window !== "undefined" || isBuildPhase()) {
    return
  }

  if (process.env.NODE_ENV !== "production") {
    return
  }

  const { getMissingCoreEnvVars, getFeatureGatedIssues } = await import("@/lib/env")

  // Only report core missing vars as errors
  const missing = getMissingCoreEnvVars()
  for (const key of missing) {
    console.error("[ENV_VALIDATION]", `${key} is required in production.`)
  }

  // Feature-gated issues at warn level
  const featureIssues = getFeatureGatedIssues()
  for (const issue of featureIssues) {
    console.warn("[ENV_VALIDATION]", issue.message)
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
  await runFailOpen("environment", validateRuntimeEnv)

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

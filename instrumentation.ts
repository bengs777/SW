import * as Sentry from "@sentry/nextjs"

export const onRequestError = Sentry.captureRequestError

function errorPayload(error: unknown) {
  return {
    error: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error ? error.stack : undefined,
  }
}

async function runFailOpen(stage: string, task: () => Promise<void> | void) {
  console.info("[INSTRUMENTATION_INIT]", {
    stage,
    runtime: process.env.NEXT_RUNTIME || "unknown",
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

  const { validateEnv } = await import("@/lib/env")
  const report = validateEnv()
  for (const issue of report.issues) {
    console.warn("[INSTRUMENTATION_WARNING]", {
      key: issue.key,
      severity: issue.severity,
      message: issue.message,
    })
  }
}

export async function register() {
  await runFailOpen("sentry", async () => {
    if (process.env.NEXT_RUNTIME === "nodejs") {
      await import("./sentry.server.config")
    }

    if (process.env.NEXT_RUNTIME === "edge") {
      await import("./sentry.edge.config")
    }

    if (!process.env.SENTRY_DSN && !process.env.NEXT_PUBLIC_SENTRY_DSN) {
      console.warn("[INSTRUMENTATION_WARNING]", "SENTRY_DSN missing")
    }
  })

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

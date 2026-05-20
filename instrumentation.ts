import * as Sentry from "@sentry/nextjs"
import { log } from "@/lib/logging"

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

async function runFailClosed(stage: string, task: () => Promise<void> | void) {
  console.info("[INSTRUMENTATION_INIT]", {
    stage,
    runtime: process.env.NEXT_RUNTIME || "unknown",
  })

  try {
    await task()
  } catch (error) {
    console.error("[INSTRUMENTATION_FATAL]", {
      stage,
      ...errorPayload(error),
    })
    throw error
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

async function assertRuntimeDatabaseSchema() {
  if (process.env.SWIFT_SKIP_SCHEMA_GUARD === "true") {
    console.warn("[INSTRUMENTATION_WARNING]", "SWIFT_SKIP_SCHEMA_GUARD=true; database schema compatibility guard skipped")
    return
  }

  const { assertDatabaseSchemaCompatible } = await import("@/lib/db/schema-health")
  await assertDatabaseSchemaCompatible()
}

function registerGlobalErrorCapture() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return
  const nodeProcess = (globalThis as typeof globalThis & { process?: { on?: (event: string, handler: (...args: unknown[]) => void) => void } }).process
  if (typeof nodeProcess?.on !== "function") return

  const globalState = globalThis as typeof globalThis & { swiftGlobalErrorCaptureRegistered?: boolean }
  if (globalState.swiftGlobalErrorCaptureRegistered) return
  globalState.swiftGlobalErrorCaptureRegistered = true

  nodeProcess.on("unhandledRejection", (reason) => {
    log("error", "process_unhandled_rejection", {
      reason: reason instanceof Error ? reason.message : String(reason),
      stack: reason instanceof Error ? reason.stack : undefined,
    })
    Sentry.captureException(reason)
  })

  nodeProcess.on("uncaughtException", (error) => {
    const payload = errorPayload(error)
    log("error", "process_uncaught_exception", {
      error: payload.error,
      stack: payload.stack,
    })
    Sentry.captureException(error)
  })
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

  await runFailOpen("global_error_capture", registerGlobalErrorCapture)

  if (process.env.NEXT_RUNTIME === "nodejs") {
    await runFailClosed("database_schema", assertRuntimeDatabaseSchema)

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

  // Initialize AI warmup (keep-alive socket + Redis cache) so the AI subsystem
  // is always in standby and ready to respond fast on first request.
  // Only runs in nodejs runtime (not edge) since it uses keep-alive HTTP agents.
  if (process.env.NEXT_RUNTIME === "nodejs") {
    await runFailOpen("ai_warmup", async () => {
      if (process.env.SWIFT_ENABLE_AI_WARMUP === "false") {
        return
      }

      const { initializeAiWarmup } = await import("@/lib/ai/warmup")
      initializeAiWarmup()
    })
  }
}

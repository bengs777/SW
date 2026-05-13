import * as Sentry from "@sentry/nextjs"
import { assertProductionEnvReady } from "@/lib/env"

export const onRequestError = Sentry.captureRequestError

export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    await import("./sentry.server.config")
  }

  if (process.env.NEXT_RUNTIME === "edge") {
    await import("./sentry.edge.config")
  }

  assertProductionEnvReady()

  if (process.env.SWIFT_ENABLE_GENERATION_WORKER === "true") {
    const globalState = globalThis as typeof globalThis & { swiftGenerationWorkerStarted?: boolean }
    if (!globalState.swiftGenerationWorkerStarted) {
      const { startGenerationWorker } = await import("@/lib/workers/generation-worker")
      startGenerationWorker()
      globalState.swiftGenerationWorkerStarted = true
    }
  }
}

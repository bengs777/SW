import { assertProductionEnvReady } from "@/lib/env"

export async function register() {
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
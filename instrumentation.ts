import * as Sentry from "@sentry/nextjs"

export const onRequestError = Sentry.captureRequestError

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

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

// ─────────────────────────────────────────────────────────────────────────────
// Environment validation — runtime only, never during build
// ─────────────────────────────────────────────────────────────────────────────

async function validateRuntimeEnv() {
  // Never run during build phase — env vars aren't available at build time
  if (typeof window !== "undefined" || isBuildPhase()) {
    return
  }

  // Only validate in production runtime
  if (process.env.NODE_ENV !== "production") {
    return
  }

  const { validateEnv, getFeatureGatedIssues } = await import("@/lib/env")
  const report = validateEnv()

  // Only log CORE errors — things that will actually break the app
  const coreErrors = report.issues.filter(
    (issue) => issue.severity === "error"
  )

  for (const issue of coreErrors) {
    console.error("[ENV_VALIDATION]", {
      key: issue.key,
      severity: issue.severity,
      message: issue.message,
      category: issue.category || "core",
    })
  }

  // Feature-gated issues logged at warn level (not error)
  const featureIssues = getFeatureGatedIssues()
  for (const issue of featureIssues) {
    console.warn("[ENV_VALIDATION]", {
      key: issue.key,
      message: issue.message,
      category: "feature-gated",
    })
  }

  // Optional integrations are NOT logged during startup — they are truly optional.
  // If you need a diagnostic dump, use the /api/admin/monitoring endpoint.
}

// ─────────────────────────────────────────────────────────────────────────────
// Generation worker — feature-gated
// ─────────────────────────────────────────────────────────────────────────────

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

// ─────────────────────────────────────────────────────────────────────────────
// Register — called by Next.js at startup (and during build)
// ─────────────────────────────────────────────────────────────────────────────

export async function register() {
  // Sentry — only initialize when DSN is configured (optional integration)
  await runFailOpen("sentry", async () => {
    const hasSentryDsn = Boolean(
      process.env.SENTRY_DSN || process.env.NEXT_PUBLIC_SENTRY_DSN
    )

    // Skip entirely if no DSN — Sentry is optional, no warning needed
    if (!hasSentryDsn) return

    if (process.env.NEXT_RUNTIME === "nodejs") {
      await import("./sentry.server.config")
    }

    if (process.env.NEXT_RUNTIME === "edge") {
      await import("./sentry.edge.config")
    }
  })

  // Environment validation — only at runtime, never during build
  await runFailOpen("environment", validateRuntimeEnv)

  // Generation worker — feature-gated, requires explicit opt-in
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

  // AI warmup — only at runtime in nodejs (not during build, not on edge)
  await runFailOpen("ai_warmup", async () => {
    if (process.env.NEXT_RUNTIME === "nodejs" && !isBuildPhase()) {
      const { initializeAiWarmup } = await import("@/lib/ai/warmup")
      initializeAiWarmup()
    }
  })
}

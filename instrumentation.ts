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

type StageOutcome = {
  stage: string
  ok: boolean
  durationMs: number
  error?: string
}

/**
 * Run a registration stage but never throw — instrumentation MUST NOT crash
 * the process. We collect outcomes so register() can emit a single summary
 * log instead of one log per stage (which produced [INSTRUMENTATION_INIT]
 * spam in production).
 */
async function runStage(
  outcomes: StageOutcome[],
  stage: string,
  task: () => Promise<void> | void
) {
  const startedAt = Date.now()
  try {
    await task()
    outcomes.push({ stage, ok: true, durationMs: Date.now() - startedAt })
  } catch (error) {
    const payload = errorPayload(error)
    outcomes.push({
      stage,
      ok: false,
      durationMs: Date.now() - startedAt,
      error: payload.error,
    })
    // Errors still get their own log line so they can't be filtered out.
    console.error("[INSTRUMENTATION_INIT_FAILED]", { stage, ...payload })
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
}

// ─────────────────────────────────────────────────────────────────────────────
// Generation worker — feature-gated
// ─────────────────────────────────────────────────────────────────────────────

function shouldStartGenerationWorker() {
  if (process.env.SWIFT_ENABLE_GENERATION_WORKER !== "true") {
    return false
  }

  if (process.env.VERCEL === "1") {
    // Worker on Vercel serverless is unsupported; warn once at register()
    // time, not on every stage iteration.
    return false
  }

  return true
}

// ─────────────────────────────────────────────────────────────────────────────
// register() — idempotent across re-imports of this module.
//
// Next.js calls register() once per runtime context. We add a process-level
// guard so even if the module is loaded twice (HMR edge cases, dual runtime
// builds), the instrumentation work only runs once.
// ─────────────────────────────────────────────────────────────────────────────

const REGISTER_FLAG = Symbol.for("swift.instrumentation.registered")
type GlobalWithFlag = typeof globalThis & { [REGISTER_FLAG]?: boolean }

export async function register() {
  const g = globalThis as GlobalWithFlag
  if (g[REGISTER_FLAG]) return
  g[REGISTER_FLAG] = true

  const startedAt = Date.now()
  const outcomes: StageOutcome[] = []

  // Sentry — only initialize when DSN is configured (optional integration)
  await runStage(outcomes, "sentry", async () => {
    const hasSentryDsn = Boolean(
      process.env.SENTRY_DSN || process.env.NEXT_PUBLIC_SENTRY_DSN
    )

    if (!hasSentryDsn) return

    if (process.env.NEXT_RUNTIME === "nodejs") {
      await import("./sentry.server.config")
    }

    if (process.env.NEXT_RUNTIME === "edge") {
      await import("./sentry.edge.config")
    }
  })

  // Environment validation — only at runtime, never during build
  await runStage(outcomes, "environment", validateRuntimeEnv)

  // Generation worker — feature-gated, requires explicit opt-in
  await runStage(outcomes, "generation_worker", async () => {
    if (!shouldStartGenerationWorker()) return

    const globalState = globalThis as typeof globalThis & {
      swiftGenerationWorkerStarted?: boolean
    }
    if (globalState.swiftGenerationWorkerStarted) return

    const { startGenerationWorker } = await import(
      "@/lib/workers/generation-worker"
    )
    startGenerationWorker()
    globalState.swiftGenerationWorkerStarted = true
  })

  // AI warmup — only at runtime in nodejs (not during build, not on edge).
  // Note: warmup module itself short-circuits on Vercel serverless.
  await runStage(outcomes, "ai_warmup", async () => {
    if (process.env.NEXT_RUNTIME !== "nodejs" || isBuildPhase()) return
    const { initializeAiWarmup } = await import("@/lib/ai/warmup")
    initializeAiWarmup()
  })

  // SINGLE summary line for the entire register() lifecycle.
  // This replaces the previous per-stage [INSTRUMENTATION_INIT] log spam.
  const failed = outcomes.filter((o) => !o.ok).map((o) => o.stage)
  console.info("[INSTRUMENTATION_INIT_SUMMARY]", {
    runtime: process.env.NEXT_RUNTIME || "unknown",
    durationMs: Date.now() - startedAt,
    stages: outcomes.map((o) => `${o.stage}:${o.ok ? "ok" : "fail"}:${o.durationMs}ms`).join(","),
    failedCount: failed.length,
    ...(failed.length > 0 ? { failed } : {}),
  })
}

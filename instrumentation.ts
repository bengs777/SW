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
 * the process. Outcomes are collected for a single summary log emitted by
 * register() once at the end.
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
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Environment validation — runtime only, never during build
// ─────────────────────────────────────────────────────────────────────────────

async function validateRuntimeEnv() {
  if (typeof window !== "undefined" || isBuildPhase()) {
    return
  }

  if (process.env.NODE_ENV !== "production") {
    return
  }

  const { validateEnv, getFeatureGatedIssues } = await import("@/lib/env")
  const report = validateEnv()

  // Only log CORE errors — things that will actually break the app.
  const coreErrors = report.issues.filter((issue) => issue.severity === "error")

  for (const issue of coreErrors) {
    console.error("[ENV_VALIDATION]", {
      key: issue.key,
      severity: issue.severity,
      message: issue.message,
      category: issue.category || "core",
    })
  }

  // Feature-gated issues at warn level (not error).
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
    // Worker on Vercel serverless is unsupported — silently skip. The very
    // first cold start logs this once via the summary; subsequent calls do
    // not.
    return false
  }

  return true
}

// ─────────────────────────────────────────────────────────────────────────────
// register() — idempotent across re-imports of this module.
//
// LOG NOISE POLICY (Fix 6):
//   - Production: emit a single summary line ONLY on the first successful
//     register() per process. Subsequent register() calls (Next.js may invoke
//     once per runtime context per cold start) are silent.
//   - Production with stage failures: always log, but as one line containing
//     the failed stages. Errors with full stack are also routed to Sentry.
//   - Non-production: log every register() so dev / CI sees lifecycle.
// ─────────────────────────────────────────────────────────────────────────────

const REGISTER_FLAG = Symbol.for("swift.instrumentation.registered")
const SUMMARY_LOGGED_FLAG = Symbol.for("swift.instrumentation.summary_logged")
type GlobalWithFlags = typeof globalThis & {
  [REGISTER_FLAG]?: boolean
  [SUMMARY_LOGGED_FLAG]?: boolean
}

export async function register() {
  const g = globalThis as GlobalWithFlags
  if (g[REGISTER_FLAG]) return
  g[REGISTER_FLAG] = true

  const startedAt = Date.now()
  const outcomes: StageOutcome[] = []

  // Sentry — only initialize when DSN is configured (optional integration).
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

  await runStage(outcomes, "environment", validateRuntimeEnv)

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

  await runStage(outcomes, "ai_warmup", async () => {
    if (process.env.NEXT_RUNTIME !== "nodejs" || isBuildPhase()) return
    const { initializeAiWarmup } = await import("@/lib/ai/warmup")
    initializeAiWarmup()
  })

  const failed = outcomes.filter((o) => !o.ok)
  const isProduction = process.env.NODE_ENV === "production"
  const alreadyLogged = g[SUMMARY_LOGGED_FLAG]

  // Production policy: one summary on first successful init, plus any failure.
  // Non-production: always log so devs see the lifecycle.
  const shouldLogSummary = !isProduction || !alreadyLogged || failed.length > 0

  if (shouldLogSummary) {
    const payload = {
      runtime: process.env.NEXT_RUNTIME || "unknown",
      durationMs: Date.now() - startedAt,
      stages: outcomes
        .map((o) => `${o.stage}:${o.ok ? "ok" : "fail"}:${o.durationMs}ms`)
        .join(","),
      failedCount: failed.length,
      ...(failed.length > 0
        ? {
            failed: failed.map((f) => ({ stage: f.stage, error: f.error })),
          }
        : {}),
    }

    if (failed.length > 0) {
      console.error("[INSTRUMENTATION_INIT_SUMMARY]", payload)
      // Also surface to Sentry if it initialized.
      try {
        for (const stage of failed) {
          Sentry.captureMessage(
            `Instrumentation stage failed: ${stage.stage}`,
            { level: "error", extra: stage }
          )
        }
      } catch {
        /* Sentry not initialized — not critical */
      }
    } else {
      console.info("[INSTRUMENTATION_INIT_SUMMARY]", payload)
    }

    g[SUMMARY_LOGGED_FLAG] = true
  }
}

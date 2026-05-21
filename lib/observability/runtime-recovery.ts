import { createHash, randomUUID } from "node:crypto"
import { subHours } from "date-fns"
import { prisma } from "@/lib/db/client"
import { buildStructuredRepairPlan } from "@/lib/ai/repair-engine"
import type { GeneratedFile } from "@/lib/types"
import { log } from "@/lib/logging"
import { captureException } from "@/lib/observability"
import { classifyRuntimeError } from "@/lib/observability/performance-monitor"
import { getExecutionTraceSnapshot, traceExecution, type ExecutionTraceContext } from "@/lib/observability/execution-tracer"
import { getRuntimeMetricsSnapshot } from "@/lib/observability/runtime-metrics"
import { ProjectFilePersistenceService } from "@/lib/services/project-file-persistence.service"
import { ProjectFilesystemService } from "@/lib/services/project-filesystem.service"
import { OrchestrationRuntimeService, type TraceIds } from "@/lib/services/orchestration-runtime.service"
import type { GenerationJobStage, GenerationJobStatus } from "@/lib/services/generation-job.service"

export type RuntimeRecoveryPhase =
  | "capture"
  | "diagnose"
  | "isolate"
  | "targeted_repair"
  | "validation"
  | "rollback"
  | "redeploy"

export type RuntimeErrorCapture = {
  correlationId: string
  projectId: string
  jobId?: string | null
  traceId?: string | null
  message: string
  stack?: string | null
  file?: string | null
  lineno?: number | null
  colno?: number | null
  source: "preview" | "sandbox" | "orchestrator" | "worker" | "deploy"
  severity: "warning" | "error" | "critical"
  capturedAt: string
}

export type RuntimeDiagnosis = {
  errorCode: string
  repairStage: string
  category: string
  reason: string
  targetFiles: string[]
  preserveFiles: string[]
  patchStrategy: string
  catastrophic: boolean
  route: "targeted_repair" | "manual_review"
}

type RuntimeEventRecord = RuntimeErrorCapture & {
  phase: RuntimeRecoveryPhase
  diagnosis?: RuntimeDiagnosis | null
  metadata?: Record<string, unknown> | null
}

const MAX_RECENT_RUNTIME_EVENTS = 250
const recentRuntimeEvents: RuntimeEventRecord[] = []

function pushRuntimeEvent(event: RuntimeEventRecord) {
  recentRuntimeEvents.push(event)
  if (recentRuntimeEvents.length > MAX_RECENT_RUNTIME_EVENTS) {
    recentRuntimeEvents.splice(0, recentRuntimeEvents.length - MAX_RECENT_RUNTIME_EVENTS)
  }
}

function normalizePath(value: string) {
  return String(value || "").replace(/\\/g, "/").replace(/^\/+/, "").replace(/^\.\//, "").trim()
}

function safeJsonParse<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback
  try {
    return JSON.parse(value) as T
  } catch {
    return fallback
  }
}

function hashFiles(files: GeneratedFile[]) {
  return createHash("sha256")
    .update(
      JSON.stringify(
        ProjectFilesystemService.normalizeFiles(files).map((file) => ({
          path: normalizePath(file.path),
          content: file.content,
        }))
      )
    )
    .digest("hex")
}

function publicMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error || "Unknown runtime error")
}

export function createErrorCorrelationId(prefix = "swift") {
  return `${prefix}_${randomUUID()}`
}

export function diagnoseRuntimeError(input: {
  error: unknown
  files: GeneratedFile[]
  fallbackTargets?: string[]
}): RuntimeDiagnosis {
  const message = publicMessage(input.error)
  const repairPlan = buildStructuredRepairPlan({
    errorMessage: message,
    files: input.files,
    fallbackTargets: input.fallbackTargets,
  })

  return {
    errorCode: classifyRuntimeError(input.error),
    repairStage: repairPlan.stage,
    category: repairPlan.category,
    reason: repairPlan.reason,
    targetFiles: repairPlan.targetFiles,
    preserveFiles: repairPlan.preserveFiles,
    patchStrategy: repairPlan.patchStrategy,
    catastrophic: repairPlan.catastrophic,
    route: repairPlan.catastrophic ? "manual_review" : "targeted_repair",
  }
}

export function isolateRepairScope(input: {
  files: GeneratedFile[]
  diagnosis: RuntimeDiagnosis
  maxFiles?: number
}) {
  const targets = new Set(input.diagnosis.targetFiles.map(normalizePath))
  const maxFiles = Math.max(1, input.maxFiles || 8)
  const scopedFiles = input.files
    .filter((file) => targets.has(normalizePath(file.path)))
    .slice(0, maxFiles)
  return {
    targetFiles: scopedFiles,
    targetPaths: scopedFiles.map((file) => normalizePath(file.path)),
    preservePaths: input.files
      .map((file) => normalizePath(file.path))
      .filter((path) => !targets.has(path)),
  }
}

export function filterRepairOutputToScope(input: {
  files: GeneratedFile[]
  targetPaths: string[]
}) {
  const targets = new Set(input.targetPaths.map(normalizePath))
  const accepted = input.files.filter((file) => targets.has(normalizePath(file.path)))
  const rejected = input.files
    .filter((file) => !targets.has(normalizePath(file.path)))
    .map((file) => normalizePath(file.path))
  return { accepted, rejected }
}

export function shouldStopRepeatedRepairLoop(input: {
  attempts: Array<{ ok: boolean; targetPaths?: string[]; outputHash?: string | null; error?: string | null }>
  nextOutputHash?: string | null
  nextError?: string | null
  maxAttempts?: number
}) {
  const maxAttempts = Math.max(1, input.maxAttempts || 2)
  if (input.attempts.length >= maxAttempts) {
    return { stop: true, reason: "max_repair_attempts_reached" }
  }

  if (input.nextOutputHash && input.attempts.some((attempt) => attempt.outputHash === input.nextOutputHash)) {
    return { stop: true, reason: "repeated_identical_repair_output" }
  }

  const normalizedNextError = String(input.nextError || "").trim().slice(0, 500)
  if (
    normalizedNextError &&
    input.attempts.filter((attempt) => String(attempt.error || "").trim().slice(0, 500) === normalizedNextError).length >= 1
  ) {
    return { stop: true, reason: "repeated_identical_runtime_error" }
  }

  return { stop: false, reason: null }
}

export async function captureRuntimeError(input: {
  projectId: string
  jobId?: string | null
  trace?: TraceIds
  message: string
  stack?: string | null
  file?: string | null
  lineno?: number | null
  colno?: number | null
  source: RuntimeErrorCapture["source"]
  severity?: RuntimeErrorCapture["severity"]
  metadata?: Record<string, unknown> | null
}) {
  const capture: RuntimeErrorCapture = {
    correlationId: input.trace?.traceId || createErrorCorrelationId("runtime"),
    projectId: input.projectId,
    jobId: input.jobId || null,
    traceId: input.trace?.traceId || null,
    message: input.message,
    stack: input.stack || null,
    file: input.file ? normalizePath(input.file) : null,
    lineno: input.lineno ?? null,
    colno: input.colno ?? null,
    source: input.source,
    severity: input.severity || "error",
    capturedAt: new Date().toISOString(),
  }

  pushRuntimeEvent({
    ...capture,
    phase: "capture",
    metadata: input.metadata || null,
  })

  log(input.severity === "warning" ? "warn" : "error", "runtime_error_captured", {
    ...capture,
    metadata: input.metadata || null,
  })
  captureException(new Error(input.message), {
    ...capture,
    metadata: input.metadata || null,
  })

  if (input.jobId) {
    await OrchestrationRuntimeService.appendEvent({
      jobId: input.jobId,
      trace: input.trace,
      type: "runtime_error_captured",
      stage: "building",
      status: "failed",
      message: input.message,
      data: {
        correlationId: capture.correlationId,
        source: input.source,
        file: capture.file,
        lineno: capture.lineno,
        colno: capture.colno,
        stack: input.stack?.slice(0, 4000) || null,
        metadata: input.metadata || null,
      },
    }).catch(() => null)
    await OrchestrationRuntimeService.persistFailure({
      jobId: input.jobId,
      trace: input.trace,
      eventType: "runtime_error_captured",
      stage: "runtime",
      severity: input.severity || "error",
      reason: input.message,
      terminationReason: "runtime_error",
      metadata: {
        correlationId: capture.correlationId,
        source: input.source,
        file: capture.file,
        lineno: capture.lineno,
        colno: capture.colno,
        stack: input.stack?.slice(0, 4000) || null,
        metadata: input.metadata || null,
      },
    }).catch(() => null)
  }

  return capture
}

export async function recordRuntimeRecoveryEvent(input: {
  capture: RuntimeErrorCapture
  phase: RuntimeRecoveryPhase
  diagnosis?: RuntimeDiagnosis | null
  jobId?: string | null
  trace?: TraceIds
  stage?: GenerationJobStage
  status?: GenerationJobStatus
  message: string
  metadata?: Record<string, unknown> | null
}) {
  pushRuntimeEvent({
    ...input.capture,
    phase: input.phase,
    diagnosis: input.diagnosis || null,
    metadata: input.metadata || null,
  })
  log(input.status === "failed" ? "error" : "info", "runtime_recovery_event", {
    correlationId: input.capture.correlationId,
    projectId: input.capture.projectId,
    jobId: input.jobId || input.capture.jobId || null,
    phase: input.phase,
    diagnosis: input.diagnosis || null,
    message: input.message,
    metadata: input.metadata || null,
  })

  const jobId = input.jobId || input.capture.jobId
  if (jobId) {
    await OrchestrationRuntimeService.appendEvent({
      jobId,
      trace: input.trace || { traceId: input.capture.traceId },
      type: `runtime_recovery.${input.phase}`,
      stage: input.stage || "repairing",
      status: input.status || "running",
      message: input.message,
      data: {
        correlationId: input.capture.correlationId,
        diagnosis: input.diagnosis || null,
        metadata: input.metadata || null,
      },
    }).catch(() => null)
  }
}

export async function createRuntimeSnapshot(input: {
  projectId: string
  prompt: string
  files?: GeneratedFile[]
  idempotencyKey: string
  intent?: string | null
}) {
  const files = ProjectFilesystemService.normalizeFiles(input.files || await ProjectFilesystemService.readFiles(input.projectId))
  const history = await prisma.generationHistory.upsert({
    where: {
      projectId_idempotencyKey: {
        projectId: input.projectId,
        idempotencyKey: input.idempotencyKey,
      },
    },
    create: {
      projectId: input.projectId,
      prompt: input.prompt,
      result: JSON.stringify(files),
      idempotencyKey: input.idempotencyKey,
      intent: input.intent || "runtime-snapshot",
      usedAutoRepair: false,
    },
    update: {
      prompt: input.prompt,
      result: JSON.stringify(files),
      intent: input.intent || "runtime-snapshot",
    },
  })
  const manifest = ProjectFilesystemService.buildManifest(files)
  return {
    historyId: history.id,
    files,
    manifest,
    fileHash: hashFiles(files),
  }
}

export async function rollbackToSnapshot(input: {
  projectId: string
  historyId: string
  reason: string
  jobId?: string | null
  trace?: TraceIds
}) {
  const history = await prisma.generationHistory.findFirst({
    where: {
      id: input.historyId,
      projectId: input.projectId,
    },
  })
  if (!history) {
    throw new Error(`Rollback snapshot not found: ${input.historyId}`)
  }

  const files = ProjectFilesystemService.normalizeFiles(safeJsonParse<GeneratedFile[]>(history.result, []))
  if (files.length === 0) {
    throw new Error(`Rollback snapshot ${input.historyId} contains no files`)
  }

  const result = await ProjectFilePersistenceService.saveGenerationSnapshot(
    input.projectId,
    `rollback:${input.reason}`,
    files,
    {
      idempotencyKey: `rollback:${input.historyId}:${createHash("sha256").update(input.reason).digest("hex").slice(0, 16)}`,
      intent: "runtime-rollback",
      generationJobId: input.jobId || undefined,
    }
  )

  if (input.jobId) {
    await OrchestrationRuntimeService.appendEvent({
      jobId: input.jobId,
      trace: input.trace,
      type: "snapshot_rollback_completed",
      stage: "repairing",
      status: "running",
      message: "Project files rolled back to last known-good snapshot",
      data: {
        sourceHistoryId: input.historyId,
        rollbackHistoryId: result.historyId,
        reason: input.reason,
        fileCount: result.files.length,
        manifest: result.manifest,
      },
    }).catch(() => null)
  }

  return result
}

export function recordGenerationStageTelemetry(input: {
  context: ExecutionTraceContext
  stage: string
  status: "started" | "passed" | "failed" | "skipped"
  durationMs?: number
  meta?: Record<string, unknown>
}) {
  return traceExecution(input.context, `generation_stage.${input.stage}.${input.status}`, {
    durationMs: input.durationMs,
    ...(input.meta || {}),
  })
}

export function recordRepairStageTelemetry(input: {
  context: ExecutionTraceContext
  stage: string
  attempt: number
  status: "started" | "passed" | "failed" | "stopped"
  durationMs?: number
  meta?: Record<string, unknown>
}) {
  return traceExecution(input.context, `repair_stage.${input.stage}.${input.status}`, {
    repairAttempt: input.attempt,
    durationMs: input.durationMs,
    ...(input.meta || {}),
  })
}

export async function getRuntimeHealthDashboard(windowHours = 24) {
  const since = subHours(new Date(), Math.min(168, Math.max(1, Math.round(windowHours))))
  const [
    jobsByStatus,
    failuresByType,
    repairsByStatus,
    previewSessionsByStatus,
    recentFailures,
  ] = await Promise.all([
    prisma.generationJob.groupBy({
      by: ["status"],
      where: { createdAt: { gte: since } },
      _count: { _all: true },
    }),
    prisma.orchestrationFailure.groupBy({
      by: ["eventType", "severity", "terminationReason"],
      where: { createdAt: { gte: since } },
      _count: { _all: true },
    }),
    prisma.repairAttempt.groupBy({
      by: ["status", "terminationReason"],
      where: { createdAt: { gte: since } },
      _count: { _all: true },
    }),
    prisma.previewSession.groupBy({
      by: ["status"],
      where: { createdAt: { gte: since } },
      _count: { _all: true },
    }),
    prisma.orchestrationFailure.findMany({
      where: { createdAt: { gte: since } },
      orderBy: { createdAt: "desc" },
      take: 12,
      select: {
        jobId: true,
        traceId: true,
        eventType: true,
        stage: true,
        severity: true,
        reason: true,
        terminationReason: true,
        createdAt: true,
      },
    }),
  ])

  const runtimeMetrics = getRuntimeMetricsSnapshot()
  const runtimeEvents = recentRuntimeEvents.slice(-50)
  const runtimeErrorCount = runtimeEvents.filter((event) => event.phase === "capture").length
  const blockedRepairLoops = runtimeEvents.filter((event) =>
    /repeated|max_repair|loop/i.test(String(event.metadata?.reason || event.metadata?.stopReason || ""))
  ).length

  return {
    since: since.toISOString(),
    status: runtimeErrorCount === 0 && blockedRepairLoops === 0 ? "healthy" : blockedRepairLoops > 0 ? "degraded" : "watching",
    jobsByStatus,
    failuresByType,
    repairsByStatus,
    previewSessionsByStatus,
    runtimeMetrics,
    recentRuntimeEvents: runtimeEvents,
    recentFailures: recentFailures.map((failure) => ({
      ...failure,
      createdAt: failure.createdAt.toISOString(),
    })),
    traces: getExecutionTraceSnapshot(),
    safeguards: {
      fullRegenerationAllowed: false,
      targetedRepairRequired: true,
      repeatedRepairLoopStop: true,
      snapshotRollbackEnabled: true,
    },
  }
}

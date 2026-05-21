import { mkdir, writeFile } from "node:fs/promises"
import path from "node:path"
import type { GeneratedFile } from "@/lib/types"
import type { GenerationJobStage } from "@/lib/services/generation-job.service"

export type GenerationState =
  | "PLANNING"
  | "GENERATING"
  | "VALIDATING"
  | "REPAIRING"
  | "BUILDING"
  | "STARTING_PREVIEW"
  | "READY"
  | "FAILED"

export type DeveloperDiagnosticLog = {
  stage: GenerationState
  status: "started" | "passed" | "failed" | "skipped" | "info"
  reason: string
  repairAttempt?: number
  at: string
  data?: Record<string, unknown>
}

export type DeveloperRepairAttempt = {
  attempt: number
  reason: string
  targetFiles?: string[]
  repairPromptPreview?: string
  repairedArtifactSummary?: Record<string, unknown>
  validatorResult?: Record<string, unknown>
  failedBecause?: string
}

export type DeveloperGenerationDiagnostics = {
  mode: "developer-diagnostics-v1"
  currentStage: GenerationState
  lastSuccessfulStage?: GenerationState | null
  terminationReason?: string | null
  retryCount: number
  plannerOutput?: Record<string, unknown>
  orchestrationDiagnostics?: Record<string, unknown>
  plannerConfidence?: number | null
  selectedArchetype?: string | null
  orchestrationModels?: {
    plannerModel?: string | null
    architectureModel?: string | null
    builderModel?: string | null
    repairModel?: string | null
    validatorModel?: string | null
    uiEnhancementModel?: string | null
  }
  repairPath?: Array<Record<string, unknown>>
  generatedArtifactSummary?: Record<string, unknown>
  validatorFailures: Array<Record<string, unknown>>
  artifactParseFailures: Array<Record<string, unknown>>
  repairAttempts: DeveloperRepairAttempt[]
  buildFailures: Array<Record<string, unknown>>
  previewStartupFailures: Array<Record<string, unknown>>
  executionTimeline: DeveloperDiagnosticLog[]
  activeRuntimeStage?: string | null
  retryMetrics: {
    retrySuccessRate: number
    averageRepairAttempts: number
    mostCommonValidatorFailure: string | null
    mostCommonSchemaFailure: string | null
  }
  reports: {
    lastInvalidArtifactPath?: string | null
  }
}

export function createDeveloperGenerationDiagnostics(): DeveloperGenerationDiagnostics {
  return {
    mode: "developer-diagnostics-v1",
    currentStage: "PLANNING",
    lastSuccessfulStage: null,
    terminationReason: null,
    retryCount: 0,
    plannerConfidence: null,
    selectedArchetype: null,
    repairPath: [],
    validatorFailures: [],
    artifactParseFailures: [],
    repairAttempts: [],
    buildFailures: [],
    previewStartupFailures: [],
    executionTimeline: [],
    activeRuntimeStage: null,
    retryMetrics: {
      retrySuccessRate: 0,
      averageRepairAttempts: 0,
      mostCommonValidatorFailure: null,
      mostCommonSchemaFailure: null,
    },
    reports: {},
  }
}

export function recordDeveloperDiagnostic(
  diagnostics: DeveloperGenerationDiagnostics,
  entry: Omit<DeveloperDiagnosticLog, "at">
) {
  diagnostics.currentStage = entry.stage
  diagnostics.activeRuntimeStage = entry.stage
  diagnostics.executionTimeline.push({
    ...entry,
    at: new Date().toISOString(),
    data: sanitizeDiagnosticData(entry.data),
  })
  diagnostics.executionTimeline = diagnostics.executionTimeline.slice(-80)
  if (entry.status === "passed") {
    diagnostics.lastSuccessfulStage = entry.stage
  }
  if (entry.stage === "FAILED" && entry.reason) {
    diagnostics.terminationReason = entry.reason
  }
  updateRetryMetrics(diagnostics)
}

export function summarizeGeneratedFiles(files: GeneratedFile[]) {
  return {
    fileCount: files.length,
    files: files.map((file) => ({
      path: file.path,
      language: file.language,
      bytes: Buffer.byteLength(String(file.content || ""), "utf8"),
    })).slice(0, 80),
  }
}

export function summarizeArtifactPayload(input: {
  files?: GeneratedFile[]
  dependencies?: string[]
  operations?: Array<{ action: string; path: string; reason?: string }>
}) {
  return {
    fileCount: input.files?.length || 0,
    dependencyCount: input.dependencies?.length || 0,
    operationCount: input.operations?.length || 0,
    files: input.files?.map((file) => file.path).slice(0, 80) || [],
    dependencies: input.dependencies?.slice(0, 40) || [],
    operations: input.operations?.map((operation) => ({
      action: operation.action,
      path: operation.path,
      reason: operation.reason || null,
    })).slice(0, 80) || [],
  }
}

export function stageStateFromJobStage(stage: GenerationJobStage | string): GenerationState {
  if (stage === "planning" || stage === "queued") return "PLANNING"
  if (stage === "generating" || stage === "scaffolding" || stage === "parsing") return "GENERATING"
  if (stage === "validating" || stage === "compiling") return "VALIDATING"
  if (stage === "repairing") return "REPAIRING"
  if (stage === "building") return "BUILDING"
  if (stage === "persisting" || stage === "saving") return "STARTING_PREVIEW"
  if (stage === "completed") return "READY"
  if (stage === "failed" || stage === "cancelled" || stage === "timeout") return "FAILED"
  return "PLANNING"
}

export async function persistInvalidArtifactReport(input: {
  jobId: string
  projectId: string
  payload: string
  parseFailure: string
  validatorDiagnostics?: unknown
  rejectedPaths?: string[]
  schemaMismatch?: string
}) {
  const root = path.join(process.cwd(), ".swift-reports", "failed-generations")
  const dir = path.join(root, safeSegment(input.jobId))
  await mkdir(dir, { recursive: true })
  const filePath = path.join(dir, "last-invalid-artifact.json")
  await writeFile(
    filePath,
    JSON.stringify({
      jobId: input.jobId,
      projectId: input.projectId,
      capturedAt: new Date().toISOString(),
      invalidPayload: input.payload.slice(0, 200_000),
      parseFailure: input.parseFailure,
      validatorDiagnostics: input.validatorDiagnostics || null,
      rejectedPaths: input.rejectedPaths || [],
      schemaMismatch: input.schemaMismatch || null,
    }, null, 2) + "\n",
    "utf8"
  )
  return filePath
}

function updateRetryMetrics(diagnostics: DeveloperGenerationDiagnostics) {
  const attempts = diagnostics.repairAttempts.length
  const successful = diagnostics.repairAttempts.filter((attempt) => attempt.validatorResult?.status === "passed").length
  diagnostics.retryCount = attempts
  diagnostics.retryMetrics = {
    retrySuccessRate: attempts === 0 ? 0 : Math.round((successful / attempts) * 1000) / 1000,
    averageRepairAttempts: attempts,
    mostCommonValidatorFailure: mostCommon(diagnostics.validatorFailures.map((failure) => String(failure.reason || failure.message || failure.step || ""))),
    mostCommonSchemaFailure: mostCommon(diagnostics.artifactParseFailures.map((failure) => String(failure.reason || failure.message || ""))),
  }
}

function mostCommon(values: string[]) {
  const counts = new Map<string, number>()
  for (const value of values.map((item) => item.trim()).filter(Boolean)) {
    counts.set(value, (counts.get(value) || 0) + 1)
  }
  return [...counts.entries()].sort((left, right) => right[1] - left[1])[0]?.[0] || null
}

function sanitizeDiagnosticData(data?: Record<string, unknown>) {
  if (!data) return undefined
  return JSON.parse(JSON.stringify(data, (_key, value) => {
    if (value instanceof Error) return value.message
    if (typeof value === "string") return value.slice(0, 6000)
    return value
  })) as Record<string, unknown>
}

function safeSegment(value: string) {
  return String(value || "unknown").replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 80) || "unknown"
}

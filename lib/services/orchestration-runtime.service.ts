import { createHash, randomUUID } from "node:crypto"
import { subHours, subMinutes } from "date-fns"
import { prisma } from "@/lib/db/client"
import { renderProviderPrometheusMetrics } from "@/lib/ai/provider-metrics"
import { renderDatabasePrometheusMetrics } from "@/lib/db/metrics"
import { log } from "@/lib/logging"
import { GenerationJobService, type GenerationJobStage, type GenerationJobStatus } from "@/lib/services/generation-job.service"

export type OrchestrationRecoveryState =
  | "queued"
  | "assigned"
  | "running"
  | "processing"
  | "recovering"
  | "retrying"
  | "stalled"
  | "orphaned"
  | "completed"
  | "failed"
  | "abandoned"
  | "cancelled"
  | "dead_lettered"
  | "terminated"

export type RetryClass =
  | "provider_transient"
  | "validation_retryable"
  | "sandbox_transient"
  | "worker_recovery"
  | "user_cancelled"
  | "terminal"
  | "unknown"

export type TraceIds = {
  traceId?: string | null
  spanId?: string | null
  parentSpanId?: string | null
  workerId?: string | null
  sandboxId?: string | null
  previewId?: string | null
}

const DEFAULT_LEASE_MS = 120_000
const DEFAULT_PREVIEW_TTL_MS = 30 * 60 * 1000
const STALE_SSE_MINUTES = 10
const ORPHANED_JOB_MINUTES = 5
export const MAX_JOB_RECOVERY_ATTEMPTS = 3
const TERMINAL_JOB_STATUSES: GenerationJobStatus[] = ["completed", "failed", "cancelled", "dead_lettered", "terminated"]

const RETRYABLE_RETRY_CLASSES = new Set<RetryClass>([
  "provider_transient",
  "sandbox_transient",
  "worker_recovery",
  "unknown",
])

const TERMINAL_RETRY_PATTERNS = [
  /invariant fatal/i,
  /security violation/i,
  /forbidden execution/i,
  /forbidden/i,
  /invalid auth/i,
  /unauthorized/i,
  /invalid prisma/i,
  /prisma.*schema/i,
]

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`
  const record = value as Record<string, unknown>
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
    .join(",")}}`
}

function safeStringify(value: unknown) {
  if (value === undefined) return undefined
  if (value === null) return null
  return JSON.stringify(value)
}

function parseJson(value?: string | null) {
  if (!value) return null
  try {
    return JSON.parse(value)
  } catch {
    return null
  }
}

function millisBucket(value: number, buckets: number[]) {
  for (const bucket of buckets) {
    if (value <= bucket) return bucket
  }
  return Number.POSITIVE_INFINITY
}

function hashPayload(value: unknown) {
  return createHash("sha256").update(stableStringify(value)).digest("hex")
}

function boundedRecord(value: unknown, maxBytes = 24_000) {
  const parsed = value && typeof value === "object" ? value as Record<string, unknown> : {}
  const serialized = stableStringify(parsed)
  if (Buffer.byteLength(serialized, "utf8") <= maxBytes) return parsed
  return {
    compressed: true,
    originalBytes: Buffer.byteLength(serialized, "utf8"),
    hash: hashPayload(parsed),
  }
}

function retryAllowed(retryClass: RetryClass, reason: string) {
  if (retryClass === "terminal" || retryClass === "user_cancelled") return false
  if (TERMINAL_RETRY_PATTERNS.some((pattern) => pattern.test(reason))) return false
  return RETRYABLE_RETRY_CLASSES.has(retryClass)
}

function asGenerationJobStage(value?: string | null): GenerationJobStage | undefined {
  const allowed = new Set<GenerationJobStage>([
    "queued",
    "planning",
    "scaffolding",
    "generating",
    "parsing",
    "validating",
    "building",
    "persisting",
    "saving",
    "compiling",
    "repairing",
    "completed",
    "failed",
    "cancelled",
    "timeout",
  ])
  return value && allowed.has(value as GenerationJobStage) ? value as GenerationJobStage : undefined
}

export function buildDurableOrchestrationSnapshot(input: {
  jobId: string
  orchestrationState: OrchestrationRecoveryState | string
  currentPhase?: string | null
  phaseDurations?: Record<string, unknown> | null
  replayHash?: string | null
  repairIterations?: number | null
  validationState?: Record<string, unknown> | null
  generationProgress?: number | null
  workerId?: string | null
  queueAttempt?: number | null
  recoveryState?: Record<string, unknown> | null
  lease?: Record<string, unknown> | null
}) {
  const snapshot = {
    jobId: input.jobId,
    orchestrationState: input.orchestrationState,
    currentPhase: input.currentPhase || null,
    phaseDurations: boundedRecord(input.phaseDurations || {}),
    replayHash: input.replayHash || null,
    repairIterations: Math.max(0, Number(input.repairIterations || 0)),
    validationState: boundedRecord(input.validationState || {}),
    generationProgress: Math.max(0, Math.min(100, Math.round(Number(input.generationProgress || 0)))),
    workerId: input.workerId || null,
    queueAttempt: Math.max(0, Number(input.queueAttempt || 0)),
    recoveryState: boundedRecord(input.recoveryState || {}),
    lease: boundedRecord(input.lease || {}),
  }
  return {
    ...snapshot,
    orchestrationStateHash: hashPayload({
      jobId: snapshot.jobId,
      orchestrationState: snapshot.orchestrationState,
      currentPhase: snapshot.currentPhase,
      replayHash: snapshot.replayHash,
      repairIterations: snapshot.repairIterations,
      validationState: snapshot.validationState,
      generationProgress: snapshot.generationProgress,
      queueAttempt: snapshot.queueAttempt,
      recoveryState: snapshot.recoveryState,
    }),
  }
}

export function classifyRetryReason(error: unknown, context?: { stage?: string | null; reason?: string | null }): RetryClass {
  const raw = `${context?.stage || ""} ${context?.reason || ""} ${error instanceof Error ? error.message : error ? String(error) : ""}`.toLowerCase()
  if (/cancel/.test(raw)) return "user_cancelled"
  if (/invariant fatal|security violation|forbidden execution|invalid auth|invalid prisma|unauthorized/.test(raw)) return "terminal"
  if (/rate limit|429|timeout|network|fetch failed|econnreset|etimedout|temporar/.test(raw)) return "provider_transient"
  if (/sandbox|preview|runtime smoke|build timed out/.test(raw)) return "sandbox_transient"
  if (/validation|validator|malformed|artifact|repair/.test(raw)) return "validation_retryable"
  if (/stalled|orphan|lease|worker/.test(raw)) return "worker_recovery"
  if (/max retries|dead_letter|forbidden|unauthorized|billing/.test(raw)) return "terminal"
  return "unknown"
}

export class OrchestrationRuntimeService {
  static newSpan(parentSpanId?: string | null) {
    return {
      spanId: randomUUID(),
      parentSpanId: parentSpanId || null,
    }
  }

  static async persistDurableState(input: {
    jobId: string
    orchestrationState: OrchestrationRecoveryState | string
    currentPhase?: string | null
    phaseDurations?: Record<string, unknown> | null
    replayHash?: string | null
    repairIterations?: number | null
    validationState?: Record<string, unknown> | null
    generationProgress?: number | null
    workerId?: string | null
    queueAttempt?: number | null
    recoveryState?: Record<string, unknown> | null
    lease?: Record<string, unknown> | null
    traceId?: string | null
  }) {
    const existing = await prisma.generationJob.findUnique({
      where: { id: input.jobId },
      select: {
        diagnosticsJson: true,
        metricsJson: true,
        stage: true,
        progress: true,
      },
    }).catch(() => null)
    if (!existing) return null

    const existingDiagnostics = parseJson(existing.diagnosticsJson) || {}
    const existingMetrics = parseJson(existing.metricsJson) || {}
    const existingDurable = existingDiagnostics && typeof existingDiagnostics === "object"
      ? (existingDiagnostics as Record<string, unknown>).durableOrchestration as Record<string, unknown> | undefined
      : undefined
    const metricsRecord = existingMetrics && typeof existingMetrics === "object" ? existingMetrics as Record<string, unknown> : {}
    const replayHash =
      input.replayHash ||
      (typeof metricsRecord.replayHash === "string" ? metricsRecord.replayHash : null) ||
      (typeof existingDurable?.replayHash === "string" ? existingDurable.replayHash : null)
    const phaseDurations =
      input.phaseDurations ||
      (metricsRecord.phaseDurations && typeof metricsRecord.phaseDurations === "object"
        ? metricsRecord.phaseDurations as Record<string, unknown>
        : null) ||
      (existingDurable?.phaseDurations && typeof existingDurable.phaseDurations === "object"
        ? existingDurable.phaseDurations as Record<string, unknown>
        : null)
    const snapshot = buildDurableOrchestrationSnapshot({
      jobId: input.jobId,
      orchestrationState: input.orchestrationState,
      currentPhase: input.currentPhase || existing.stage,
      phaseDurations,
      replayHash,
      repairIterations: input.repairIterations ?? Number(metricsRecord.repairIterations || 0),
      validationState: input.validationState || (metricsRecord.validationState as Record<string, unknown> | undefined) || null,
      generationProgress: input.generationProgress ?? existing.progress,
      workerId: input.workerId || null,
      queueAttempt: input.queueAttempt,
      recoveryState: input.recoveryState || (existingDurable?.recoveryState as Record<string, unknown> | undefined) || null,
      lease: input.lease || (existingDurable?.lease as Record<string, unknown> | undefined) || null,
    })
    const diagnostics = {
      ...(existingDiagnostics && typeof existingDiagnostics === "object" ? existingDiagnostics as Record<string, unknown> : {}),
      durableOrchestration: snapshot,
      progressStreaming: {
        ready: true,
        transports: ["polling", "sse"],
        eventStreamCompatible: true,
      },
    }

    const stage = asGenerationJobStage(input.currentPhase)
    await prisma.generationJob.updateMany({
      where: { id: input.jobId, status: { notIn: ["completed", "failed", "cancelled"] } },
      data: {
        orchestrationState: input.orchestrationState,
        ...(stage ? { stage } : {}),
        ...(typeof input.generationProgress === "number"
          ? { progress: Math.max(0, Math.min(100, Math.round(input.generationProgress))) }
          : {}),
        ...(input.workerId ? { workerId: input.workerId } : {}),
        ...(input.traceId ? { traceId: input.traceId } : {}),
        diagnosticsJson: safeStringify(diagnostics),
        version: { increment: 1 },
      },
    })
    return snapshot
  }

  static async appendEvent(input: {
    jobId: string
    type: string
    stage: GenerationJobStage
    status: GenerationJobStatus
    message: string
    trace?: TraceIds
    metadata?: Record<string, unknown> | null
    data?: Record<string, unknown> | null
    retryCount?: number
    terminationReason?: string | null
  }) {
    await GenerationJobService.appendEvent({
      jobId: input.jobId,
      type: input.type,
      eventType: input.type,
      stage: input.stage,
      status: input.status,
      message: input.message,
      data: input.data,
      metadata: input.metadata,
      retryCount: input.retryCount,
      terminationReason: input.terminationReason,
      traceId: input.trace?.traceId,
      spanId: input.trace?.spanId,
      parentSpanId: input.trace?.parentSpanId,
      workerId: input.trace?.workerId,
      sandboxId: input.trace?.sandboxId,
      previewId: input.trace?.previewId,
    })
  }

  static async persistFailure(input: {
    jobId: string
    eventType: string
    stage: string
    reason: string
    severity?: "warning" | "error" | "critical"
    retryCount?: number
    terminationReason?: string | null
    trace?: TraceIds
    metadata?: Record<string, unknown> | null
  }) {
    await prisma.orchestrationFailure.create({
      data: {
        jobId: input.jobId,
        traceId: input.trace?.traceId || null,
        workerId: input.trace?.workerId || null,
        eventType: input.eventType,
        stage: input.stage,
        severity: input.severity || "error",
        reason: input.reason,
        retryCount: Math.max(0, input.retryCount || 0),
        terminationReason: input.terminationReason || null,
        metadataJson: safeStringify(input.metadata),
      },
    })
  }

  static async acquireLease(input: {
    jobId: string
    workerId: string
    traceId?: string | null
    leaseMs?: number
    queueJobId?: string | number | null
    queueAttempt?: number | null
  }) {
    const now = new Date()
    const leaseExpiresAt = new Date(now.getTime() + Math.max(10_000, input.leaseMs || DEFAULT_LEASE_MS))
    const leaseId = `lease:${hashPayload({
      jobId: input.jobId,
      workerId: input.workerId,
      queueJobId: input.queueJobId || input.jobId,
    }).slice(0, 24)}`
    const result = await prisma.generationJob.updateMany({
      where: {
        id: input.jobId,
        status: { notIn: ["completed", "failed", "cancelled"] },
        OR: [
          { leaseOwner: null },
          { leaseOwner: input.workerId },
          { leaseExpiresAt: { lt: now } },
        ],
      },
      data: {
        orchestrationState: "assigned",
        status: "running",
        workerId: input.workerId,
        traceId: input.traceId || undefined,
        leaseOwner: input.workerId,
        leaseExpiresAt,
        lastHeartbeatAt: now,
        queueJobId: input.queueJobId ? String(input.queueJobId) : undefined,
        version: { increment: 1 },
      },
    })

    const acquired = result.count === 1
    if (acquired) {
      await this.persistDurableState({
        jobId: input.jobId,
        orchestrationState: "assigned",
        currentPhase: "queued",
        generationProgress: 1,
        workerId: input.workerId,
        queueAttempt: input.queueAttempt || 0,
        traceId: input.traceId || null,
        recoveryState: {
          state: "assigned",
          recoveryEligible: false,
        },
        lease: {
          workerId: input.workerId,
          leaseId,
          leaseExpiration: leaseExpiresAt.toISOString(),
          queueJobId: input.queueJobId || null,
        },
      }).catch(() => null)
    }
    await this.appendEvent({
      jobId: input.jobId,
      type: acquired ? "lease_acquired" : "lease_denied",
      stage: "queued",
      status: acquired ? "running" : "retrying",
      message: acquired ? "Worker lease acquired" : "Worker lease denied because another owner is active",
      trace: { traceId: input.traceId, workerId: input.workerId },
      metadata: { leaseId, leaseExpiresAt: leaseExpiresAt.toISOString(), queueJobId: input.queueJobId || null },
    }).catch(() => null)
    return acquired
  }

  static async renewLease(input: {
    jobId: string
    workerId: string
    currentStage?: string | null
    lastSuccessfulTransition?: string | null
    leaseMs?: number
  }) {
    const now = new Date()
    const leaseExpiresAt = new Date(now.getTime() + Math.max(10_000, input.leaseMs || DEFAULT_LEASE_MS))
    const updated = await prisma.generationJob.updateMany({
      where: {
        id: input.jobId,
        leaseOwner: input.workerId,
        status: { notIn: ["completed", "failed", "cancelled"] },
      },
      data: {
        workerId: input.workerId,
        leaseExpiresAt,
        lastHeartbeatAt: now,
        stage: input.currentStage || undefined,
        version: { increment: 1 },
      },
    })
    if (updated.count === 1) {
      await this.persistDurableState({
        jobId: input.jobId,
        orchestrationState: "running",
        currentPhase: input.currentStage || "generating",
        workerId: input.workerId,
        recoveryState: {
          state: "running",
          recoveryEligible: false,
          lastSuccessfulTransition: input.lastSuccessfulTransition || null,
        },
        lease: {
          workerId: input.workerId,
          leaseId: `lease:${hashPayload({ jobId: input.jobId, workerId: input.workerId }).slice(0, 24)}`,
          leaseExpiration: leaseExpiresAt.toISOString(),
        },
      }).catch(() => null)
    }
    return updated.count === 1
  }

  static async releaseLease(jobId: string, workerId: string, state: OrchestrationRecoveryState = "terminated") {
    const terminalRelease = await prisma.generationJob.updateMany({
      where: {
        id: jobId,
        leaseOwner: workerId,
        status: { in: TERMINAL_JOB_STATUSES },
      },
      data: {
        leaseOwner: null,
        leaseExpiresAt: null,
        lastHeartbeatAt: new Date(),
        version: { increment: 1 },
      },
    })
    if (terminalRelease.count > 0) return

    await prisma.generationJob.updateMany({
      where: {
        id: jobId,
        leaseOwner: workerId,
        status: { notIn: TERMINAL_JOB_STATUSES },
      },
      data: {
        orchestrationState: state,
        leaseOwner: null,
        leaseExpiresAt: null,
        lastHeartbeatAt: new Date(),
        version: { increment: 1 },
      },
    })
  }

  static async recordWorkerHeartbeat(input: {
    workerId: string
    traceId?: string | null
    currentJobId?: string | null
    currentStage?: string | null
    lastSuccessfulTransition?: string | null
    leaseOwner?: string | null
    leaseExpiresAt?: Date | string | null
    runtimeInfo?: Record<string, unknown>
    metadata?: Record<string, unknown>
  }) {
    const leaseExpiresAt = input.leaseExpiresAt
      ? typeof input.leaseExpiresAt === "string"
        ? new Date(input.leaseExpiresAt)
        : input.leaseExpiresAt
      : null
    await prisma.workerHeartbeat.upsert({
      where: { workerId: input.workerId },
      update: {
        traceId: input.traceId || null,
        currentJobId: input.currentJobId || null,
        currentStage: input.currentStage || null,
        lastSuccessfulTransition: input.lastSuccessfulTransition || null,
        leaseOwner: input.leaseOwner || null,
        leaseExpiresAt,
        runtimeInfoJson: safeStringify(input.runtimeInfo),
        metadataJson: safeStringify(input.metadata),
        heartbeatAt: new Date(),
      },
      create: {
        id: randomUUID(),
        workerId: input.workerId,
        traceId: input.traceId || null,
        currentJobId: input.currentJobId || null,
        currentStage: input.currentStage || null,
        lastSuccessfulTransition: input.lastSuccessfulTransition || null,
        leaseOwner: input.leaseOwner || null,
        leaseExpiresAt,
        runtimeInfoJson: safeStringify(input.runtimeInfo),
        metadataJson: safeStringify(input.metadata),
      },
    })
  }

  static async startRepairAttempt(input: {
    jobId: string
    attempt: number
    trace?: TraceIds
    reason?: string | null
    input?: unknown
    idempotencyKey?: string | null
    metadata?: Record<string, unknown> | null
  }) {
    return prisma.repairAttempt.upsert({
      where: {
        jobId_attempt: {
          jobId: input.jobId,
          attempt: input.attempt,
        },
      },
      update: {
        status: "running",
        reason: input.reason || null,
        traceId: input.trace?.traceId || null,
        spanId: input.trace?.spanId || null,
        workerId: input.trace?.workerId || null,
        inputHash: input.input === undefined ? undefined : hashPayload(input.input),
        idempotencyKey: input.idempotencyKey || null,
        metadataJson: safeStringify(input.metadata),
      },
      create: {
        jobId: input.jobId,
        traceId: input.trace?.traceId || null,
        spanId: input.trace?.spanId || null,
        workerId: input.trace?.workerId || null,
        attempt: input.attempt,
        status: "running",
        reason: input.reason || null,
        inputHash: input.input === undefined ? null : hashPayload(input.input),
        idempotencyKey: input.idempotencyKey || null,
        metadataJson: safeStringify(input.metadata),
      },
    })
  }

  static async finishRepairAttempt(input: {
    jobId: string
    attempt: number
    status: "succeeded" | "failed"
    terminationReason?: string | null
    validatorError?: string | null
    output?: unknown
    metadata?: Record<string, unknown> | null
  }) {
    await prisma.repairAttempt.updateMany({
      where: { jobId: input.jobId, attempt: input.attempt },
      data: {
        status: input.status,
        terminationReason: input.terminationReason || null,
        validatorError: input.validatorError || null,
        outputHash: input.output === undefined ? undefined : hashPayload(input.output),
        metadataJson: safeStringify(input.metadata),
        completedAt: new Date(),
      },
    })
  }

  static async upsertPreviewSession(input: {
    jobId: string
    projectId: string
    trace?: TraceIds
    status: string
    previewUrl?: string | null
    terminationReason?: string | null
    idempotencyKey?: string | null
    diagnostics?: Record<string, unknown> | null
    ttlMs?: number
    mark?: "boot" | "build_start" | "build_complete" | "dev_server_start" | "reachable" | "terminated"
  }) {
    const now = new Date()
    const expiresAt = new Date(now.getTime() + Math.max(60_000, input.ttlMs || DEFAULT_PREVIEW_TTL_MS))
    const markData = {
      ...(input.mark === "boot" ? { bootStartedAt: now } : {}),
      ...(input.mark === "build_start" ? { buildStartedAt: now } : {}),
      ...(input.mark === "build_complete" ? { buildCompletedAt: now } : {}),
      ...(input.mark === "dev_server_start" ? { devServerStartedAt: now } : {}),
      ...(input.mark === "reachable" ? { reachableAt: now } : {}),
      ...(input.mark === "terminated" ? { terminatedAt: now } : {}),
    }

    return prisma.previewSession.upsert({
      where: {
        jobId_idempotencyKey: {
          jobId: input.jobId,
          idempotencyKey: input.idempotencyKey || `preview:${input.jobId}`,
        },
      },
      update: {
        status: input.status,
        previewUrl: input.previewUrl || undefined,
        traceId: input.trace?.traceId || undefined,
        spanId: input.trace?.spanId || undefined,
        workerId: input.trace?.workerId || undefined,
        sandboxId: input.trace?.sandboxId || undefined,
        terminationReason: input.terminationReason || undefined,
        expiresAt,
        diagnosticsJson: safeStringify(input.diagnostics),
        ...markData,
      },
      create: {
        jobId: input.jobId,
        projectId: input.projectId,
        traceId: input.trace?.traceId || null,
        spanId: input.trace?.spanId || null,
        workerId: input.trace?.workerId || null,
        sandboxId: input.trace?.sandboxId || null,
        previewUrl: input.previewUrl || null,
        status: input.status,
        terminationReason: input.terminationReason || null,
        expiresAt,
        idempotencyKey: input.idempotencyKey || `preview:${input.jobId}`,
        diagnosticsJson: safeStringify(input.diagnostics),
        ...markData,
      },
    })
  }

  static async markDeadLettered(input: {
    jobId: string
    workerId?: string | null
    reason: string
    retryClass?: RetryClass
    metadata?: Record<string, unknown> | null
  }) {
    await prisma.generationJob.updateMany({
      where: { id: input.jobId },
      data: {
        orchestrationState: "dead_lettered",
        status: "dead_lettered",
        workerId: input.workerId || undefined,
        retryReason: input.reason,
        retryClass: input.retryClass || "terminal",
        deadLetteredAt: new Date(),
        terminatedAt: new Date(),
        leaseOwner: null,
        leaseExpiresAt: null,
        version: { increment: 1 },
      },
    })
    await this.persistFailure({
      jobId: input.jobId,
      trace: { workerId: input.workerId || null },
      eventType: "dead_lettered",
      stage: "dead_lettered",
      severity: "critical",
      reason: input.reason,
      terminationReason: "dead_lettered",
      metadata: input.metadata,
    })
  }

  static async recoverOrphanedJobs(limit = 25) {
    const now = new Date()
    const recoveryStartedAt = Date.now()
    const orphanCutoff = subMinutes(now, ORPHANED_JOB_MINUTES)
    const expired = await prisma.generationJob.findMany({
      where: {
        status: { in: ["queued", "running", "processing", "retrying", "stalled", "orphaned"] },
        OR: [
          { leaseExpiresAt: { lt: now } },
          { lastHeartbeatAt: { lt: orphanCutoff } },
        ],
      },
      take: limit,
      orderBy: { updatedAt: "asc" },
    })

    let recovered = 0
    let abandoned = 0
    let retryContained = 0
    for (const job of expired) {
      const recoveryReason = job.leaseExpiresAt && job.leaseExpiresAt < now ? "lease_expired" : "heartbeat_stale"
      const retryClass = classifyRetryReason(null, { stage: job.stage, reason: recoveryReason })
      const nextRecoveryCount = job.recoveryCount + 1
      const canRetry = retryAllowed(retryClass, [recoveryReason, job.retryReason || "", job.error || ""].join(" "))
      const shouldDeadLetter = !canRetry || nextRecoveryCount > MAX_JOB_RECOVERY_ATTEMPTS
      const recoveryDurationMs = Date.now() - recoveryStartedAt
      if (shouldDeadLetter) abandoned += 1
      else recovered += 1
      if (!canRetry) retryContained += 1
      await prisma.generationJob.update({
        where: { id: job.id },
        data: shouldDeadLetter
          ? {
              status: "dead_lettered",
              orchestrationState: "abandoned",
              retryReason: recoveryReason,
              retryClass,
              recoveryCount: nextRecoveryCount,
              deadLetteredAt: now,
              terminatedAt: now,
              leaseOwner: null,
              leaseExpiresAt: null,
            }
          : {
              status: "retrying",
              orchestrationState: "recovering",
              retryReason: recoveryReason,
              retryClass,
              recoveryCount: nextRecoveryCount,
              leaseOwner: null,
              leaseExpiresAt: null,
            },
      })
      await this.persistDurableState({
        jobId: job.id,
        orchestrationState: shouldDeadLetter ? "abandoned" : "recovering",
        currentPhase: job.stage,
        generationProgress: job.progress,
        workerId: job.workerId,
        queueAttempt: nextRecoveryCount,
        recoveryState: {
          retryAttempt: nextRecoveryCount,
          recoveryReason,
          restoredCheckpoint: Boolean(job.metricsJson || job.contextJson || job.planJson),
          recoveryDurationMs,
          recoveryEligible: !shouldDeadLetter,
          retryContained: !canRetry,
          previousLeaseOwner: job.leaseOwner,
          previousLeaseExpiresAt: job.leaseExpiresAt?.toISOString() || null,
        },
      }).catch(() => null)
      await this.appendEvent({
        jobId: job.id,
        type: shouldDeadLetter ? "job.abandoned" : "job.recovering",
        stage: shouldDeadLetter ? "failed" : "queued",
        status: shouldDeadLetter ? "dead_lettered" : "retrying",
        message: shouldDeadLetter
          ? "Recovery boundary reached; job abandoned without unsafe retry"
          : "Expired lease marked job recoverable from durable checkpoint",
        trace: { traceId: job.traceId, workerId: job.workerId },
        retryCount: nextRecoveryCount,
        terminationReason: shouldDeadLetter ? recoveryReason : null,
        metadata: {
          previousLeaseOwner: job.leaseOwner,
          previousLeaseExpiresAt: job.leaseExpiresAt?.toISOString() || null,
          retryClass,
          retryAttempt: nextRecoveryCount,
          recoveryReason,
          restoredCheckpoint: Boolean(job.metricsJson || job.contextJson || job.planJson),
          recoveryDurationMs,
          maxJobRecoveryAttempts: MAX_JOB_RECOVERY_ATTEMPTS,
        },
      }).catch(() => null)
    }

    return { inspected: expired.length, recovered, abandoned, retryContained, maxJobRecoveryAttempts: MAX_JOB_RECOVERY_ATTEMPTS }
  }

  static async reconcileQueueState(limit = 50) {
    const now = new Date()
    const staleCutoff = subMinutes(now, ORPHANED_JOB_MINUTES)
    const [stuckJobs, duplicateJobs, zombieWorkers, orphanLeases, abandonedCheckpoints] = await Promise.all([
      prisma.generationJob.findMany({
        where: {
          status: { in: ["queued", "running", "processing", "retrying", "stalled", "orphaned"] },
          updatedAt: { lt: staleCutoff },
        },
        take: limit,
        orderBy: { updatedAt: "asc" },
      }),
      prisma.generationJob.groupBy({
        by: ["idempotencyKey"],
        where: {
          idempotencyKey: { not: null },
          status: { in: ["queued", "running", "processing", "retrying"] },
        },
        _count: { _all: true },
        having: { idempotencyKey: { _count: { gt: 1 } } },
      }).catch(() => []),
      prisma.workerHeartbeat.findMany({
        where: { heartbeatAt: { lt: staleCutoff } },
        take: limit,
        orderBy: { heartbeatAt: "asc" },
      }),
      prisma.generationJob.findMany({
        where: {
          leaseOwner: { not: null },
          leaseExpiresAt: { lt: now },
          status: { notIn: ["completed", "failed", "cancelled"] },
        },
        take: limit,
      }),
      prisma.generationJob.count({
        where: {
          orchestrationState: { in: ["recovering", "orphaned", "stalled"] },
          updatedAt: { lt: staleCutoff },
        },
      }),
    ])

    const recovery = await this.recoverOrphanedJobs(Math.min(limit, Math.max(stuckJobs.length, orphanLeases.length, 1)))
    for (const worker of zombieWorkers) {
      if (!worker.currentJobId) continue
      await this.persistFailure({
        jobId: worker.currentJobId,
        eventType: "worker_unhealthy",
        stage: worker.currentStage || "unknown",
        severity: "warning",
        reason: "Worker heartbeat is stale and eligible for recovery reconciliation",
        trace: { traceId: worker.traceId, workerId: worker.workerId },
        metadata: {
          workerId: worker.workerId,
          heartbeatAt: worker.heartbeatAt.toISOString(),
          currentJobId: worker.currentJobId,
        },
      }).catch(() => null)
    }

    return {
      checkedAt: now.toISOString(),
      stuckJobs: stuckJobs.length,
      duplicateJobs: duplicateJobs.reduce((sum, item) => sum + item._count._all, 0),
      zombieWorkers: zombieWorkers.length,
      orphanLeases: orphanLeases.length,
      abandonedCheckpoints,
      cleanup: recovery,
    }
  }

  static async cleanupExpiredLifecycle() {
    const now = new Date()
    const staleSseCutoff = subMinutes(now, STALE_SSE_MINUTES)
    const expiredPreview = await prisma.previewSession.updateMany({
      where: {
        status: { in: ["starting", "running", "ready"] },
        expiresAt: { lt: now },
      },
      data: {
        status: "terminated",
        terminatedAt: now,
        terminationReason: "ttl_expired",
      },
    })
    const orphanedArtifacts = await prisma.artifact.updateMany({
      where: {
        status: "candidate",
        generationJobId: null,
        generationHistoryId: null,
        createdAt: { lt: subHours(now, 24) },
      },
      data: { status: "orphaned" },
    })
    log("info", "orchestration_cleanup_completed", {
      expiredPreviewSessions: expiredPreview.count,
      staleSseCutoff: staleSseCutoff.toISOString(),
      orphanedArtifacts: orphanedArtifacts.count,
    })
    return {
      expiredPreviewSessions: expiredPreview.count,
      staleSseCutoff: staleSseCutoff.toISOString(),
      orphanedArtifacts: orphanedArtifacts.count,
    }
  }

  static async replay(jobId: string) {
    const [job, events, repairs, previews, failures] = await Promise.all([
      prisma.generationJob.findUnique({ where: { id: jobId } }),
      prisma.generationEvent.findMany({ where: { jobId }, orderBy: { sequence: "asc" } }),
      prisma.repairAttempt.findMany({ where: { jobId }, orderBy: { attempt: "asc" } }),
      prisma.previewSession.findMany({ where: { jobId }, orderBy: { createdAt: "asc" } }),
      prisma.orchestrationFailure.findMany({ where: { jobId }, orderBy: { createdAt: "asc" } }),
    ])

    return {
      job,
      timeline: events.map((event) => ({
        id: event.id,
        sequence: event.sequence,
        type: event.eventType || event.type,
        stage: event.stage,
        status: event.status,
        message: event.message,
        traceId: event.traceId,
        spanId: event.spanId,
        parentSpanId: event.parentSpanId,
        workerId: event.workerId,
        sandboxId: event.sandboxId,
        previewId: event.previewId,
        retryCount: event.retryCount,
        terminationReason: event.terminationReason,
        metadata: parseJson(event.metadataJson),
        data: parseJson(event.dataJson),
        createdAt: event.createdAt.toISOString(),
      })),
      repairs: repairs.map((attempt) => ({
        ...attempt,
        metadata: parseJson(attempt.metadataJson),
      })),
      previews: previews.map((preview) => ({
        ...preview,
        diagnostics: parseJson(preview.diagnosticsJson),
      })),
      failures: failures.map((failure) => ({
        ...failure,
        metadata: parseJson(failure.metadataJson),
      })),
    }
  }

  static async getStatus(jobId: string) {
    const job = await prisma.generationJob.findUnique({
      where: { id: jobId },
      select: {
        id: true,
        status: true,
        orchestrationState: true,
        stage: true,
        progress: true,
        queueJobId: true,
        createdAt: true,
        startedAt: true,
        updatedAt: true,
        diagnosticsJson: true,
        metricsJson: true,
        retryReason: true,
        retryClass: true,
        recoveryCount: true,
        workerId: true,
        leaseOwner: true,
        leaseExpiresAt: true,
        lastHeartbeatAt: true,
      },
    })
    if (!job) return null

    const diagnostics = parseJson(job.diagnosticsJson) as Record<string, unknown> | null
    const metrics = parseJson(job.metricsJson) as Record<string, unknown> | null
    const durable = diagnostics?.durableOrchestration && typeof diagnostics.durableOrchestration === "object"
      ? diagnostics.durableOrchestration as Record<string, unknown>
      : null
    const replayHash =
      typeof durable?.replayHash === "string"
        ? durable.replayHash
        : typeof metrics?.replayHash === "string"
          ? metrics.replayHash
          : null
    const recoveryState = durable?.recoveryState && typeof durable.recoveryState === "object"
      ? durable.recoveryState
      : {
          retryAttempt: job.recoveryCount,
          recoveryReason: job.retryReason,
          retryClass: job.retryClass,
        }
    const queuePosition = job.status === "queued" ? 0 : null
    const estimatedWaitMs = job.status === "queued"
      ? Math.max(0, Date.now() - job.createdAt.getTime())
      : null

    return {
      status: job.status,
      currentPhase: job.stage,
      progressPct: job.progress,
      queuePosition,
      estimatedWaitMs,
      replayHash,
      recoveryState,
      orchestrationState: job.orchestrationState,
      worker: {
        workerId: job.workerId,
        leaseOwner: job.leaseOwner,
        leaseExpiration: job.leaseExpiresAt?.toISOString() || null,
        heartbeatAt: job.lastHeartbeatAt?.toISOString() || null,
        heartbeatAgeMs: job.lastHeartbeatAt ? Date.now() - job.lastHeartbeatAt.getTime() : null,
      },
      durability: {
        durableStatePresent: Boolean(durable),
        orchestrationStateHash: typeof durable?.orchestrationStateHash === "string" ? durable.orchestrationStateHash : null,
        progressStreamingReady: Boolean(diagnostics?.progressStreaming),
      },
      timestamps: {
        createdAt: job.createdAt.toISOString(),
        startedAt: job.startedAt?.toISOString() || null,
        updatedAt: job.updatedAt.toISOString(),
      },
    }
  }

  static async getWorkerPressure(windowHours = 1) {
    const since = subHours(new Date(), Math.max(1, Math.min(24, Math.round(windowHours))))
    const [workers, recoveryEvents, retryEvents, dequeuedEvents] = await Promise.all([
      prisma.workerHeartbeat.findMany({
        where: { heartbeatAt: { gte: since } },
        select: { workerId: true, currentJobId: true, heartbeatAt: true },
      }),
      prisma.orchestrationFailure.count({
        where: {
          createdAt: { gte: since },
          eventType: { in: ["worker_stalled", "worker_unhealthy", "worker_timeout"] },
        },
      }),
      prisma.generationJob.count({
        where: {
          updatedAt: { gte: since },
          status: { in: ["retrying", "dead_lettered"] },
        },
      }),
      prisma.generationEvent.findMany({
        where: { createdAt: { gte: since }, type: "lease_acquired" },
        select: { createdAt: true, metadataJson: true },
      }),
    ])
    const activeWorkers = new Set(workers.map((worker) => worker.workerId)).size
    const busyWorkers = new Set(workers.filter((worker) => worker.currentJobId).map((worker) => worker.workerId)).size
    const workerUtilization = activeWorkers === 0 ? 0 : Math.round((busyWorkers / activeWorkers) * 1000) / 10
    const averageDequeueLatency = dequeuedEvents.length === 0 ? 0 : Math.round(
      dequeuedEvents
        .map((event) => {
          const metadata = parseJson(event.metadataJson) as Record<string, unknown> | null
          const queuedAt = typeof metadata?.queuedAt === "string" ? Date.parse(metadata.queuedAt) : 0
          return queuedAt > 0 ? Math.max(0, event.createdAt.getTime() - queuedAt) : 0
        })
        .reduce((sum, value) => sum + value, 0) / dequeuedEvents.length
    )

    const recommendedWorkerCount = Math.max(1, Math.ceil(Math.max(busyWorkers, 1) * Math.max(1, workerUtilization / 75)))
    return {
      activeWorkers,
      busyWorkers,
      workerUtilization,
      queueGrowthRate: 0,
      averageDequeueLatency,
      recoveryFrequency: recoveryEvents,
      retryFrequency: retryEvents,
      scalingRecommendation: {
        recommendedWorkerCount,
        saturationTrend: workerUtilization >= 90 ? "rising" : workerUtilization >= 70 ? "watch" : "stable",
        projectedBacklogMinutes: averageDequeueLatency > 0 ? Math.round(averageDequeueLatency / 60_000) : 0,
      },
    }
  }

  static async prometheusMetrics() {
    const since = subHours(new Date(), 24)
    const [
      jobStatus,
      quality,
      repairStatus,
      repairReasons,
      previewStatus,
      workerHeartbeats,
      failures,
      sseDisconnects,
    ] = await Promise.all([
      prisma.generationJob.groupBy({ by: ["status"], where: { createdAt: { gte: since } }, _count: { _all: true } }),
      prisma.generationQualityMetric.findMany({ where: { createdAt: { gte: since } }, select: { status: true, repairSucceeded: true, repairAttempts: true, totalLatencyMs: true, validationLatencyMs: true } }),
      prisma.repairAttempt.groupBy({ by: ["status"], where: { createdAt: { gte: since } }, _count: { _all: true } }),
      prisma.repairAttempt.groupBy({ by: ["terminationReason"], where: { createdAt: { gte: since }, terminationReason: { not: null } }, _count: { _all: true } }),
      prisma.previewSession.groupBy({ by: ["status"], where: { createdAt: { gte: since } }, _count: { _all: true } }),
      prisma.workerHeartbeat.findMany({ where: { heartbeatAt: { gte: since } }, select: { workerId: true, heartbeatAt: true, currentStage: true } }),
      prisma.orchestrationFailure.groupBy({ by: ["eventType", "severity"], where: { createdAt: { gte: since } }, _count: { _all: true } }),
      prisma.generationEvent.count({ where: { type: "stream_terminated", createdAt: { gte: since } } }),
    ])

    const lines: string[] = []
    const metric = (name: string, labels: Record<string, string>, value: number) => {
      const labelText = Object.entries(labels)
        .map(([key, item]) => `${key}="${String(item).replace(/"/g, '\\"')}"`)
        .join(",")
      lines.push(`${name}{${labelText}} ${value}`)
    }

    for (const item of jobStatus) metric("swift_generation_jobs_total", { status: item.status }, item._count._all)
    for (const item of repairStatus) metric("swift_repair_attempts_total", { status: item.status }, item._count._all)
    for (const item of repairReasons) metric("swift_repair_termination_total", { reason: item.terminationReason || "unknown" }, item._count._all)
    for (const item of previewStatus) metric("swift_preview_sessions_total", { status: item.status }, item._count._all)
    for (const item of failures) metric("swift_orchestration_failures_total", { event_type: item.eventType, severity: item.severity }, item._count._all)
    metric("swift_sse_disconnects_total", { window: "24h" }, sseDisconnects)

    const successCount = quality.filter((item) => item.status === "completed").length
    const totalQuality = quality.length
    metric("swift_generation_success_ratio", { window: "24h" }, totalQuality === 0 ? 0 : successCount / totalQuality)
    const repairSuccessCount = quality.filter((item) => item.repairSucceeded).length
    metric("swift_repair_success_ratio", { window: "24h" }, totalQuality === 0 ? 0 : repairSuccessCount / totalQuality)
    for (const item of quality) {
      metric("swift_generation_latency_ms_bucket", { le: String(millisBucket(item.totalLatencyMs, [5000, 15000, 30000, 60000, 120000, 300000])) }, 1)
      metric("swift_repair_retry_count", { status: item.status }, item.repairAttempts)
    }
    for (const heartbeat of workerHeartbeats) {
      metric("swift_worker_heartbeat_age_ms", { worker_id: heartbeat.workerId, stage: heartbeat.currentStage || "unknown" }, Date.now() - heartbeat.heartbeatAt.getTime())
    }

    lines.push(renderProviderPrometheusMetrics())
    lines.push(renderDatabasePrometheusMetrics())
    return `${lines.join("\n")}\n`
  }
}

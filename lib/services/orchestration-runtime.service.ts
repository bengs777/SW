import { createHash, randomUUID } from "node:crypto"
import { subHours, subMinutes } from "date-fns"
import { prisma } from "@/lib/db/client"
import { renderProviderPrometheusMetrics } from "@/lib/ai/provider-metrics"
import { renderDatabasePrometheusMetrics } from "@/lib/db/metrics"
import { log } from "@/lib/logging"
import { GenerationJobService, type GenerationJobStage, type GenerationJobStatus } from "@/lib/services/generation-job.service"

export type OrchestrationRecoveryState =
  | "queued"
  | "processing"
  | "retrying"
  | "stalled"
  | "orphaned"
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
  return createHash("sha256").update(JSON.stringify(value)).digest("hex")
}

export function classifyRetryReason(error: unknown, context?: { stage?: string | null; reason?: string | null }): RetryClass {
  const raw = `${context?.stage || ""} ${context?.reason || ""} ${error instanceof Error ? error.message : error ? String(error) : ""}`.toLowerCase()
  if (/cancel/.test(raw)) return "user_cancelled"
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
  }) {
    const now = new Date()
    const leaseExpiresAt = new Date(now.getTime() + Math.max(10_000, input.leaseMs || DEFAULT_LEASE_MS))
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
        orchestrationState: "processing",
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
    await this.appendEvent({
      jobId: input.jobId,
      type: acquired ? "lease_acquired" : "lease_denied",
      stage: "queued",
      status: acquired ? "running" : "retrying",
      message: acquired ? "Worker lease acquired" : "Worker lease denied because another owner is active",
      trace: { traceId: input.traceId, workerId: input.workerId },
      metadata: { leaseExpiresAt: leaseExpiresAt.toISOString(), queueJobId: input.queueJobId || null },
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
    return updated.count === 1
  }

  static async releaseLease(jobId: string, workerId: string, state: OrchestrationRecoveryState = "terminated") {
    await prisma.generationJob.updateMany({
      where: { id: jobId, leaseOwner: workerId },
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

    for (const job of expired) {
      const retryClass = classifyRetryReason(null, { stage: job.stage, reason: "lease_expired" })
      const nextRecoveryCount = job.recoveryCount + 1
      const shouldDeadLetter = nextRecoveryCount > Math.max(1, job.maxRetries)
      await prisma.generationJob.update({
        where: { id: job.id },
        data: shouldDeadLetter
          ? {
              status: "dead_lettered",
              orchestrationState: "dead_lettered",
              retryReason: "lease_expired",
              retryClass,
              recoveryCount: nextRecoveryCount,
              deadLetteredAt: now,
              terminatedAt: now,
              leaseOwner: null,
              leaseExpiresAt: null,
            }
          : {
              status: "retrying",
              orchestrationState: "orphaned",
              retryReason: "lease_expired",
              retryClass,
              recoveryCount: nextRecoveryCount,
              leaseOwner: null,
              leaseExpiresAt: null,
            },
      })
      await this.appendEvent({
        jobId: job.id,
        type: shouldDeadLetter ? "job.dead_lettered" : "job.orphaned",
        stage: shouldDeadLetter ? "failed" : "queued",
        status: shouldDeadLetter ? "dead_lettered" : "retrying",
        message: shouldDeadLetter ? "Expired lease exceeded recovery limit" : "Expired lease marked job orphaned for safe retry",
        trace: { traceId: job.traceId, workerId: job.workerId },
        retryCount: nextRecoveryCount,
        terminationReason: shouldDeadLetter ? "lease_expired" : null,
        metadata: {
          previousLeaseOwner: job.leaseOwner,
          previousLeaseExpiresAt: job.leaseExpiresAt?.toISOString() || null,
          retryClass,
        },
      }).catch(() => null)
    }

    return { inspected: expired.length, recovered: expired.filter((job) => job.recoveryCount + 1 <= Math.max(1, job.maxRetries)).length }
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

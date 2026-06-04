import { Prisma } from "@prisma/client"
import { publicGenerationRuntimeErrorMessage } from "@/lib/ai/runtime-contracts"
import { prisma } from "@/lib/db/client"

export const GENERATION_TERMINAL_STATUSES = new Set(["completed", "failed", "cancelled"])

export type GenerationJobStage =
  | "queued"
  | "planning"
  | "scaffolding"
  | "generating"
  | "parsing"
  | "validating"
  | "building"
  | "persisting"
  | "saving"
  | "compiling"
  | "repairing"
  | "completed"
  | "failed"
  | "cancelled"
  | "timeout"

export type GenerationJobStatus =
  | "queued"
  | "processing"
  | "retrying"
  | "stalled"
  | "orphaned"
  | "dead_lettered"
  | "terminated"
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "cancelling"

type CreateGenerationJobInput = {
  userId: string
  projectId: string
  prompt: string
  model: string
  provider?: string
  intent?: string | null
  usedAutoRepair?: boolean
  idempotencyKey?: string | null
  requestHash?: string | null
  plan?: unknown
  maxRetries?: number
  context?: Record<string, unknown> | null
}

type UpdateGenerationJobInput = {
  status?: GenerationJobStatus
  orchestrationState?: string
  stage?: GenerationJobStage
  label?: string
  progress?: number
  retryCount?: number
  attemptCount?: number
  plan?: unknown
  context?: Record<string, unknown> | null
  diagnostics?: Record<string, unknown> | null
  metrics?: Record<string, unknown> | null
  intent?: string | null
  usedAutoRepair?: boolean
  previewUrl?: string | null
  error?: string | null
  resultHistoryId?: string | null
  queueJobId?: string | null
  traceId?: string | null
  workerId?: string | null
  leaseOwner?: string | null
  leaseExpiresAt?: Date | null
  lastHeartbeatAt?: Date | null
  retryReason?: string | null
  retryClass?: string | null
  recoveryCount?: number
  deadLetteredAt?: Date | null
  terminatedAt?: Date | null
  cancelRequested?: boolean
  cancelReason?: string | null
  startedAt?: Date | null
  completedAt?: Date | null
  cancelledAt?: Date | null
  failedAt?: Date | null
  timedOutAt?: Date | null
}

type AppendGenerationEventInput = {
  jobId: string
  traceId?: string | null
  spanId?: string | null
  parentSpanId?: string | null
  workerId?: string | null
  sandboxId?: string | null
  previewId?: string | null
  type: string
  eventType?: string | null
  stage: GenerationJobStage
  status: GenerationJobStatus
  message: string
  data?: Record<string, unknown> | null
  metadata?: Record<string, unknown> | null
  retryCount?: number
  terminationReason?: string | null
}

export class GenerationJobCancelledError extends Error {
  constructor() {
    super("GENERATION_JOB_CANCELLED")
    this.name = "GenerationJobCancelledError"
  }
}

function safeStringify(value: unknown) {
  if (value === undefined) return undefined
  if (value === null) return null
  return JSON.stringify(value)
}

async function nextEventSequence(tx: Prisma.TransactionClient, jobId: string) {
  const aggregate = await tx.generationEvent.aggregate({
    where: { jobId },
    _max: { sequence: true },
  })

  return (aggregate._max.sequence || 0) + 1
}

function isDuplicateGenerationEventSequenceError(error: unknown) {
  const target = error instanceof Prisma.PrismaClientKnownRequestError
    ? error.meta?.target
    : null
  const targetText = Array.isArray(target) ? target.map(String).join(",") : String(target || "")

  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === "P2002" &&
    /jobId/i.test(targetText) &&
    /sequence/i.test(targetText)
  )
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

type PublicGenerationFailureKind =
  | "provider_timeout"
  | "provider_exhausted"
  | "worker_timeout"
  | "dead_lettered"
  | "sandbox_build_failed"
  | "missing_fullstack_category"
  | "event_log_race"
  | "insufficient_balance"
  | "unknown"

function publicFailureSummary(input: {
  status: string
  label: string
  error?: string | null
  diagnosticsJson?: string | null
  retryReason?: string | null
  retryClass?: string | null
  deadLetteredAt?: Date | null
}) {
  const diagnostics = safeJsonParse(input.diagnosticsJson) as Record<string, unknown> | null
  const orchestrationSummary = diagnostics?.orchestrationSummary && typeof diagnostics.orchestrationSummary === "object"
    ? diagnostics.orchestrationSummary as Record<string, unknown>
    : null
  const messages = [
    input.error,
    input.label,
    input.retryReason,
    input.retryClass,
    typeof diagnostics?.message === "string" ? diagnostics.message : null,
    typeof diagnostics?.publicMessage === "string" ? diagnostics.publicMessage : null,
    typeof orchestrationSummary?.reason === "string" ? orchestrationSummary.reason : null,
    typeof orchestrationSummary?.lastValidatorMessage === "string" ? orchestrationSummary.lastValidatorMessage : null,
    typeof orchestrationSummary?.repairTerminationReason === "string" ? orchestrationSummary.repairTerminationReason : null,
  ].filter(Boolean).join("\n")
  const kind = classifyPublicFailureKind({
    status: input.status,
    deadLetteredAt: input.deadLetteredAt,
    message: messages,
  })
  const label = publicGenerationRuntimeErrorMessage(messages || input.error || input.label)
  const retryHint = retryHintForFailureKind(kind)

  return {
    kind,
    label,
    retryHint,
  }
}

function classifyPublicFailureKind(input: {
  status: string
  deadLetteredAt?: Date | null
  message: string
}): PublicGenerationFailureKind {
  const raw = input.message

  if (input.status === "dead_lettered" || input.deadLetteredAt || /dead[-\s]?letter/i.test(raw)) {
    return "dead_lettered"
  }
  if (/Unique constraint failed[\s\S]*jobId[\s\S]*sequence|P2002[\s\S]*sequence/i.test(raw)) {
    return "event_log_race"
  }
  if (/Missing required full-stack categories|missingCategories|full-stack categories/i.test(raw)) {
    return "missing_fullstack_category"
  }
  if (/insufficient balance|not enough balance|saldo tidak cukup|saldo.*kurang|can only afford/i.test(raw)) {
    return "insufficient_balance"
  }
  if (/SWIFT_AI_PROVIDER_FAILOVER_EXHAUSTED|provider failover exhausted|model chain exhausted/i.test(raw)) {
    return "provider_exhausted"
  }
  if (/Provider request budget exceeded|OpenRouter request timed out|request_timeout|provider.*timeout|timed out.*provider/i.test(raw)) {
    return "provider_timeout"
  }
  if (/Generation timed out after|worker_timeout|worker.*timeout|timeout.*worker/i.test(raw)) {
    return "worker_timeout"
  }
  if (/sandbox|npm run build|build failed|preview.*failed|runtime-smoke|compile failed/i.test(raw)) {
    return "sandbox_build_failed"
  }

  return "unknown"
}

function retryHintForFailureKind(kind: PublicGenerationFailureKind) {
  switch (kind) {
    case "provider_timeout":
      return "Coba retry dengan prompt lebih kecil atau tunggu provider lebih stabil."
    case "provider_exhausted":
      return "Retry aman setelah model fallback/env OpenRouter sehat."
    case "worker_timeout":
      return "Pastikan worker generation memakai timeout production terbaru, lalu retry."
    case "dead_lettered":
      return "Audit dead-letter dulu; replay hanya job yang masih valid."
    case "sandbox_build_failed":
      return "Buka Logs sandbox untuk melihat gagal install, build, atau runtime preview."
    case "missing_fullstack_category":
      return "Retry dengan scope bertahap agar UI, API, data, dan config dibuat lengkap."
    case "event_log_race":
      return "Retry aman setelah patch event sequence aktif di worker terbaru."
    case "insufficient_balance":
      return "Isi saldo atau kurangi output token/prompt sebelum retry."
    default:
      return "Buka Logs untuk detail, lalu retry setelah worker, provider, dan sandbox sehat."
  }
}

export class GenerationJobService {
  static async create(input: CreateGenerationJobInput) {
    return prisma.$transaction(async (tx) => {
      const job = await tx.generationJob.create({
        data: {
          userId: input.userId,
          projectId: input.projectId,
          prompt: input.prompt,
          model: input.model,
          provider: input.provider || "swift",
          intent: input.intent || null,
          usedAutoRepair: Boolean(input.usedAutoRepair),
          idempotencyKey: input.idempotencyKey || null,
          requestHash: input.requestHash || null,
          status: "queued",
          orchestrationState: "queued",
          stage: "queued",
          label: "Prompt diterima",
          progress: 0,
          maxRetries: Math.max(0, input.maxRetries ?? 2),
          planJson: safeStringify(input.plan),
          contextJson: safeStringify(input.context),
        },
      })

      await tx.generationEvent.create({
        data: {
          jobId: job.id,
          sequence: 1,
          type: "job.created",
          eventType: "job.created",
          stage: "queued",
          status: "queued",
          message: "Generation job queued",
          dataJson: safeStringify({
            projectId: job.projectId,
            provider: job.provider,
            model: job.model,
          }),
        },
      })

      return job
    })
  }

  static async attachQueueJob(jobId: string, queueJobId: string) {
    return this.update(jobId, {
      queueJobId,
    })
  }

  static async findForUser(jobId: string, userId: string) {
    return prisma.generationJob.findFirst({
      where: {
        id: jobId,
        userId,
      },
    })
  }

  static async findById(jobId: string) {
    return prisma.generationJob.findUnique({
      where: { id: jobId },
    })
  }

  static async findIdempotentJob(input: {
    userId: string
    projectId: string
    idempotencyKey?: string | null
    requestHash?: string | null
  }) {
    const clauses = [
      input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : null,
      input.requestHash ? { requestHash: input.requestHash } : null,
    ].filter((clause): clause is { idempotencyKey: string } | { requestHash: string } => Boolean(clause))

    if (clauses.length === 0) return null

    return prisma.generationJob.findFirst({
      where: {
        userId: input.userId,
        projectId: input.projectId,
        OR: clauses,
      },
      orderBy: { createdAt: "desc" },
    })
  }

  static async countActiveForUser(userId: string) {
    return prisma.generationJob.count({
      where: {
        userId,
        status: {
          in: ["queued", "running", "processing", "retrying", "stalled", "orphaned", "cancelling"],
        },
      },
    })
  }

  static async listEvents(jobId: string, afterSequence = 0) {
    return prisma.generationEvent.findMany({
      where: {
        jobId,
        sequence: { gt: afterSequence },
      },
      orderBy: { sequence: "asc" },
    })
  }

  static async appendEvent(input: AppendGenerationEventInput) {
    const maxAttempts = 3

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        return await prisma.$transaction(async (tx) => {
          const sequence = await nextEventSequence(tx, input.jobId)
          return tx.generationEvent.create({
            data: {
              jobId: input.jobId,
              traceId: input.traceId || null,
              spanId: input.spanId || null,
              parentSpanId: input.parentSpanId || null,
              workerId: input.workerId || null,
              sandboxId: input.sandboxId || null,
              previewId: input.previewId || null,
              sequence,
              type: input.type,
              eventType: input.eventType || input.type,
              stage: input.stage,
              status: input.status,
              message: input.message,
              dataJson: safeStringify(input.data),
              metadataJson: safeStringify(input.metadata),
              retryCount: Math.max(0, input.retryCount || 0),
              terminationReason: input.terminationReason || null,
            },
          })
        })
      } catch (error) {
        if (!isDuplicateGenerationEventSequenceError(error) || attempt === maxAttempts) {
          throw error
        }

        await sleep(25 * attempt)
      }
    }

    throw new Error("Failed to append generation event")
  }

  static async update(jobId: string | null | undefined, input: UpdateGenerationJobInput) {
    if (!jobId) return null

    const existing = await prisma.generationJob.findUnique({
      where: { id: jobId },
      select: { version: true, status: true, cancelRequested: true },
    })
    if (!existing) return null
    if (GENERATION_TERMINAL_STATUSES.has(existing.status)) return null

    const requestedStatus = input.status
    if (
      existing.cancelRequested &&
      requestedStatus &&
      requestedStatus !== "cancelled" &&
      requestedStatus !== "cancelling"
    ) {
      return null
    }

    return prisma.generationJob.updateMany({
      where: { id: jobId, version: existing.version },
      data: {
        ...(input.status ? { status: input.status } : {}),
        ...(input.orchestrationState ? { orchestrationState: input.orchestrationState } : {}),
        ...(input.stage ? { stage: input.stage } : {}),
        ...(input.label ? { label: input.label } : {}),
        ...(typeof input.progress === "number"
          ? { progress: Math.max(0, Math.min(100, Math.round(input.progress))) }
          : {}),
        ...(typeof input.retryCount === "number" ? { retryCount: Math.max(0, input.retryCount) } : {}),
        ...(typeof input.attemptCount === "number" ? { attemptCount: Math.max(0, input.attemptCount) } : {}),
        ...(input.plan !== undefined ? { planJson: safeStringify(input.plan) } : {}),
        ...(input.context !== undefined ? { contextJson: safeStringify(input.context) } : {}),
        ...(input.diagnostics !== undefined ? { diagnosticsJson: safeStringify(input.diagnostics) } : {}),
        ...(input.metrics !== undefined ? { metricsJson: safeStringify(input.metrics) } : {}),
        ...(input.intent !== undefined ? { intent: input.intent } : {}),
        ...(input.usedAutoRepair !== undefined ? { usedAutoRepair: input.usedAutoRepair } : {}),
        ...(input.previewUrl !== undefined ? { previewUrl: input.previewUrl } : {}),
        ...(input.error !== undefined ? { error: input.error } : {}),
        ...(input.resultHistoryId !== undefined ? { resultHistoryId: input.resultHistoryId } : {}),
        ...(input.queueJobId !== undefined ? { queueJobId: input.queueJobId } : {}),
        ...(input.traceId !== undefined ? { traceId: input.traceId } : {}),
        ...(input.workerId !== undefined ? { workerId: input.workerId } : {}),
        ...(input.leaseOwner !== undefined ? { leaseOwner: input.leaseOwner } : {}),
        ...(input.leaseExpiresAt !== undefined ? { leaseExpiresAt: input.leaseExpiresAt } : {}),
        ...(input.lastHeartbeatAt !== undefined ? { lastHeartbeatAt: input.lastHeartbeatAt } : {}),
        ...(input.retryReason !== undefined ? { retryReason: input.retryReason } : {}),
        ...(input.retryClass !== undefined ? { retryClass: input.retryClass } : {}),
        ...(typeof input.recoveryCount === "number" ? { recoveryCount: Math.max(0, input.recoveryCount) } : {}),
        ...(input.deadLetteredAt !== undefined ? { deadLetteredAt: input.deadLetteredAt } : {}),
        ...(input.terminatedAt !== undefined ? { terminatedAt: input.terminatedAt } : {}),
        ...(typeof input.cancelRequested === "boolean" ? { cancelRequested: input.cancelRequested } : {}),
        ...(input.cancelReason !== undefined ? { cancelReason: input.cancelReason } : {}),
        ...(input.startedAt !== undefined ? { startedAt: input.startedAt } : {}),
        ...(input.completedAt !== undefined ? { completedAt: input.completedAt } : {}),
        ...(input.cancelledAt !== undefined ? { cancelledAt: input.cancelledAt } : {}),
        ...(input.failedAt !== undefined ? { failedAt: input.failedAt } : {}),
        ...(input.timedOutAt !== undefined ? { timedOutAt: input.timedOutAt } : {}),
        version: { increment: 1 },
      },
    })
  }

  static async transition(
    jobId: string,
    input: UpdateGenerationJobInput & {
      type: string
      message: string
      data?: Record<string, unknown> | null
      metadata?: Record<string, unknown> | null
      eventType?: string | null
      traceId?: string | null
      spanId?: string | null
      parentSpanId?: string | null
      workerId?: string | null
      sandboxId?: string | null
      previewId?: string | null
      terminationReason?: string | null
    }
  ) {
    const stage = input.stage || "queued"
    const status = input.status || "queued"

    let updated = await this.update(jobId, input)
    if (!updated?.count) {
      const fresh = await this.findById(jobId)
      const requestedStatus = input.status
      const shouldRetryTerminalUpdate =
        requestedStatus
          ? (
              GENERATION_TERMINAL_STATUSES.has(requestedStatus) &&
              fresh &&
              !GENERATION_TERMINAL_STATUSES.has(fresh.status) &&
              !fresh.cancelRequested
            )
          : false

      if (!shouldRetryTerminalUpdate) {
        return fresh
      }

      updated = await this.update(jobId, input)
      if (!updated?.count) {
        return this.findById(jobId)
      }
    }

    await this.appendEvent({
      jobId,
      type: input.type,
      eventType: input.eventType,
      traceId: input.traceId,
      spanId: input.spanId,
      parentSpanId: input.parentSpanId,
      workerId: input.workerId,
      sandboxId: input.sandboxId,
      previewId: input.previewId,
      stage,
      status,
      message: input.message,
      data: input.data,
      metadata: input.metadata,
      retryCount: input.retryCount,
      terminationReason: input.terminationReason,
    })
    return this.findById(jobId)
  }

  static async markRunning(jobId: string, label = "Generation started") {
    return this.transition(jobId, {
      type: "job.started",
      status: "running",
      orchestrationState: "processing",
      stage: "generating",
      label,
      progress: 5,
      startedAt: new Date(),
      message: label,
    })
  }

  static async markCompleted(jobId: string, resultHistoryId?: string | null, previewUrl?: string | null) {
    return this.transition(jobId, {
      type: "job.completed",
      status: "completed",
      orchestrationState: "terminated",
      stage: "completed",
      label: "Generation completed",
      progress: 100,
      resultHistoryId: resultHistoryId || null,
      previewUrl: previewUrl || null,
      completedAt: new Date(),
      terminatedAt: new Date(),
      message: "Generation completed",
    })
  }

  static async markFailed(jobId: string, error: string, stage: GenerationJobStage = "failed") {
    return this.transition(jobId, {
      type: "job.failed",
      status: "failed",
      orchestrationState: "terminated",
      stage,
      label: "Generation failed",
      progress: 100,
      error,
      failedAt: new Date(),
      terminatedAt: new Date(),
      message: error,
    })
  }

  static async markCancelled(jobId: string, reason = "Generation cancelled") {
    return this.transition(jobId, {
      type: "job.cancelled",
      status: "cancelled",
      orchestrationState: "terminated",
      stage: "cancelled",
      label: reason,
      progress: 100,
      cancelRequested: true,
      cancelReason: reason,
      cancelledAt: new Date(),
      terminatedAt: new Date(),
      message: reason,
    })
  }

  static async requestCancel(jobId: string, reason = "User requested cancellation") {
    return this.transition(jobId, {
      type: "job.cancellation_requested",
      status: "cancelling",
      orchestrationState: "processing",
      stage: "cancelled",
      label: "Cancelling generation",
      cancelRequested: true,
      cancelReason: reason,
      message: reason,
    })
  }

  static async assertNotCancelled(jobId: string | null | undefined) {
    if (!jobId) return

    const job = await prisma.generationJob.findUnique({
      where: { id: jobId },
      select: { cancelRequested: true, status: true },
    })

    if (job?.cancelRequested || job?.status === "cancelled" || job?.status === "cancelling") {
      throw new GenerationJobCancelledError()
    }
  }

  static async startAttempt(input: {
    jobId: string
    provider: string
    model: string
    purpose: string
    metadata?: Record<string, unknown>
  }) {
    const aggregate = await prisma.generationAttempt.aggregate({
      where: { jobId: input.jobId },
      _max: { sequence: true },
    })
    const sequence = (aggregate._max.sequence || 0) + 1

    return prisma.generationAttempt.create({
      data: {
        jobId: input.jobId,
        sequence,
        provider: input.provider,
        model: input.model,
        purpose: input.purpose,
        status: "running",
        metadataJson: safeStringify(input.metadata),
      },
    })
  }

  static async finishAttempt(input: {
    jobId: string
    sequence: number
    status: "completed" | "failed" | "cancelled"
    latencyMs: number
    promptTokens?: number
    completionTokens?: number
    totalTokens?: number
    error?: string | null
    metadata?: Record<string, unknown>
  }) {
    return prisma.generationAttempt.updateMany({
      where: {
        jobId: input.jobId,
        sequence: input.sequence,
      },
      data: {
        status: input.status,
        completedAt: new Date(),
        latencyMs: Math.max(0, Math.round(input.latencyMs)),
        promptTokens: Math.max(0, input.promptTokens || 0),
        completionTokens: Math.max(0, input.completionTokens || 0),
        totalTokens: Math.max(0, input.totalTokens || 0),
        error: input.error || null,
        metadataJson: safeStringify(input.metadata),
      },
    })
  }

  static toPublicJob(job: {
    id: string
    projectId: string
    prompt: string
    model: string
    provider: string
    intent?: string | null
    usedAutoRepair?: boolean
    status: string
    orchestrationState?: string
    stage: string
    label: string
    progress: number
    version: number
    retryCount: number
    maxRetries: number
    attemptCount: number
    traceId?: string | null
    workerId?: string | null
    leaseOwner?: string | null
    leaseExpiresAt?: Date | null
    lastHeartbeatAt?: Date | null
    retryReason?: string | null
    retryClass?: string | null
    recoveryCount?: number
    deadLetteredAt?: Date | null
    terminatedAt?: Date | null
    planJson?: string | null
    diagnosticsJson?: string | null
    previewUrl?: string | null
    error?: string | null
    resultHistoryId?: string | null
    cancelRequested: boolean
    idempotencyKey?: string | null
    requestHash?: string | null
    createdAt: Date
    updatedAt: Date
    startedAt?: Date | null
    completedAt?: Date | null
    cancelledAt?: Date | null
    failedAt?: Date | null
    timedOutAt?: Date | null
  }) {
    const publicFailure = publicFailureSummary({
      status: job.status,
      label: job.label,
      error: job.error,
      diagnosticsJson: job.diagnosticsJson,
      retryReason: job.retryReason,
      retryClass: job.retryClass,
      deadLetteredAt: job.deadLetteredAt,
    })

    return {
      id: job.id,
      projectId: job.projectId,
      prompt: job.prompt,
      model: job.model,
      provider: job.provider,
      intent: job.intent || null,
      usedAutoRepair: Boolean(job.usedAutoRepair),
      status: job.status,
      orchestrationState: job.orchestrationState || job.status,
      stage: job.stage,
      label: job.label,
      progress: job.progress,
      version: job.version,
      retryCount: job.retryCount,
      maxRetries: job.maxRetries,
      attemptCount: job.attemptCount,
      traceId: job.traceId || null,
      workerId: job.workerId || null,
      leaseOwner: job.leaseOwner || null,
      leaseExpiresAt: job.leaseExpiresAt?.toISOString() || null,
      lastHeartbeatAt: job.lastHeartbeatAt?.toISOString() || null,
      retryReason: job.retryReason || null,
      retryClass: job.retryClass || null,
      recoveryCount: job.recoveryCount || 0,
      deadLetteredAt: job.deadLetteredAt?.toISOString() || null,
      terminatedAt: job.terminatedAt?.toISOString() || null,
      plan: parsePlan(job.planJson),
      stagedFullStack: parseStagedFullStack(job.planJson),
      previewUrl: job.previewUrl || null,
      error: job.error || null,
      publicFailure,
      resultHistoryId: job.resultHistoryId || null,
      cancelRequested: job.cancelRequested,
      createdAt: job.createdAt.toISOString(),
      updatedAt: job.updatedAt.toISOString(),
      startedAt: job.startedAt?.toISOString() || null,
      completedAt: job.completedAt?.toISOString() || null,
      cancelledAt: job.cancelledAt?.toISOString() || null,
      failedAt: job.failedAt?.toISOString() || null,
      timedOutAt: job.timedOutAt?.toISOString() || null,
    }
  }

  static toDeveloperDiagnostics(job: {
    diagnosticsJson?: string | null
    metricsJson?: string | null
    planJson?: string | null
    contextJson?: string | null
    traceId?: string | null
    workerId?: string | null
    leaseOwner?: string | null
    leaseExpiresAt?: Date | null
    lastHeartbeatAt?: Date | null
    retryReason?: string | null
    retryClass?: string | null
    recoveryCount?: number
    stage: string
    status: string
    orchestrationState?: string
    retryCount: number
    attemptCount: number
  }) {
    return {
      stage: job.stage,
      status: job.status,
      orchestrationState: job.orchestrationState || job.status,
      retryCount: job.retryCount,
      attemptCount: job.attemptCount,
      trace: {
        traceId: job.traceId || null,
        workerId: job.workerId || null,
        leaseOwner: job.leaseOwner || null,
        leaseExpiresAt: job.leaseExpiresAt?.toISOString() || null,
        lastHeartbeatAt: job.lastHeartbeatAt?.toISOString() || null,
      },
      recovery: {
        retryReason: job.retryReason || null,
        retryClass: job.retryClass || null,
        recoveryCount: job.recoveryCount || 0,
      },
      plan: safeJsonParse(job.planJson),
      context: safeJsonParse(job.contextJson),
      diagnostics: stripRawStacks(safeJsonParse(job.diagnosticsJson)),
      metrics: safeJsonParse(job.metricsJson),
    }
  }
}

function parsePlan(value?: string | null) {
  if (!value) return []

  try {
    const parsed = JSON.parse(value)
    if (Array.isArray(parsed)) {
      return parsed.filter((item): item is string => typeof item === "string")
    }

    if (parsed && typeof parsed === "object") {
      return Object.values(parsed).flatMap((item) => {
        if (typeof item === "string") return [item]
        if (Array.isArray(item)) {
          return item.filter((entry): entry is string => typeof entry === "string")
        }
        return []
      })
    }
  } catch {
    return []
  }

  return []
}

function parseStagedFullStack(value?: string | null) {
  const parsed = safeJsonParse(value)
  if (!parsed || typeof parsed !== "object") return null
  const staged = (parsed as { stagedFullStack?: unknown }).stagedFullStack
  if (!staged || typeof staged !== "object") return null
  const record = staged as {
    enabled?: unknown
    currentPass?: unknown
    reason?: unknown
    nextSteps?: unknown
  }
  if (record.enabled !== true) return null

  return {
    currentPass: typeof record.currentPass === "string" ? record.currentPass : "baseline_deployable",
    reason: typeof record.reason === "string" ? record.reason : "Large full-stack request is running as a staged baseline first.",
    nextSteps: Array.isArray(record.nextSteps)
      ? record.nextSteps.filter((item): item is string => typeof item === "string").slice(0, 6)
      : [],
  }
}

function safeJsonParse(value?: string | null) {
  if (!value) return null
  try {
    return JSON.parse(value)
  } catch {
    return null
  }
}

function stripRawStacks(value: unknown): unknown {
  if (!value || typeof value !== "object") return value
  if (Array.isArray(value)) return value.map(stripRawStacks)
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([key]) => key !== "stack")
      .map(([key, item]) => [key, stripRawStacks(item)])
  )
}

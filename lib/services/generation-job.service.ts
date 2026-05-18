import type { Prisma } from "@prisma/client"
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
  idempotencyKey?: string | null
  requestHash?: string | null
  plan?: unknown
  maxRetries?: number
  context?: Record<string, unknown> | null
}

type UpdateGenerationJobInput = {
  status?: GenerationJobStatus
  stage?: GenerationJobStage
  label?: string
  progress?: number
  retryCount?: number
  attemptCount?: number
  plan?: unknown
  context?: Record<string, unknown> | null
  diagnostics?: Record<string, unknown> | null
  metrics?: Record<string, unknown> | null
  previewUrl?: string | null
  error?: string | null
  resultHistoryId?: string | null
  queueJobId?: string | null
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
  type: string
  stage: GenerationJobStage
  status: GenerationJobStatus
  message: string
  data?: Record<string, unknown> | null
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
          idempotencyKey: input.idempotencyKey || null,
          requestHash: input.requestHash || null,
          status: "queued",
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
          in: ["queued", "running", "cancelling"],
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
    return prisma.$transaction(async (tx) => {
      const sequence = await nextEventSequence(tx, input.jobId)
      return tx.generationEvent.create({
        data: {
          jobId: input.jobId,
          sequence,
          type: input.type,
          stage: input.stage,
          status: input.status,
          message: input.message,
          dataJson: safeStringify(input.data),
        },
      })
    })
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
        ...(input.previewUrl !== undefined ? { previewUrl: input.previewUrl } : {}),
        ...(input.error !== undefined ? { error: input.error } : {}),
        ...(input.resultHistoryId !== undefined ? { resultHistoryId: input.resultHistoryId } : {}),
        ...(input.queueJobId !== undefined ? { queueJobId: input.queueJobId } : {}),
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
    }
  ) {
    const stage = input.stage || "queued"
    const status = input.status || "queued"

    const updated = await this.update(jobId, input)
    if (!updated?.count) {
      return this.findById(jobId)
    }

    await this.appendEvent({
      jobId,
      type: input.type,
      stage,
      status,
      message: input.message,
      data: input.data,
    })

    return this.findById(jobId)
  }

  static async markRunning(jobId: string, label = "Generation started") {
    return this.transition(jobId, {
      type: "job.started",
      status: "running",
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
      stage: "completed",
      label: "Generation completed",
      progress: 100,
      resultHistoryId: resultHistoryId || null,
      previewUrl: previewUrl || null,
      completedAt: new Date(),
      message: "Generation completed",
    })
  }

  static async markFailed(jobId: string, error: string, stage: GenerationJobStage = "failed") {
    return this.transition(jobId, {
      type: "job.failed",
      status: "failed",
      stage,
      label: "Generation failed",
      progress: 100,
      error,
      failedAt: new Date(),
      message: error,
    })
  }

  static async markCancelled(jobId: string, reason = "Generation cancelled") {
    return this.transition(jobId, {
      type: "job.cancelled",
      status: "cancelled",
      stage: "cancelled",
      label: reason,
      progress: 100,
      cancelRequested: true,
      cancelReason: reason,
      cancelledAt: new Date(),
      message: reason,
    })
  }

  static async requestCancel(jobId: string, reason = "User requested cancellation") {
    return this.transition(jobId, {
      type: "job.cancellation_requested",
      status: "cancelling",
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
    status: string
    stage: string
    label: string
    progress: number
    version: number
    retryCount: number
    maxRetries: number
    attemptCount: number
    planJson?: string | null
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
    return {
      id: job.id,
      projectId: job.projectId,
      prompt: job.prompt,
      model: job.model,
      provider: job.provider,
      status: job.status,
      stage: job.stage,
      label: job.label,
      progress: job.progress,
      version: job.version,
      retryCount: job.retryCount,
      maxRetries: job.maxRetries,
      attemptCount: job.attemptCount,
      plan: parsePlan(job.planJson),
      previewUrl: job.previewUrl || null,
      error: job.error || null,
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

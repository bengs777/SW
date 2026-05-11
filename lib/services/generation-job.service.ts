import { prisma } from "@/lib/db/client"

export type GenerationJobStage =
  | "queued"
  | "context"
  | "request"
  | "provider"
  | "parse"
  | "validate"
  | "save"
  | "preview"
  | "completed"
  | "failed"
  | "cancelled"

type UpdateGenerationJobInput = {
  status?: string
  stage?: GenerationJobStage
  label?: string
  progress?: number
  plan?: unknown
  error?: string | null
  resultHistoryId?: string | null
  cancelRequested?: boolean
  cancelReason?: string | null
  startedAt?: Date | null
  completedAt?: Date | null
  cancelledAt?: Date | null
  failedAt?: Date | null
}

export class GenerationJobCancelledError extends Error {
  constructor() {
    super("GENERATION_JOB_CANCELLED")
    this.name = "GenerationJobCancelledError"
  }
}

export class GenerationJobService {
  static async create(input: {
    userId: string
    projectId: string
    prompt: string
    model: string
    provider?: string
    plan?: unknown
  }) {
    return prisma.generationJob.create({
      data: {
        userId: input.userId,
        projectId: input.projectId,
        prompt: input.prompt,
        model: input.model,
        provider: input.provider || "swift",
        status: "queued",
        stage: "queued",
        label: "Prompt diterima",
        progress: 3,
        planJson: input.plan ? JSON.stringify(input.plan) : undefined,
      },
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

  static async update(jobId: string | null | undefined, input: UpdateGenerationJobInput) {
    if (!jobId) return null

    return prisma.generationJob.update({
      where: { id: jobId },
      data: {
        ...(input.status ? { status: input.status } : {}),
        ...(input.stage ? { stage: input.stage } : {}),
        ...(input.label ? { label: input.label } : {}),
        ...(typeof input.progress === "number" ? { progress: Math.max(0, Math.min(100, input.progress)) } : {}),
        ...(input.plan ? { planJson: JSON.stringify(input.plan) } : {}),
        ...(input.error !== undefined ? { error: input.error } : {}),
        ...(input.resultHistoryId !== undefined ? { resultHistoryId: input.resultHistoryId } : {}),
        ...(typeof input.cancelRequested === "boolean" ? { cancelRequested: input.cancelRequested } : {}),
        ...(input.cancelReason !== undefined ? { cancelReason: input.cancelReason } : {}),
        ...(input.startedAt !== undefined ? { startedAt: input.startedAt } : {}),
        ...(input.completedAt !== undefined ? { completedAt: input.completedAt } : {}),
        ...(input.cancelledAt !== undefined ? { cancelledAt: input.cancelledAt } : {}),
        ...(input.failedAt !== undefined ? { failedAt: input.failedAt } : {}),
      },
    }).catch(() => null)
  }

  static async markRunning(jobId: string | null | undefined, label = "Swift mulai memproses prompt") {
    return this.update(jobId, {
      status: "running",
      stage: "context",
      label,
      progress: 8,
      startedAt: new Date(),
    })
  }

  static async markCompleted(jobId: string | null | undefined, resultHistoryId?: string | null) {
    return this.update(jobId, {
      status: "completed",
      stage: "completed",
      label: "Generate selesai",
      progress: 100,
      resultHistoryId: resultHistoryId || null,
      completedAt: new Date(),
    })
  }

  static async markFailed(jobId: string | null | undefined, error: string) {
    return this.update(jobId, {
      status: "failed",
      stage: "failed",
      label: "Generate gagal",
      progress: 100,
      error,
      failedAt: new Date(),
    })
  }

  static async requestCancel(jobId: string, reason = "User requested cancellation") {
    return this.update(jobId, {
      status: "cancelling",
      stage: "cancelled",
      label: "Menghentikan generate...",
      cancelRequested: true,
      cancelReason: reason,
    })
  }

  static async markCancelled(jobId: string | null | undefined, reason = "Generate dihentikan") {
    return this.update(jobId, {
      status: "cancelled",
      stage: "cancelled",
      label: reason,
      progress: 100,
      cancelRequested: true,
      cancelReason: reason,
      cancelledAt: new Date(),
    })
  }

  static async assertNotCancelled(jobId: string | null | undefined) {
    if (!jobId) return

    const job = await prisma.generationJob.findUnique({
      where: { id: jobId },
      select: { cancelRequested: true, status: true },
    })

    if (job?.cancelRequested || job?.status === "cancelled") {
      throw new GenerationJobCancelledError()
    }
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
    planJson?: string | null
    error?: string | null
    cancelRequested: boolean
    createdAt: Date
    updatedAt: Date
    startedAt?: Date | null
    completedAt?: Date | null
    cancelledAt?: Date | null
    failedAt?: Date | null
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
      plan: parsePlan(job.planJson),
      error: job.error,
      cancelRequested: job.cancelRequested,
      createdAt: job.createdAt.toISOString(),
      updatedAt: job.updatedAt.toISOString(),
      startedAt: job.startedAt?.toISOString() || null,
      completedAt: job.completedAt?.toISOString() || null,
      cancelledAt: job.cancelledAt?.toISOString() || null,
      failedAt: job.failedAt?.toISOString() || null,
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
      const plan = parsed as {
        objective?: unknown
        focusSlice?: unknown
        filePriority?: unknown
        previewChecks?: unknown
        repairLoop?: unknown
      }
      return [
        typeof plan.objective === "string" ? plan.objective : "",
        typeof plan.focusSlice === "string" ? plan.focusSlice : "",
        ...(Array.isArray(plan.filePriority) ? plan.filePriority : []),
        ...(Array.isArray(plan.previewChecks) ? plan.previewChecks : []),
        ...(Array.isArray(plan.repairLoop) ? plan.repairLoop : []),
      ].filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    }

    return []
  } catch {
    return []
  }
}

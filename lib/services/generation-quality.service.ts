import { prisma } from "@/lib/db/client"
import { log } from "@/lib/logging"

export type GenerationQualityStage =
  | "intent-analysis"
  | "app-classification"
  | "architecture-planning"
  | "dependency-planning"
  | "file-graph-planning"
  | "code-generation"
  | "static-validation"
  | "preview-compile"
  | "typecheck"
  | "lint"
  | "build"
  | "runtime-smoke"
  | "repair"
  | "persistence"
  | "deploy"
  | "unknown"

export type GenerationQualitySummaryInput = {
  jobId: string
  userId: string
  projectId: string
  appType: string
  status: "completed" | "failed" | "cancelled"
  failureStage?: GenerationQualityStage | string | null
  failureCode?: string | null
  buildPassed?: boolean
  runtimePassed?: boolean
  repairSucceeded?: boolean
  deployValidated?: boolean
  repairAttempts?: number
  userRetryCount?: number
  providerLatencyMs?: number
  validationLatencyMs?: number
  totalLatencyMs?: number
  promptTokens?: number
  completionTokens?: number
  totalTokens?: number
  estimatedCost?: number
  metadata?: Record<string, unknown> | null
}

function safeStringify(value: unknown) {
  if (value === undefined) return undefined
  if (value === null) return null
  return JSON.stringify(value)
}

export class GenerationQualityService {
  static async recordSummary(input: GenerationQualitySummaryInput) {
    const data = {
      userId: input.userId,
      projectId: input.projectId,
      appType: input.appType,
      status: input.status,
      failureStage: input.failureStage || null,
      failureCode: input.failureCode || null,
      buildPassed: Boolean(input.buildPassed),
      runtimePassed: Boolean(input.runtimePassed),
      repairSucceeded: Boolean(input.repairSucceeded),
      deployValidated: Boolean(input.deployValidated),
      repairAttempts: Math.max(0, input.repairAttempts || 0),
      userRetryCount: Math.max(0, input.userRetryCount || 0),
      providerLatencyMs: Math.max(0, Math.round(input.providerLatencyMs || 0)),
      validationLatencyMs: Math.max(0, Math.round(input.validationLatencyMs || 0)),
      totalLatencyMs: Math.max(0, Math.round(input.totalLatencyMs || 0)),
      promptTokens: Math.max(0, input.promptTokens || 0),
      completionTokens: Math.max(0, input.completionTokens || 0),
      totalTokens: Math.max(0, input.totalTokens || 0),
      estimatedCost: Math.max(0, input.estimatedCost || 0),
      metadataJson: safeStringify(input.metadata),
    }

    const metric = await prisma.generationQualityMetric.upsert({
      where: { jobId: input.jobId },
      create: {
        jobId: input.jobId,
        ...data,
      },
      update: data,
    })

    log("info", "Generation quality metric recorded", {
      jobId: input.jobId,
      projectId: input.projectId,
      appType: input.appType,
      status: input.status,
      failureStage: input.failureStage || null,
      buildPassed: data.buildPassed,
      runtimePassed: data.runtimePassed,
      repairAttempts: data.repairAttempts,
      totalLatencyMs: data.totalLatencyMs,
      totalTokens: data.totalTokens,
    })

    return metric
  }

  static async summarizeRecent(days = 7) {
    const since = new Date(Date.now() - Math.max(1, days) * 24 * 60 * 60 * 1000)
    const metrics = await prisma.generationQualityMetric.findMany({
      where: {
        createdAt: { gte: since },
      },
      select: {
        appType: true,
        status: true,
        failureStage: true,
        buildPassed: true,
        runtimePassed: true,
        repairSucceeded: true,
        deployValidated: true,
        repairAttempts: true,
        totalLatencyMs: true,
        totalTokens: true,
        estimatedCost: true,
      },
    })

    const total = metrics.length
    const completed = metrics.filter((metric) => metric.status === "completed").length
    const buildPassed = metrics.filter((metric) => metric.buildPassed).length
    const runtimePassed = metrics.filter((metric) => metric.runtimePassed).length
    const repaired = metrics.filter((metric) => metric.repairSucceeded).length
    const deployValidated = metrics.filter((metric) => metric.deployValidated).length
    const byFailureStage = new Map<string, number>()

    for (const metric of metrics) {
      if (!metric.failureStage) continue
      byFailureStage.set(metric.failureStage, (byFailureStage.get(metric.failureStage) || 0) + 1)
    }

    const average = (values: number[]) =>
      values.length === 0 ? 0 : Math.round(values.reduce((sum, value) => sum + value, 0) / values.length)

    return {
      windowDays: days,
      sampleCount: total,
      generationSuccessRate: rate(completed, total),
      buildSuccessRate: rate(buildPassed, total),
      runtimeSuccessRate: rate(runtimePassed, total),
      repairSuccessRate: rate(repaired, Math.max(1, metrics.filter((metric) => metric.repairAttempts > 0).length)),
      deploySuccessRate: rate(deployValidated, total),
      averageRepairAttempts: average(metrics.map((metric) => metric.repairAttempts)),
      averageGenerationLatencyMs: average(metrics.map((metric) => metric.totalLatencyMs)),
      averageTokenCost: average(metrics.map((metric) => metric.totalTokens)),
      averageEstimatedCost: average(metrics.map((metric) => metric.estimatedCost)),
      failuresByStage: Object.fromEntries(Array.from(byFailureStage.entries()).sort((left, right) => right[1] - left[1])),
    }
  }

  static async markLatestDeployOutcome(input: {
    projectId: string
    success: boolean
    failureCode?: string | null
    metadata?: Record<string, unknown> | null
  }) {
    const latest = await prisma.generationQualityMetric.findFirst({
      where: {
        projectId: input.projectId,
      },
      orderBy: { createdAt: "desc" },
    })

    if (!latest) return null

    return prisma.generationQualityMetric.update({
      where: { id: latest.id },
      data: {
        deployValidated: input.success,
        failureStage: input.success ? latest.failureStage : "deploy",
        failureCode: input.success ? latest.failureCode : input.failureCode || "deploy_failed",
        metadataJson: safeStringify({
          previous: parseJsonObject(latest.metadataJson),
          deploy: {
            success: input.success,
            checkedAt: new Date().toISOString(),
            ...(input.metadata || {}),
          },
        }),
      },
    })
  }
}

function rate(numerator: number, denominator: number) {
  if (denominator <= 0) return 0
  return Math.round((numerator / denominator) * 1000) / 10
}

function parseJsonObject(value: string | null) {
  if (!value) return null

  try {
    const parsed = JSON.parse(value) as unknown
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null
  } catch {
    return null
  }
}

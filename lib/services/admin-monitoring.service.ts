import { subHours } from "date-fns"
import { prisma } from "@/lib/db/client"
import { getProductionReadiness } from "@/lib/production/readiness"
import { getGenerationQueueHealth } from "@/lib/queue/generation-queue"
import { getRuntimeHealthDashboard } from "@/lib/observability/runtime-recovery"
import { OrchestrationRuntimeService } from "@/lib/services/orchestration-runtime.service"

const DEFAULT_WINDOW_HOURS = 24
export const ALERT_THRESHOLDS = {
  workerHeartbeatStaleMs: 90_000,
  queueFailedJobsWarning: 1,
  deadLetterWaitingWarning: 1,
  databaseLatencyWarningMs: 1000,
  apiLatencyWarningMs: 2000,
  queueLatencyWarningMs: 1000,
  generationFailureRateWarningPct: 10,
  orchestrationDeadlockWarning: 3,
  sandboxCrashWarning: 2,
  previewFailureWarning: 3,
} as const

const RELIABILITY_TARGETS = {
  firstGenerationSuccessPct: 70,
  deploySuccessPct: 90,
  repairRecoverySuccessPct: 60,
  fatalCorruptionStuckJobMaxPct: 1,
} as const

type MonitoringAlertSeverity = "warning" | "critical"

type MonitoringAlertType =
  | "redis_down"
  | "queue_unhealthy"
  | "queue_saturated"
  | "queue_failed_jobs"
  | "database_latency_high"
  | "api_latency_high"
  | "queue_latency_high"
  | "dead_letter_jobs"
  | "generation_failure_rate_high"
  | "worker_heartbeat_stale"
  | "worker_stall_spike"
  | "preview_failure_spike"
  | "orchestration_deadlock_spike"
  | "excessive_retry_loops"
  | "sandbox_crash_spike"

type MonitoringAlert = {
  key: MonitoringAlertType
  type: MonitoringAlertType
  severity: MonitoringAlertSeverity
  message: string
  value?: number | string | null
  threshold?: number | string
}

type MonitoringAlertMetrics = {
  queueStatus: string
  queueCounts: Record<string, number>
  deadLetterCounts?: Record<string, number> | null
  workerHeartbeatAgeMs?: number | null
  redisError?: string | null
  databaseLatencyMs: number
  apiLatencyMs: number
  queueLatencyMs: number
  queueSaturationPct?: number
  queueBacklogAgeMs?: number
  queueAverageWaitDurationMs?: number
  queueSaturationReasons?: string[]
  workerStalls?: number
  previewFailures?: number
  orchestrationDeadlocks?: number
  excessiveRetryLoops?: number
  sandboxCrashes?: number
}

function clampWindowHours(value: number) {
  if (!Number.isFinite(value)) {
    return DEFAULT_WINDOW_HOURS
  }

  return Math.min(168, Math.max(1, Math.round(value)))
}

function statusCountMap(items: Array<{ status: string; _count: { _all: number } }>) {
  return items.reduce<Record<string, number>>((acc, item) => {
    acc[item.status] = item._count._all
    return acc
  }, {})
}

function successCountMap(items: Array<{ success: boolean; _count: { _all: number } }>) {
  return items.reduce(
    (acc, item) => {
      if (item.success) {
        acc.success += item._count._all
      } else {
        acc.failed += item._count._all
      }
      return acc
    },
    { success: 0, failed: 0 }
  )
}

async function measureLatency(operation: () => Promise<unknown>) {
  const startedAt = Date.now()
  await operation()
  return Date.now() - startedAt
}

function countMetric(value: unknown) {
  const current = Number(value || 0)
  return Number.isFinite(current) ? current : 0
}

function percentage(numerator: number, denominator: number) {
  if (denominator <= 0) return 0
  return Math.round((numerator / denominator) * 1000) / 10
}

function passRateTarget(value: number, target: number, sampleCount: number) {
  if (sampleCount <= 0) return "no_data"
  return value >= target ? "pass" : "fail"
}

function maxRateTarget(value: number, target: number, sampleCount: number) {
  if (sampleCount <= 0) return "no_data"
  return value <= target ? "pass" : "fail"
}

function pushAlert(alerts: MonitoringAlert[], alert: MonitoringAlert) {
  alerts.push({
    ...alert,
    key: alert.type,
  })
}

export function buildMonitoringAlerts(metrics: MonitoringAlertMetrics): MonitoringAlert[] {
  const alerts: MonitoringAlert[] = []
  const failedJobs = countMetric(metrics.queueCounts.failed)
  const totalJobs =
    countMetric(metrics.queueCounts.completed) +
    failedJobs +
    countMetric(metrics.queueCounts.active) +
    countMetric(metrics.queueCounts.waiting)
  const generationFailureRatePct = totalJobs > 0 ? Math.round((failedJobs / totalJobs) * 100) : 0
  const deadLetterWaiting = countMetric(metrics.deadLetterCounts?.waiting)
  const workerHeartbeatAgeMs = metrics.workerHeartbeatAgeMs

  if (metrics.redisError) {
    pushAlert(alerts, {
      type: "redis_down",
      key: "redis_down",
      severity: "critical",
      message: metrics.redisError,
      value: metrics.redisError,
    })
  }

  if (
    workerHeartbeatAgeMs === null ||
    workerHeartbeatAgeMs === undefined ||
    workerHeartbeatAgeMs > ALERT_THRESHOLDS.workerHeartbeatStaleMs
  ) {
    pushAlert(alerts, {
      type: "worker_heartbeat_stale",
      key: "worker_heartbeat_stale",
      severity: "critical",
      message: "Generation worker heartbeat is missing or stale.",
      value: workerHeartbeatAgeMs ?? "missing",
      threshold: ALERT_THRESHOLDS.workerHeartbeatStaleMs,
    })
  }

  if (["disabled", "degraded", "stale", "unhealthy"].includes(metrics.queueStatus)) {
    pushAlert(alerts, {
      type: "queue_unhealthy",
      key: "queue_unhealthy",
      severity: "warning",
      message: `Generation queue status is ${metrics.queueStatus}.`,
      value: metrics.queueStatus,
    })
  }

  if (countMetric(metrics.queueSaturationPct) >= 100) {
    pushAlert(alerts, {
      type: "queue_saturated",
      key: "queue_saturated",
      severity: countMetric(metrics.queueSaturationPct) >= 150 ? "critical" : "warning",
      message: `Generation queue is saturated at ${countMetric(metrics.queueSaturationPct)}%.`,
      value: countMetric(metrics.queueSaturationPct),
      threshold: "100%",
    })
  }

  if (failedJobs >= ALERT_THRESHOLDS.queueFailedJobsWarning) {
    pushAlert(alerts, {
      type: "queue_failed_jobs",
      key: "queue_failed_jobs",
      severity: "warning",
      message: `${failedJobs} failed BullMQ jobs retained.`,
      value: failedJobs,
      threshold: ALERT_THRESHOLDS.queueFailedJobsWarning,
    })
  }

  if (deadLetterWaiting >= ALERT_THRESHOLDS.deadLetterWaitingWarning) {
    pushAlert(alerts, {
      type: "dead_letter_jobs",
      key: "dead_letter_jobs",
      severity: "warning",
      message: `${deadLetterWaiting} dead-letter jobs are waiting.`,
      value: deadLetterWaiting,
      threshold: ALERT_THRESHOLDS.deadLetterWaitingWarning,
    })
  }

  if (metrics.databaseLatencyMs >= ALERT_THRESHOLDS.databaseLatencyWarningMs) {
    pushAlert(alerts, {
      type: "database_latency_high",
      key: "database_latency_high",
      severity: "warning",
      message: `Database latency is ${metrics.databaseLatencyMs}ms.`,
      value: metrics.databaseLatencyMs,
      threshold: ALERT_THRESHOLDS.databaseLatencyWarningMs,
    })
  }

  if (metrics.apiLatencyMs >= ALERT_THRESHOLDS.apiLatencyWarningMs) {
    pushAlert(alerts, {
      type: "api_latency_high",
      key: "api_latency_high",
      severity: "warning",
      message: `Monitoring API latency is ${metrics.apiLatencyMs}ms.`,
      value: metrics.apiLatencyMs,
      threshold: ALERT_THRESHOLDS.apiLatencyWarningMs,
    })
  }

  if (metrics.queueLatencyMs >= ALERT_THRESHOLDS.queueLatencyWarningMs) {
    pushAlert(alerts, {
      type: "queue_latency_high",
      key: "queue_latency_high",
      severity: "warning",
      message: `Queue latency is ${metrics.queueLatencyMs}ms.`,
      value: metrics.queueLatencyMs,
      threshold: ALERT_THRESHOLDS.queueLatencyWarningMs,
    })
  }

  if (generationFailureRatePct >= ALERT_THRESHOLDS.generationFailureRateWarningPct) {
    pushAlert(alerts, {
      type: "generation_failure_rate_high",
      key: "generation_failure_rate_high",
      severity: "warning",
      message: `Generation failure rate is ${generationFailureRatePct}%.`,
      value: generationFailureRatePct,
      threshold: ALERT_THRESHOLDS.generationFailureRateWarningPct,
    })
  }

  if (countMetric(metrics.workerStalls) >= 1) {
    pushAlert(alerts, {
      type: "worker_stall_spike",
      key: "worker_stall_spike",
      severity: "critical",
      message: `${countMetric(metrics.workerStalls)} worker stall event(s) detected.`,
      value: countMetric(metrics.workerStalls),
    })
  }

  if (countMetric(metrics.previewFailures) >= ALERT_THRESHOLDS.previewFailureWarning) {
    pushAlert(alerts, {
      type: "preview_failure_spike",
      key: "preview_failure_spike",
      severity: "warning",
      message: `${countMetric(metrics.previewFailures)} preview failure event(s) detected.`,
      value: countMetric(metrics.previewFailures),
      threshold: ALERT_THRESHOLDS.previewFailureWarning,
    })
  }

  if (countMetric(metrics.orchestrationDeadlocks) >= ALERT_THRESHOLDS.orchestrationDeadlockWarning) {
    pushAlert(alerts, {
      type: "orchestration_deadlock_spike",
      key: "orchestration_deadlock_spike",
      severity: "critical",
      message: `${countMetric(metrics.orchestrationDeadlocks)} validator deadlock event(s) detected.`,
      value: countMetric(metrics.orchestrationDeadlocks),
      threshold: ALERT_THRESHOLDS.orchestrationDeadlockWarning,
    })
  }

  if (countMetric(metrics.excessiveRetryLoops) >= 1) {
    pushAlert(alerts, {
      type: "excessive_retry_loops",
      key: "excessive_retry_loops",
      severity: "critical",
      message: `${countMetric(metrics.excessiveRetryLoops)} excessive retry loop(s) reached terminal state.`,
      value: countMetric(metrics.excessiveRetryLoops),
    })
  }

  if (countMetric(metrics.sandboxCrashes) >= ALERT_THRESHOLDS.sandboxCrashWarning) {
    pushAlert(alerts, {
      type: "sandbox_crash_spike",
      key: "sandbox_crash_spike",
      severity: "critical",
      message: `${countMetric(metrics.sandboxCrashes)} sandbox crash/failure event(s) detected.`,
      value: countMetric(metrics.sandboxCrashes),
      threshold: ALERT_THRESHOLDS.sandboxCrashWarning,
    })
  }

  return alerts
}

export class AdminMonitoringService {
  static async getOverview(windowHours = DEFAULT_WINDOW_HOURS) {
    const overviewStartedAt = Date.now()
    const hours = clampWindowHours(windowHours)
    const since = subHours(new Date(), hours)

    const [
      totalUsers,
      totalProjects,
      totalWorkspaces,
      usageStatus,
      requestStatus,
      completedUsageCost,
      refundedUsageCost,
      topupVolume,
      recentUsage,
      recentRequests,
      latestFailedRequests,
      pendingReservations,
      generationJobStatus,
      generationAttemptStatus,
      generationLatency,
      generationJobsInWindow,
      recentGenerationJobs,
      queueHealth,
      workerPressure,
      databaseLatencyMs,
      operationalFailures,
      runtimeHealth,
    ] = await Promise.all([
      prisma.user.count(),
      prisma.project.count(),
      prisma.workspace.count(),
      prisma.usageLog.groupBy({
        by: ["status"],
        where: { createdAt: { gte: since } },
        _count: { _all: true },
      }),
      prisma.requestLog.groupBy({
        by: ["success"],
        where: { createdAt: { gte: since } },
        _count: { _all: true },
      }),
      prisma.usageLog.aggregate({
        where: {
          status: "completed",
          createdAt: { gte: since },
        },
        _sum: { cost: true },
      }),
      prisma.usageLog.aggregate({
        where: {
          status: "refunded",
          createdAt: { gte: since },
        },
        _sum: { cost: true },
      }),
      prisma.billingTransaction.aggregate({
        where: {
          kind: "topup",
          direction: "credit",
          createdAt: { gte: since },
        },
        _sum: { amount: true },
      }),
      prisma.usageLog.findMany({
        orderBy: { createdAt: "desc" },
        take: 12,
        select: {
          id: true,
          user: { select: { email: true } },
          model: true,
          provider: true,
          cost: true,
          status: true,
          errorMessage: true,
          createdAt: true,
        },
      }),
      prisma.requestLog.findMany({
        orderBy: { createdAt: "desc" },
        take: 12,
        include: {
          project: {
            select: {
              id: true,
              name: true,
              workspace: {
                select: {
                  name: true,
                },
              },
            },
          },
        },
      }),
      prisma.requestLog.findMany({
        where: {
          success: false,
          createdAt: { gte: since },
        },
        orderBy: { createdAt: "desc" },
        take: 8,
        include: {
          project: {
            select: {
              id: true,
              name: true,
            },
          },
        },
      }),
      prisma.usageLog.count({
        where: {
          status: "reserved",
          createdAt: { gte: since },
        },
      }),
      prisma.generationJob.groupBy({
        by: ["status"],
        where: { createdAt: { gte: since } },
        _count: { _all: true },
      }),
      prisma.generationAttempt.groupBy({
        by: ["status"],
        where: { startedAt: { gte: since } },
        _count: { _all: true },
      }),
      prisma.generationQualityMetric.aggregate({
        where: { createdAt: { gte: since } },
        _avg: {
          providerLatencyMs: true,
          validationLatencyMs: true,
          totalLatencyMs: true,
        },
        _count: { _all: true },
      }),
      prisma.generationJob.findMany({
        where: { createdAt: { gte: since } },
        orderBy: { createdAt: "asc" },
        select: {
          id: true,
          status: true,
          createdAt: true,
          startedAt: true,
          completedAt: true,
          failedAt: true,
          attemptCount: true,
          retryCount: true,
          recoveryCount: true,
          deadLetteredAt: true,
          timedOutAt: true,
          error: true,
        },
      }),
      prisma.generationJob.findMany({
        orderBy: { createdAt: "desc" },
        take: 12,
        select: {
          id: true,
          projectId: true,
          status: true,
          stage: true,
          label: true,
          progress: true,
          queueJobId: true,
          error: true,
          createdAt: true,
          updatedAt: true,
          startedAt: true,
          completedAt: true,
          failedAt: true,
        },
      }),
      getGenerationQueueHealth().catch((error) => ({
        enabled: false,
        status: "unhealthy",
        counts: null,
        deadLetter: null,
        workerHeartbeat: null,
        redis: {
          configured: false,
          status: "error",
          ping: null,
          error: error instanceof Error ? error.message : String(error),
          latencyMs: 0,
        },
      })),
      OrchestrationRuntimeService.getWorkerPressure(hours).catch((error) => ({
        activeWorkers: 0,
        busyWorkers: 0,
        workerUtilization: 0,
        queueGrowthRate: 0,
        averageDequeueLatency: 0,
        recoveryFrequency: 0,
        retryFrequency: 0,
        scalingRecommendation: {
          recommendedWorkerCount: 1,
          saturationTrend: "unknown",
          projectedBacklogMinutes: 0,
        },
        error: error instanceof Error ? error.message : String(error),
      })),
      measureLatency(() => prisma.$queryRaw`SELECT 1`).catch(() => 0),
      prisma.orchestrationFailure.groupBy({
        by: ["eventType", "terminationReason"],
        where: { createdAt: { gte: since } },
        _count: { _all: true },
      }),
      getRuntimeHealthDashboard(hours).catch((error) => ({
        status: "unhealthy",
        error: error instanceof Error ? error.message : String(error),
      })),
    ])

    const usage = statusCountMap(usageStatus)
    const requests = successCountMap(requestStatus)
    const totalUsageCount = Object.values(usage).reduce((sum, count) => sum + count, 0)
    const totalRequestCount = requests.success + requests.failed
    const hourlyGeneration = Array.from({ length: hours }, (_, index) => {
      const start = new Date(since.getTime() + index * 60 * 60 * 1000)
      const end = new Date(start.getTime() + 60 * 60 * 1000)
      const bucketJobs = generationJobsInWindow.filter((job) => job.createdAt >= start && job.createdAt < end)
      const completedDurations = bucketJobs
        .map((job) => {
          const endAt = job.completedAt || job.failedAt
          if (!job.startedAt || !endAt) return null
          return Math.max(0, endAt.getTime() - job.startedAt.getTime())
        })
        .filter((duration): duration is number => typeof duration === "number")
      const completed = bucketJobs.filter((job) => job.status === "completed").length
      const failed = bucketJobs.filter((job) => job.status === "failed").length
      const total = bucketJobs.length

      return {
        at: start.toISOString(),
        label: start.toISOString().slice(11, 16),
        total,
        queued: bucketJobs.filter((job) => job.status === "queued").length,
        running: bucketJobs.filter((job) => job.status === "running").length,
        completed,
        failed,
        failureRate: total > 0 ? Math.round((failed / total) * 100) : 0,
        averageGenerationMs: completedDurations.length > 0
          ? Math.round(completedDurations.reduce((sum, duration) => sum + duration, 0) / completedDurations.length)
          : 0,
      }
    })
    const queueStatus = String((queueHealth as { status?: string }).status || "unknown")
    const queueCounts = (queueHealth as { counts?: Record<string, number> | null }).counts || {}
    const workerHeartbeat = (queueHealth as { workerHeartbeat?: { ageMs?: number | null } | null }).workerHeartbeat
    const redis = (queueHealth as { redis?: { error?: string | null; status?: string | null } | null }).redis
    const deadLetterCounts = (queueHealth as { deadLetter?: { counts?: Record<string, number> | null } | null }).deadLetter?.counts || null
    const queueSaturation = (queueHealth as {
      saturation?: {
        saturationPct?: number
        backlogDepth?: number
        backlogAgeMs?: number
        averageWaitDurationMs?: number
        workerUtilizationPct?: number
        reasons?: string[]
        saturated?: boolean
        heavy?: boolean
      }
    }).saturation
    const queueLatencyMs = Number((queueHealth as { redis?: { latencyMs?: number } }).redis?.latencyMs || 0)
    const apiLatencyMs = Date.now() - overviewStartedAt
    const failureCount = (eventType: string, terminationReason?: string) =>
      operationalFailures
        .filter((item) =>
          item.eventType === eventType &&
          (terminationReason ? item.terminationReason === terminationReason : true)
        )
        .reduce((sum, item) => sum + item._count._all, 0)
    const completedJobsInWindow = generationJobsInWindow.filter((job) => job.status === "completed")
    const terminalJobsInWindow = generationJobsInWindow.filter((job) =>
      ["completed", "failed", "cancelled", "dead_lettered"].includes(job.status)
    )
    const firstGenerationSuccessCount = completedJobsInWindow.filter((job) =>
      Math.max(job.attemptCount || 0, job.retryCount || 0, job.recoveryCount || 0) <= 1
    ).length
    const fatalJobIds = new Set<string>()
    for (const job of generationJobsInWindow) {
      const raw = [job.status, job.error || ""].join(" ").toLowerCase()
      if (
        job.deadLetteredAt ||
        job.timedOutAt ||
        /dead.?letter|stuck|stall|corrupt|corruption|timeout|timed out|validator_deadlock/.test(raw)
      ) {
        fatalJobIds.add(job.id)
      }
    }
    const fatalOperationalEvents = operationalFailures
      .filter((failure) => {
        const raw = [failure.eventType, failure.terminationReason || ""].join(" ").toLowerCase()
        return /stalled|dead.?letter|timeout|timed out|validator_deadlock|corrupt|corruption|max_retries/.test(raw)
      })
      .reduce((sum, failure) => sum + failure._count._all, 0)
    const fatalCorruptionStuckCount = Math.max(fatalJobIds.size, fatalOperationalEvents)
    const qualitySummary = await prisma.generationQualityMetric.findMany({
      where: { createdAt: { gte: since } },
      select: {
        status: true,
        failureStage: true,
        repairSucceeded: true,
        repairAttempts: true,
        deployValidated: true,
        metadataJson: true,
      },
    })
    const deployAttempted = qualitySummary.filter((metric) =>
      metric.deployValidated ||
      metric.failureStage === "deploy" ||
      /"deploy"\s*:/.test(metric.metadataJson || "")
    )
    const repairAttempted = qualitySummary.filter((metric) => metric.repairAttempts > 0)
    const firstGenerationSuccessPct = percentage(firstGenerationSuccessCount, terminalJobsInWindow.length)
    const deploySuccessPct = percentage(deployAttempted.filter((metric) => metric.deployValidated).length, deployAttempted.length)
    const repairRecoverySuccessPct = percentage(repairAttempted.filter((metric) => metric.repairSucceeded).length, repairAttempted.length)
    const fatalCorruptionStuckJobPct = percentage(fatalCorruptionStuckCount, Math.max(terminalJobsInWindow.length, generationJobsInWindow.length))
    const reliabilityMetrics = {
      targets: RELIABILITY_TARGETS,
      windowHours: hours,
      firstGenerationSuccess: {
        percent: firstGenerationSuccessPct,
        numerator: firstGenerationSuccessCount,
        denominator: terminalJobsInWindow.length,
        target: RELIABILITY_TARGETS.firstGenerationSuccessPct,
        status: passRateTarget(firstGenerationSuccessPct, RELIABILITY_TARGETS.firstGenerationSuccessPct, terminalJobsInWindow.length),
        definition: "Completed generation jobs that reached success without retry/recovery divided by terminal generation jobs.",
      },
      deploySuccess: {
        percent: deploySuccessPct,
        numerator: deployAttempted.filter((metric) => metric.deployValidated).length,
        denominator: deployAttempted.length,
        target: RELIABILITY_TARGETS.deploySuccessPct,
        status: passRateTarget(deploySuccessPct, RELIABILITY_TARGETS.deploySuccessPct, deployAttempted.length),
        definition: "Deploy-validated generation metrics divided by generation metrics with a deploy attempt.",
      },
      repairRecoverySuccess: {
        percent: repairRecoverySuccessPct,
        numerator: repairAttempted.filter((metric) => metric.repairSucceeded).length,
        denominator: repairAttempted.length,
        target: RELIABILITY_TARGETS.repairRecoverySuccessPct,
        status: passRateTarget(repairRecoverySuccessPct, RELIABILITY_TARGETS.repairRecoverySuccessPct, repairAttempted.length),
        definition: "Generations recovered by repair divided by generations where repair was attempted.",
      },
      fatalCorruptionStuckJob: {
        percent: fatalCorruptionStuckJobPct,
        numerator: fatalCorruptionStuckCount,
        denominator: Math.max(terminalJobsInWindow.length, generationJobsInWindow.length),
        targetMax: RELIABILITY_TARGETS.fatalCorruptionStuckJobMaxPct,
        status: maxRateTarget(
          fatalCorruptionStuckJobPct,
          RELIABILITY_TARGETS.fatalCorruptionStuckJobMaxPct,
          Math.max(terminalJobsInWindow.length, generationJobsInWindow.length)
        ),
        definition: "Dead-lettered, timed-out, stalled, validator-deadlocked, or corruption-marked jobs/events divided by jobs in the window.",
      },
    }
    const alerts = buildMonitoringAlerts({
      queueStatus,
      queueCounts,
      deadLetterCounts,
      workerHeartbeatAgeMs: workerHeartbeat?.ageMs ?? null,
      redisError: redis?.error || null,
      databaseLatencyMs,
      apiLatencyMs,
      queueLatencyMs,
      queueSaturationPct: queueSaturation?.saturationPct || 0,
      queueBacklogAgeMs: queueSaturation?.backlogAgeMs || 0,
      queueAverageWaitDurationMs: queueSaturation?.averageWaitDurationMs || 0,
      queueSaturationReasons: queueSaturation?.reasons || [],
      workerStalls: failureCount("worker_stalled"),
      previewFailures: failureCount("preview_failed"),
      orchestrationDeadlocks: operationalFailures
        .filter((item) => item.terminationReason === "validator_deadlock")
        .reduce((sum, item) => sum + item._count._all, 0),
      excessiveRetryLoops: operationalFailures
        .filter((item) => item.terminationReason === "max_retries_exceeded")
        .reduce((sum, item) => sum + item._count._all, 0),
      sandboxCrashes: failureCount("preview_failed"),
    })

    return {
      windowHours: hours,
      since,
      readiness: getProductionReadiness(),
      totals: {
        users: totalUsers,
        workspaces: totalWorkspaces,
        projects: totalProjects,
        completedUsageCost: completedUsageCost._sum.cost || 0,
        refundedUsageCost: refundedUsageCost._sum.cost || 0,
        topupVolume: topupVolume._sum.amount || 0,
        pendingReservations,
      },
      usage: {
        byStatus: usage,
        total: totalUsageCount,
        completionRate: totalUsageCount > 0 ? Math.round(((usage.completed || 0) / totalUsageCount) * 100) : 0,
      },
      requests: {
        ...requests,
        total: totalRequestCount,
        successRate: totalRequestCount > 0 ? Math.round((requests.success / totalRequestCount) * 100) : 0,
      },
      generation: {
        jobsByStatus: statusCountMap(generationJobStatus),
        attemptsByStatus: statusCountMap(generationAttemptStatus),
        reliability: reliabilityMetrics,
        latency: {
          sampleCount: generationLatency._count._all,
          providerAvgMs: Math.round(generationLatency._avg.providerLatencyMs || 0),
          validationAvgMs: Math.round(generationLatency._avg.validationLatencyMs || 0),
          totalAvgMs: Math.round(generationLatency._avg.totalLatencyMs || 0),
        },
        recentJobs: recentGenerationJobs,
        history: hourlyGeneration,
      },
      queue: queueHealth,
      observability: {
        databaseLatencyMs,
        apiLatencyMs,
        queueLatencyMs,
        queueSaturation: {
          saturated: Boolean(queueSaturation?.saturated),
          heavy: Boolean(queueSaturation?.heavy),
          saturationPct: Math.round(Number(queueSaturation?.saturationPct || 0) * 10) / 10,
          backlogDepth: Number(queueSaturation?.backlogDepth || 0),
          backlogAgeMs: Number(queueSaturation?.backlogAgeMs || 0),
          averageWaitDurationMs: Number(queueSaturation?.averageWaitDurationMs || 0),
          workerUtilizationPct: Math.round(Number(queueSaturation?.workerUtilizationPct || 0) * 10) / 10,
          reasons: queueSaturation?.reasons || [],
        },
        workerPressure,
        failures: operationalFailures,
        runtimeHealth,
      },
      alerts,
      recentUsage,
      recentRequests,
      latestFailedRequests,
    }
  }
}

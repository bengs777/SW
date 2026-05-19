import { subHours } from "date-fns"
import { prisma } from "@/lib/db/client"
import { getProductionReadiness } from "@/lib/production/readiness"
import { getGenerationQueueHealth } from "@/lib/queue/generation-queue"

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

type MonitoringAlertSeverity = "warning" | "critical"

type MonitoringAlertType =
  | "redis_down"
  | "queue_unhealthy"
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
      databaseLatencyMs,
      operationalFailures,
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
          status: true,
          createdAt: true,
          startedAt: true,
          completedAt: true,
          failedAt: true,
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
      measureLatency(() => prisma.$queryRaw`SELECT 1`).catch(() => 0),
      prisma.orchestrationFailure.groupBy({
        by: ["eventType", "terminationReason"],
        where: { createdAt: { gte: since } },
        _count: { _all: true },
      }),
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
    const queueLatencyMs = Number((queueHealth as { redis?: { latencyMs?: number } }).redis?.latencyMs || 0)
    const apiLatencyMs = Date.now() - overviewStartedAt
    const failureCount = (eventType: string, terminationReason?: string) =>
      operationalFailures
        .filter((item) =>
          item.eventType === eventType &&
          (terminationReason ? item.terminationReason === terminationReason : true)
        )
        .reduce((sum, item) => sum + item._count._all, 0)
    const alerts = buildMonitoringAlerts({
      queueStatus,
      queueCounts,
      deadLetterCounts,
      workerHeartbeatAgeMs: workerHeartbeat?.ageMs ?? null,
      redisError: redis?.error || null,
      databaseLatencyMs,
      apiLatencyMs,
      queueLatencyMs,
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
        failures: operationalFailures,
      },
      alerts,
      recentUsage,
      recentRequests,
      latestFailedRequests,
    }
  }
}

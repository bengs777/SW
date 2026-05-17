import { subHours } from "date-fns"
import { prisma } from "@/lib/db/client"
import { getProductionReadiness } from "@/lib/production/readiness"
import { getGenerationQueueHealth } from "@/lib/queue/generation-queue"

const DEFAULT_WINDOW_HOURS = 24

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

export class AdminMonitoringService {
  static async getOverview(windowHours = DEFAULT_WINDOW_HOURS) {
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
    const alerts = [
      redis?.error
        ? { key: "redis_down", severity: "critical", message: redis.error }
        : null,
      !workerHeartbeat || Number(workerHeartbeat.ageMs || 0) > 90_000
        ? { key: "worker_dead", severity: "critical", message: "Generation worker heartbeat is missing or stale." }
        : null,
      queueStatus === "disabled" || queueStatus === "degraded" || queueStatus === "stale" || queueStatus === "unhealthy"
        ? { key: "queue_unhealthy", severity: "warning", message: `Generation queue status is ${queueStatus}.` }
        : null,
      Number(queueCounts.failed || 0) > 0
        ? { key: "queue_failed_jobs", severity: "warning", message: `${queueCounts.failed} failed BullMQ jobs retained.` }
        : null,
    ].filter((alert): alert is { key: string; severity: string; message: string } => Boolean(alert))

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
      alerts,
      recentUsage,
      recentRequests,
      latestFailedRequests,
    }
  }
}

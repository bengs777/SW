import { subHours } from "date-fns"
import { prisma } from "@/lib/db/client"
import { getProductionReadiness } from "@/lib/production/readiness"

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
    ])

    const usage = statusCountMap(usageStatus)
    const requests = successCountMap(requestStatus)
    const totalUsageCount = Object.values(usage).reduce((sum, count) => sum + count, 0)
    const totalRequestCount = requests.success + requests.failed

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
      recentUsage,
      recentRequests,
      latestFailedRequests,
    }
  }
}

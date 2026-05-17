"use client"

import { useState, useEffect, useRef } from "react"
import { useSession } from "next-auth/react"
import Link from "next/link"
import { Activity, AlertTriangle, CheckCircle2, Clock3, Server, Zap } from "lucide-react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Spinner } from "@/components/ui/spinner"

interface MonitoringData {
  status: "healthy" | "degraded" | "critical"
  timestamp: string
  services: {
    name: string
    status: "up" | "degraded" | "down"
    latency: number
    uptime: number
  }[]
  metrics: {
    totalRequests: number
    successRate: number
    avgLatency: number
    errorRate: number
  }
}

type AdminMonitoringResponse = {
  ok?: boolean
  overview?: {
    readiness?: {
      ok?: boolean
      checks?: Array<{
        key: string
        label: string
        ok: boolean
        severity: "required" | "recommended"
      }>
      requiredMissing?: string[]
    }
    requests?: {
      total?: number
      success?: number
      failed?: number
      successRate?: number
    }
    recentRequests?: Array<{ latencyMs?: number }>
  }
}

function normalizeMonitoringData(payload: unknown): MonitoringData {
  const response = payload as AdminMonitoringResponse & Partial<MonitoringData>

  if (response.metrics && response.services && response.status && response.timestamp) {
    return response as MonitoringData
  }

  const overview = response.overview
  if (!overview) {
    throw new Error("Monitoring response is missing overview data.")
  }

  const readinessChecks = overview.readiness?.checks || []
  const requiredMissing = overview.readiness?.requiredMissing || []
  const status: MonitoringData["status"] =
    overview.readiness?.ok === false || requiredMissing.length > 0
      ? "critical"
      : readinessChecks.some((check) => !check.ok)
        ? "degraded"
        : "healthy"
  const recentLatencies = (overview.recentRequests || [])
    .map((request) => Number(request.latencyMs || 0))
    .filter((latency) => Number.isFinite(latency) && latency >= 0)
  const avgLatency = recentLatencies.length > 0
    ? Math.round(recentLatencies.reduce((sum, latency) => sum + latency, 0) / recentLatencies.length)
    : 0
  const successRate = Number(overview.requests?.successRate || 0)

  return {
    status,
    timestamp: new Date().toISOString(),
    services: readinessChecks.map((check) => ({
      name: check.label || check.key,
      status: check.ok ? "up" : check.severity === "required" ? "down" : "degraded",
      latency: 0,
      uptime: check.ok ? 100 : 0,
    })),
    metrics: {
      totalRequests: Number(overview.requests?.total || 0),
      successRate,
      avgLatency,
      errorRate: Math.max(0, 100 - successRate),
    },
  }
}

export default function AdminPage() {
  const { data: session, status: sessionStatus } = useSession()
  const [monitoringData, setMonitoringData] = useState<MonitoringData | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState("")
  const [isDevAccount, setIsDevAccount] = useState(false)
  const abortControllerRef = useRef<AbortController | null>(null)
  const canAccessAdmin = isDevAccount || Boolean(
    session?.user?.isDeveloperAccount || session?.user?.email?.endsWith("@swift.local")
  )

  useEffect(() => {
    // Wait until session is fully resolved before checking dev status
    if (sessionStatus !== "authenticated" || !session) return

    const isDev = session.user?.isDeveloperAccount || session.user?.email?.endsWith("@swift.local")
    setIsDevAccount(Boolean(isDev))
    console.log("[admin] Session resolved", {
      email: session.user?.email,
      isDeveloperAccount: session.user?.isDeveloperAccount,
      sessionStatus,
    })
  }, [session, sessionStatus])

  useEffect(() => {
    // Delay fetch until session is authenticated AND user is dev
    if (sessionStatus !== "authenticated" || !canAccessAdmin) return

    const controller = new AbortController()
    abortControllerRef.current = controller

    const fetchMonitoring = async () => {
      setIsLoading(true)
      setError("")

      try {
        const response = await fetch("/api/admin/monitoring", {
          signal: controller.signal,
        })

        if (controller.signal.aborted) return

        const data = await response.json().catch(() => ({}))

        if (!response.ok) {
          setError(data.error || "Failed to load monitoring data")
          return
        }

        setMonitoringData(normalizeMonitoringData(data))
      } catch (err) {
        if (err instanceof DOMException && err.name === "AbortError") return
        console.error("[admin] Failed to fetch monitoring data:", err)
        setError("Unable to load monitoring data right now.")
      } finally {
        if (!controller.signal.aborted) {
          setIsLoading(false)
        }
      }
    }

    fetchMonitoring()
    const interval = setInterval(fetchMonitoring, 30000)

    return () => {
      controller.abort()
      abortControllerRef.current = null
      clearInterval(interval)
    }
  }, [canAccessAdmin, sessionStatus])

  if (sessionStatus === "loading") {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <Card className="w-full max-w-md">
          <CardContent className="flex items-center justify-center py-10">
            <Spinner className="mr-2" />
            Checking developer access...
          </CardContent>
        </Card>
      </div>
    )
  }

  if (!canAccessAdmin) {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center gap-4">
        <AlertTriangle className="h-12 w-12 text-yellow-500" />
        <h1 className="text-2xl font-bold">Access Denied</h1>
        <p className="text-muted-foreground">You do not have permission to access this page.</p>
        <Button asChild>
          <Link href="/dashboard">Go to Dashboard</Link>
        </Button>
      </div>
    )
  }

  const getStatusColor = (status: string) => {
    switch (status) {
      case "healthy":
      case "up":
        return "bg-green-500/10 text-green-700 dark:text-green-400"
      case "degraded":
        return "bg-yellow-500/10 text-yellow-700 dark:text-yellow-400"
      case "critical":
      case "down":
        return "bg-red-500/10 text-red-700 dark:text-red-400"
      default:
        return "bg-gray-500/10 text-gray-700 dark:text-gray-400"
    }
  }

  const getStatusIcon = (status: string) => {
    switch (status) {
      case "healthy":
      case "up":
        return <CheckCircle2 className="h-5 w-5" />
      case "degraded":
        return <AlertTriangle className="h-5 w-5" />
      case "critical":
      case "down":
        return <AlertTriangle className="h-5 w-5" />
      default:
        return <Clock3 className="h-5 w-5" />
    }
  }

  return (
    <div className="flex min-h-screen flex-col gap-6">
      {/* Header */}
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Admin Dashboard</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          System monitoring, health checks, and operational overview.
        </p>
      </div>

      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      {isLoading ? (
        <Card>
          <CardContent className="flex items-center justify-center py-12">
            <Spinner className="mr-2" />
            Loading monitoring data...
          </CardContent>
        </Card>
      ) : monitoringData ? (
        <>
          {/* Overall Status */}
          <Card>
            <CardHeader>
              <div className="flex items-center justify-between">
                <div>
                  <CardTitle>System Status</CardTitle>
                  <CardDescription>24-hour operational overview</CardDescription>
                </div>
                <Badge
                  className={`rounded-full px-3 py-1 text-sm font-semibold gap-2 ${getStatusColor(
                    monitoringData.status
                  )}`}
                >
                  {getStatusIcon(monitoringData.status)}
                  {monitoringData.status.toUpperCase()}
                </Badge>
              </div>
            </CardHeader>
            <CardContent>
              <p className="text-sm text-muted-foreground">
                Last updated: {new Date(monitoringData.timestamp).toLocaleTimeString()}
              </p>
            </CardContent>
          </Card>

          {/* Key Metrics */}
          <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
            <Card>
              <CardHeader>
                <CardTitle className="text-sm font-medium">Total Requests</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="text-3xl font-bold">{monitoringData.metrics.totalRequests.toLocaleString()}</div>
                <p className="mt-2 text-xs text-muted-foreground">Last 24 hours</p>
              </CardContent>
            </Card>
            <Card>
              <CardHeader>
                <CardTitle className="text-sm font-medium">Success Rate</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="text-3xl font-bold">{monitoringData.metrics.successRate.toFixed(2)}%</div>
                <p className="mt-2 text-xs text-muted-foreground">
                  {monitoringData.metrics.successRate > 99 ? "Excellent" : "Good"}
                </p>
              </CardContent>
            </Card>
            <Card>
              <CardHeader>
                <CardTitle className="text-sm font-medium">Avg Latency</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="text-3xl font-bold">{monitoringData.metrics.avgLatency}ms</div>
                <p className="mt-2 text-xs text-muted-foreground">Response time</p>
              </CardContent>
            </Card>
            <Card>
              <CardHeader>
                <CardTitle className="text-sm font-medium">Error Rate</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="text-3xl font-bold">{monitoringData.metrics.errorRate.toFixed(2)}%</div>
                <p className="mt-2 text-xs text-muted-foreground">
                  {monitoringData.metrics.errorRate < 1 ? "Healthy" : "Needs attention"}
                </p>
              </CardContent>
            </Card>
          </div>

          {/* Service Status */}
          <Card>
            <CardHeader>
              <CardTitle>Service Status</CardTitle>
              <CardDescription>Health status of all critical services</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="space-y-3">
                {monitoringData.services.map((service) => (
                  <div
                    key={service.name}
                    className="flex items-center justify-between rounded-lg border border-border/70 bg-card/50 p-4"
                  >
                    <div className="flex items-center gap-3 flex-1">
                      <div className={`flex h-10 w-10 items-center justify-center rounded-lg ${getStatusColor(service.status)}`}>
                        {getStatusIcon(service.status)}
                      </div>
                      <div>
                        <p className="font-medium">{service.name}</p>
                        <p className="text-xs text-muted-foreground">
                          Latency: {service.latency}ms • Uptime: {service.uptime}%
                        </p>
                      </div>
                    </div>
                    <Badge
                      variant={
                        service.status === "up"
                          ? "default"
                          : service.status === "degraded"
                          ? "secondary"
                          : "destructive"
                      }
                      className="rounded-full px-3 py-1"
                    >
                      {service.status.toUpperCase()}
                    </Badge>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>

          {/* Admin Actions */}
          <Card>
            <CardHeader>
              <CardTitle>Admin Actions</CardTitle>
              <CardDescription>Maintenance and operational tools</CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              <Button variant="outline" className="w-full justify-start gap-2">
                <Server className="h-4 w-4" />
                View Detailed Logs
              </Button>
              <Button variant="outline" className="w-full justify-start gap-2">
                <Zap className="h-4 w-4" />
                Grant Credits
              </Button>
              <Button variant="outline" className="w-full justify-start gap-2">
                <Activity className="h-4 w-4" />
                View All Transactions
              </Button>
            </CardContent>
          </Card>
        </>
      ) : null}
    </div>
  )
}

import Link from "next/link"
import { AlertTriangle, CheckCircle2, Clock3, Database, ListChecks, Server, Workflow, XCircle } from "lucide-react"
import { getCurrentDeveloperActor } from "@/lib/admin"
import { AdminMonitoringService } from "@/lib/services/admin-monitoring.service"
import { validateEnv } from "@/lib/env"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"

export const dynamic = "force-dynamic"

function statusTone(status: string | undefined) {
  if (status === "healthy" || status === "completed" || status === "up") {
    return "border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-500/30 dark:bg-emerald-500/10 dark:text-emerald-300"
  }
  if (status === "degraded" || status === "stale" || status === "running" || status === "queued") {
    return "border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-300"
  }
  return "border-red-200 bg-red-50 text-red-700 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-300"
}

function StatusIcon({ status }: { status?: string }) {
  if (status === "healthy" || status === "completed" || status === "up") {
    return <CheckCircle2 className="h-4 w-4" />
  }
  if (status === "degraded" || status === "stale" || status === "running" || status === "queued") {
    return <AlertTriangle className="h-4 w-4" />
  }
  return <XCircle className="h-4 w-4" />
}

function Metric({
  label,
  value,
  hint,
}: {
  label: string
  value: string | number
  hint?: string
}) {
  return (
    <div className="rounded-lg border bg-card px-4 py-3">
      <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className="mt-2 text-2xl font-semibold tabular-nums">{value}</div>
      {hint ? <div className="mt-1 text-xs text-muted-foreground">{hint}</div> : null}
    </div>
  )
}

function MiniBars({
  title,
  data,
  valueKey,
  suffix = "",
}: {
  title: string
  data: Array<Record<string, string | number>>
  valueKey: string
  suffix?: string
}) {
  const max = Math.max(1, ...data.map((item) => Number(item[valueKey] || 0)))
  return (
    <div className="rounded-lg border p-3">
      <div className="mb-3 text-xs font-medium uppercase tracking-wide text-muted-foreground">{title}</div>
      <div className="flex h-24 items-end gap-1">
        {data.map((item) => {
          const value = Number(item[valueKey] || 0)
          return (
            <div key={`${title}:${item.at}`} className="flex min-w-0 flex-1 flex-col items-center gap-1">
              <div
                className="w-full rounded-t bg-primary/70"
                style={{ height: `${Math.max(4, Math.round((value / max) * 88))}px` }}
                title={`${item.label}: ${value}${suffix}`}
              />
            </div>
          )
        })}
      </div>
    </div>
  )
}

export default async function SystemDashboardPage() {
  const actor = await getCurrentDeveloperActor()
  if (!actor) {
    return (
      <div className="flex min-h-[60vh] flex-col items-center justify-center gap-4 text-center">
        <AlertTriangle className="h-10 w-10 text-amber-500" />
        <div>
          <h1 className="text-2xl font-semibold">Developer access required</h1>
          <p className="mt-2 text-sm text-muted-foreground">System telemetry is only available for the Swift owner account.</p>
        </div>
        <Button asChild>
          <Link href="/dashboard">Back to dashboard</Link>
        </Button>
      </div>
    )
  }

  const [overview, envReport] = await Promise.all([
    AdminMonitoringService.getOverview(24),
    Promise.resolve(validateEnv()),
  ])
  const queue = overview.queue as {
    enabled?: boolean
    status?: string
    counts?: Record<string, number> | null
    deadLetter?: { counts?: Record<string, number> | null } | null
    workerHeartbeat?: { workerId?: string; ageMs?: number; at?: string } | null
    redis?: { status?: string; latencyMs?: number; error?: string | null } | null
  }
  const generation = overview.generation
  const jobsByStatus = generation.jobsByStatus || {}
  const attemptsByStatus = generation.attemptsByStatus || {}
  const alerts = overview.alerts || []
  const queueCounts = queue.counts || {}
  const totalJobs =
    (queueCounts.completed || 0) +
    (queueCounts.failed || 0) +
    (queueCounts.active || 0) +
    (queueCounts.waiting || 0)
  const failureRate = totalJobs > 0
    ? Math.round(((queueCounts.failed || 0) / totalJobs) * 100)
    : 0

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 border-b pb-5 lg:flex-row lg:items-center lg:justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">System</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Prompt to job to Redis to worker to AI to files to Explorer.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Badge className={statusTone(queue.status)}>
            <StatusIcon status={queue.status} />
            <span className="ml-1">Queue {queue.status || "unknown"}</span>
          </Badge>
          <Badge className={envReport.ok ? statusTone("healthy") : statusTone("unhealthy")}>
            <StatusIcon status={envReport.ok ? "healthy" : "unhealthy"} />
            <span className="ml-1">Env {envReport.ok ? "ok" : "needs review"}</span>
          </Badge>
        </div>
      </div>

      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
        <Metric label="Pending" value={(queue.counts?.waiting || 0) + (queue.counts?.delayed || 0)} hint="waiting + delayed" />
        <Metric label="Active" value={queue.counts?.active || 0} hint="currently running" />
        <Metric label="Completed" value={queue.counts?.completed || 0} hint="BullMQ retained" />
        <Metric label="Failed" value={queue.counts?.failed || 0} hint={`failure rate ${failureRate}%`} />
      </div>

      {alerts.length > 0 ? (
        <div className="grid gap-2">
          {alerts.map((alert) => (
            <div key={alert.key} className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-200">
              <span className="font-medium">{alert.key}</span>: {alert.message}
            </div>
          ))}
        </div>
      ) : null}

      <div className="grid gap-4 xl:grid-cols-[1.2fr_0.8fr]">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Workflow className="h-4 w-4" />
              AI Pipeline
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
              <Metric label="Job completed" value={jobsByStatus.completed || 0} />
              <Metric label="Job failed" value={jobsByStatus.failed || 0} />
              <Metric label="Attempt failed" value={attemptsByStatus.failed || 0} />
              <Metric label="Provider avg" value={`${generation.latency.providerAvgMs}ms`} />
              <Metric label="Validation avg" value={`${generation.latency.validationAvgMs}ms`} />
              <Metric label="Total avg" value={`${generation.latency.totalAvgMs}ms`} />
            </div>
            <div className="mt-5 overflow-hidden rounded-lg border">
              <div className="grid grid-cols-[1fr_110px_110px] border-b bg-muted/50 px-3 py-2 text-xs font-medium text-muted-foreground">
                <span>Recent job</span>
                <span>Status</span>
                <span>Stage</span>
              </div>
              {generation.recentJobs.slice(0, 8).map((job) => (
                <div key={job.id} className="grid grid-cols-[1fr_110px_110px] items-center gap-2 border-b px-3 py-2 text-sm last:border-b-0">
                  <span className="truncate font-mono text-xs">{job.id}</span>
                  <Badge variant="outline" className={statusTone(job.status)}>{job.status}</Badge>
                  <span className="truncate text-xs text-muted-foreground">{job.stage}</span>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Server className="h-4 w-4" />
              Queue and Worker
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            <div className="flex items-center justify-between rounded-lg border px-3 py-2">
              <span className="flex items-center gap-2 text-muted-foreground"><Database className="h-4 w-4" /> Redis</span>
              <span className="font-mono text-xs">{queue.redis?.status || "unknown"} / {queue.redis?.latencyMs ?? 0}ms</span>
            </div>
            <div className="flex items-center justify-between rounded-lg border px-3 py-2">
              <span className="flex items-center gap-2 text-muted-foreground"><Clock3 className="h-4 w-4" /> Worker heartbeat</span>
              <span className="font-mono text-xs">{queue.workerHeartbeat ? `${queue.workerHeartbeat.ageMs}ms` : "missing"}</span>
            </div>
            <div className="flex items-center justify-between rounded-lg border px-3 py-2">
              <span className="flex items-center gap-2 text-muted-foreground"><ListChecks className="h-4 w-4" /> Dead letter</span>
              <span className="font-mono text-xs">{queue.deadLetter?.counts?.waiting || 0} waiting</span>
            </div>
            {queue.redis?.error ? (
              <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-300">
                {queue.redis.error}
              </div>
            ) : null}
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Historical Graphs</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
          <MiniBars title="Queue size" data={generation.history} valueKey="total" />
          <MiniBars title="Latency" data={generation.history} valueKey="averageGenerationMs" suffix="ms" />
          <MiniBars title="Failure rate" data={generation.history} valueKey="failureRate" suffix="%" />
          <MiniBars title="Average generation" data={generation.history} valueKey="averageGenerationMs" suffix="ms" />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Environment Audit</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid gap-2 md:grid-cols-2 xl:grid-cols-3">
            {envReport.issues.length === 0 ? (
              <div className="rounded-lg border px-3 py-2 text-sm text-muted-foreground">No environment issues detected.</div>
            ) : (
              envReport.issues.map((issue) => (
                <div key={`${issue.key}:${issue.message}`} className="rounded-lg border px-3 py-2">
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-mono text-xs">{issue.key}</span>
                    <Badge variant="outline" className={issue.severity === "error" ? statusTone("unhealthy") : statusTone("degraded")}>
                      {issue.severity}
                    </Badge>
                  </div>
                  <p className="mt-2 text-xs text-muted-foreground">{issue.message}</p>
                </div>
              ))
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  )
}

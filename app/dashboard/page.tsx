import Link from "next/link"
import { redirect } from "next/navigation"
import { formatDistanceToNow } from "date-fns"
import type { LucideIcon } from "lucide-react"
import {
  Activity,
  ArrowUpRight,
  BarChart3,
  Clock3,
  FolderOpen,
  Layers3,
  ShieldCheck,
  Sparkles,
  Wallet,
} from "lucide-react"
import { auth } from "@/auth"
import { ProjectList } from "@/components/dashboard/project-list"
import { NewProjectTrigger } from "@/components/dashboard/new-project-trigger"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { isMissingRequiredTableError, shouldSoftFailMissingTable } from "@/lib/db/errors"
import { prisma } from "@/lib/db/client"
import { cn } from "@/lib/utils"

type DashboardUsageLog = {
  id: string
  model: string
  provider: string
  cost: number
  prompt: string
  status: string
  errorMessage: string | null
  createdAt: Date
}

type DashboardWorkspaceOption = {
  id: string
  name: string
}

export default async function DashboardPage() {
  const session = await auth()

  if (!session?.user?.email) {
    redirect("/login")
  }

  let balance = 0
  let usageLogs: DashboardUsageLog[] = []
  let workspaceOptions: DashboardWorkspaceOption[] = []
  let hasDataWarning = false

  try {
    const user = await prisma.user.findUnique({
      where: { email: session.user.email },
      select: {
        id: true,
        balance: true,
      },
    })

    if (user) {
      balance = user.balance

      const [usageLogsResult, membershipsResult] = await Promise.allSettled([
        prisma.usageLog.findMany({
          where: { userId: user.id },
          orderBy: { createdAt: "desc" },
          take: 10,
          select: {
            id: true,
            model: true,
            provider: true,
            cost: true,
            prompt: true,
            status: true,
            errorMessage: true,
            createdAt: true,
          },
        }),
        prisma.workspaceMember.findMany({
          where: { userId: user.id },
          include: {
            workspace: {
              select: {
                id: true,
                name: true,
              },
            },
          },
        }),
      ])

      if (usageLogsResult.status === "fulfilled") {
        usageLogs = usageLogsResult.value
      } else {
        hasDataWarning = true
        console.error("[dashboard] Failed to load usage logs:", usageLogsResult.reason)
      }

      if (membershipsResult.status === "fulfilled") {
        workspaceOptions = membershipsResult.value.map((membership) => ({
          id: membership.workspace.id,
          name: membership.workspace.name,
        }))
      } else {
        hasDataWarning = true
        console.error("[dashboard] Failed to load workspace memberships:", membershipsResult.reason)
      }
    } else {
      hasDataWarning = true
    }
  } catch (error) {
    hasDataWarning = true

    if (isMissingRequiredTableError(error) && !shouldSoftFailMissingTable()) {
      throw error
    }

    console.error("[dashboard] Failed to load dashboard data:", error)
  }

  const totalSpent = usageLogs
    .filter((log) => log.status === "completed")
    .reduce((sum, log) => sum + log.cost, 0)

  const totalRefunded = usageLogs
    .filter((log) => log.status === "refunded")
    .reduce((sum, log) => sum + log.cost, 0)

  const successfulRequests = usageLogs.filter((log) => log.status === "completed").length
  const completionRate =
    usageLogs.length > 0 ? Math.round((successfulRequests / usageLogs.length) * 100) : 0
  const defaultWorkspaceId = workspaceOptions[0]?.id
  const latestActivity = usageLogs[0]
  const latestActivityLabel = latestActivity
    ? formatDistanceToNow(latestActivity.createdAt, { addSuffix: true })
    : "No activity yet"
  const healthLabel = hasDataWarning ? "Partial sync" : "All systems synced"
  const healthTone = hasDataWarning
    ? "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300"
    : "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"

  return (
    <div className="space-y-6 pb-6">
      {hasDataWarning && (
        <Card className="border-amber-500/30 bg-amber-500/5 shadow-sm">
          <CardContent className="px-4 py-3 text-sm text-muted-foreground">
            Dashboard data belum lengkap. Halaman tetap dibuka, tapi beberapa data akun belum bisa dimuat dari database.
          </CardContent>
        </Card>
      )}

      <section className="relative overflow-hidden rounded-3xl border border-border/70 bg-card/90 p-6 shadow-sm sm:p-8">
        <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_top_right,oklch(0.97_0_0_/_0.45),transparent_28%),radial-gradient(circle_at_bottom_left,oklch(0.985_0_0_/_0.65),transparent_32%)] dark:bg-[radial-gradient(circle_at_top_right,oklch(0.269_0_0_/_0.5),transparent_26%),radial-gradient(circle_at_bottom_left,oklch(0.205_0_0_/_0.42),transparent_30%)]" />
        <div className="relative flex flex-col gap-6 lg:flex-row lg:items-end lg:justify-between">
          <div className="max-w-3xl space-y-4">
            <Badge
              variant="secondary"
              className="w-fit gap-2 rounded-full border border-border/70 bg-background/70 px-3 py-1.5 text-xs font-medium tracking-wide text-foreground"
            >
              <Sparkles className="h-3.5 w-3.5" />
              Dashboard overview
            </Badge>
            <div className="space-y-3">
              <h1 className="max-w-2xl text-3xl font-semibold tracking-tight text-foreground sm:text-4xl">
                Build and monitor workspaces without the template feel.
              </h1>
              <p className="max-w-3xl text-sm leading-6 text-muted-foreground sm:text-base">
                Keep credits, recent activity, and generated projects in one control room. The layout is tuned to feel like a real product dashboard, not a demo screen.
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              <MetaPill icon={Clock3} text={latestActivityLabel} />
              <MetaPill icon={Layers3} text={`${workspaceOptions.length} active workspaces`} />
              <MetaPill icon={ShieldCheck} text={healthLabel} tone={healthTone} />
            </div>
          </div>
          <div className="flex flex-wrap gap-3">
            <Button asChild variant="outline" className="rounded-full px-4 shadow-sm">
              <Link href="/dashboard/settings?tab=billing" className="inline-flex items-center gap-2">
                <ArrowUpRight className="h-4 w-4" />
                Top up
              </Link>
            </Button>
            {workspaceOptions.length > 0 ? (
              <NewProjectTrigger
                workspaces={workspaceOptions}
                defaultWorkspaceId={defaultWorkspaceId}
              />
            ) : (
              <Button variant="outline" className="rounded-full px-4" disabled>
                New Project
              </Button>
            )}
          </div>
        </div>
      </section>

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        <MetricCard
          icon={Wallet}
          label="Current Balance"
          value={`Rp ${balance.toLocaleString("id-ID")}`}
          detail="Available credits for generation"
        />
        <MetricCard
          icon={Activity}
          label="Successful Requests"
          value={successfulRequests.toLocaleString("id-ID")}
          detail="Completed AI calls"
        />
        <MetricCard
          icon={BarChart3}
          label="Completion Rate"
          value={`${completionRate}%`}
          detail={`${successfulRequests} of ${usageLogs.length} requests completed`}
        />
        <MetricCard
          icon={FolderOpen}
          label="Total Spent"
          value={`Rp ${totalSpent.toLocaleString("id-ID")}`}
          detail="Completed request cost"
        />
      </div>

      <div className="grid gap-6 xl:grid-cols-[1.15fr,0.85fr]">
        <Card className="overflow-hidden border-border/70 shadow-sm">
          <CardHeader>
            <CardTitle>Recent Usage</CardTitle>
            <CardDescription>
              Latest model requests with cost, provider, and status.
            </CardDescription>
          </CardHeader>
          <CardContent className="p-6">
            {usageLogs.length === 0 ? (
              <EmptyState
                title="No usage logs yet"
                description="Send your first model request to start tracking activity in this dashboard."
              />
            ) : (
              <div className="space-y-3">
                {usageLogs.map((log) => (
                  <article
                    key={log.id}
                    className="rounded-3xl border border-border/70 bg-background/60 p-4 shadow-sm transition-colors hover:border-border"
                  >
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="text-sm font-semibold text-foreground">{log.model}</div>
                        <div className="mt-1 text-xs text-muted-foreground">
                          {log.provider} • {formatDistanceToNow(log.createdAt, { addSuffix: true })}
                        </div>
                      </div>
                      <div className="flex flex-wrap items-center gap-2">
                        <Badge variant={getUsageVariant(log.status)}>{log.status}</Badge>
                        <Badge variant="outline" className="rounded-full">
                          Rp {log.cost.toLocaleString("id-ID")}
                        </Badge>
                      </div>
                    </div>
                    <p className="mt-3 line-clamp-2 text-sm leading-6 text-muted-foreground">
                      {log.prompt}
                    </p>
                    {log.errorMessage && (
                      <p className="mt-2 text-xs text-destructive">{log.errorMessage}</p>
                    )}
                  </article>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        <Card className="overflow-hidden border-border/70 shadow-sm">
          <CardHeader>
            <CardTitle>Workspace Health</CardTitle>
            <CardDescription>
              Billing and activity signals for the active account.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4 p-6">
            <div className="grid gap-3 sm:grid-cols-2">
              <InfoTile
                label="Refunded"
                value={`Rp ${totalRefunded.toLocaleString("id-ID")}`}
                description="Automatically returned to the balance"
              />
              <InfoTile
                label="Last activity"
                value={latestActivityLabel}
                description={latestActivity ? latestActivity.provider : "Waiting for usage"}
              />
            </div>

            <div className="space-y-3">
              <div className="text-xs font-medium uppercase tracking-[0.24em] text-muted-foreground">
                Workspaces
              </div>
              {workspaceOptions.length > 0 ? (
                workspaceOptions.slice(0, 4).map((workspace) => (
                  <div
                    key={workspace.id}
                    className="flex items-center justify-between rounded-2xl border border-border/70 bg-background/60 px-4 py-3"
                  >
                    <div>
                      <div className="text-sm font-medium text-foreground">{workspace.name}</div>
                      <div className="text-xs text-muted-foreground">Active workspace</div>
                    </div>
                    <Badge variant="secondary" className="rounded-full px-2.5 py-1 text-xs">
                      Online
                    </Badge>
                  </div>
                ))
              ) : (
                <EmptyState
                  title="No workspaces yet"
                  description="Create a workspace before generating projects so the dashboard can surface activity."
                />
              )}
            </div>

            <div className="rounded-2xl border border-border/70 bg-background/70 p-4">
              <div className="text-xs uppercase tracking-[0.2em] text-muted-foreground">
                Selected workspace
              </div>
              <div className="mt-2 text-lg font-semibold text-foreground">
                {workspaceOptions[0]?.name || "None"}
              </div>
              <p className="mt-1 text-sm text-muted-foreground">
                {defaultWorkspaceId
                  ? "Use the workspace switcher in the sidebar to jump between spaces."
                  : "Create a workspace to start generating projects."}
              </p>
            </div>
          </CardContent>
        </Card>
      </div>

      <Card className="overflow-hidden border-border/70 shadow-sm">
        <CardHeader className="border-b border-border/70 bg-muted/20">
          <CardTitle>Projects</CardTitle>
          <CardDescription>
            Browse recent generated projects and open previews.
          </CardDescription>
        </CardHeader>
        <CardContent className="p-6">
          <ProjectList searchQuery="" workspaceId={defaultWorkspaceId} />
        </CardContent>
      </Card>
    </div>
  )
}

function MetricCard({
  icon: Icon,
  label,
  detail,
  value,
}: {
  icon: LucideIcon
  label: string
  detail: string
  value: string
}) {
  return (
    <Card className="overflow-hidden border-border/70 shadow-sm">
      <CardContent className="p-5">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <p className="text-sm text-muted-foreground">{detail}</p>
            <div className="mt-2 text-2xl font-semibold tracking-tight text-foreground">{value}</div>
            <p className="mt-1 text-sm font-medium text-foreground/90">{label}</p>
          </div>
          <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl border border-border/70 bg-muted/40 text-foreground">
            <Icon className="h-5 w-5" />
          </div>
        </div>
      </CardContent>
    </Card>
  )
}

function InfoTile({
  label,
  value,
  description,
}: {
  label: string
  value: string
  description: string
}) {
  return (
    <div className="rounded-2xl border border-border/70 bg-background/60 p-4">
      <div className="text-xs uppercase tracking-[0.2em] text-muted-foreground">{label}</div>
      <div className="mt-2 text-lg font-semibold text-foreground">{value}</div>
      <div className="mt-1 text-sm text-muted-foreground">{description}</div>
    </div>
  )
}

function MetaPill({
  icon: Icon,
  text,
  tone,
}: {
  icon: LucideIcon
  text: string
  tone?: string
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-2 rounded-full border px-3 py-2 text-xs font-medium text-muted-foreground",
        tone ?? "border-border/70 bg-background/70"
      )}
    >
      <Icon className="h-3.5 w-3.5" />
      <span className="max-w-[18rem] truncate">{text}</span>
    </span>
  )
}

function EmptyState({ title, description }: { title: string; description: string }) {
  return (
    <div className="flex flex-col items-center justify-center rounded-3xl border border-dashed border-border/70 bg-muted/20 px-6 py-14 text-center">
      <div className="mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-background text-muted-foreground shadow-sm">
        <FolderOpen className="h-7 w-7" />
      </div>
      <h3 className="text-lg font-semibold text-foreground">{title}</h3>
      <p className="mt-2 max-w-md text-sm leading-6 text-muted-foreground">{description}</p>
    </div>
  )
}

function getUsageVariant(status: string): "default" | "secondary" | "destructive" | "outline" {
  if (status === "completed") return "default"
  if (status === "refunded") return "secondary"
  if (status === "failed") return "destructive"
  return "outline"
}

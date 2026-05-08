import { formatDistanceToNow } from "date-fns"
import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  Gauge,
  ServerCog,
  ShieldCheck,
  Wallet,
  XCircle,
  type LucideIcon,
} from "lucide-react"
import { auth } from "@/auth"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { getCurrentDeveloperActor } from "@/lib/admin"
import { AdminMonitoringService } from "@/lib/services/admin-monitoring.service"

function formatIdr(amount: number) {
  return `Rp ${amount.toLocaleString("id-ID")}`
}

export default async function AdminMonitoringPage() {
  const session = await auth()
  const actor = await getCurrentDeveloperActor()

  if (!actor) {
    return (
      <div className="flex min-h-[60vh] items-center justify-center">
        <Card className="w-full max-w-xl border-border/70 shadow-sm">
          <CardHeader>
            <CardTitle>Developer access required</CardTitle>
            <CardDescription>
              Akun {session?.user?.email || "ini"} belum punya akses monitoring production.
            </CardDescription>
          </CardHeader>
        </Card>
      </div>
    )
  }

  const overview = await AdminMonitoringService.getOverview(24)
  const readiness = overview.readiness

  return (
    <div className="space-y-6 pb-6">
      <section className="rounded-3xl border border-border/70 bg-card/90 p-6 shadow-sm">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <Badge variant={readiness.ok ? "default" : "destructive"} className="mb-3 rounded-full">
              {readiness.ok ? "Production ready" : "Needs setup"}
            </Badge>
            <h1 className="text-3xl font-semibold tracking-tight text-foreground">
              Swift AI monitoring
            </h1>
            <p className="mt-2 max-w-3xl text-sm leading-6 text-muted-foreground">
              Ringkasan operasional 24 jam terakhir: environment, billing, request AI, refund, dan error provider.
            </p>
          </div>
          <div className="rounded-2xl border border-border/70 bg-background/70 px-4 py-3 text-sm">
            <div className="text-muted-foreground">Developer</div>
            <div className="font-medium text-foreground">{actor.email}</div>
          </div>
        </div>
      </section>

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        <Metric icon={Wallet} label="Top up volume" value={formatIdr(overview.totals.topupVolume)} />
        <Metric icon={Activity} label="Completed usage" value={formatIdr(overview.totals.completedUsageCost)} />
        <Metric icon={ShieldCheck} label="Request success" value={`${overview.requests.successRate}%`} />
        <Metric icon={Gauge} label="Usage completion" value={`${overview.usage.completionRate}%`} />
      </div>

      <div className="grid gap-6 xl:grid-cols-[0.9fr,1.1fr]">
        <Card className="border-border/70 shadow-sm">
          <CardHeader>
            <CardTitle>Readiness checks</CardTitle>
            <CardDescription>
              Required harus hijau sebelum invite user umum.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {readiness.checks.map((item) => (
              <div key={item.key} className="flex items-start justify-between gap-3 rounded-2xl border border-border/70 bg-background/60 p-3">
                <div className="min-w-0">
                  <div className="text-sm font-medium text-foreground">{item.label}</div>
                  <div className="mt-1 text-xs text-muted-foreground">{item.detail || item.key}</div>
                </div>
                <Badge variant={item.ok ? "secondary" : item.severity === "required" ? "destructive" : "outline"}>
                  {item.ok ? "ok" : item.severity}
                </Badge>
              </div>
            ))}
          </CardContent>
        </Card>

        <Card className="border-border/70 shadow-sm">
          <CardHeader>
            <CardTitle>Operational health</CardTitle>
            <CardDescription>
              Signal cepat untuk charge/refund dan request provider.
            </CardDescription>
          </CardHeader>
          <CardContent className="grid gap-3 sm:grid-cols-2">
            <HealthTile icon={CheckCircle2} label="Successful requests" value={overview.requests.success.toLocaleString("id-ID")} />
            <HealthTile icon={XCircle} label="Failed requests" value={overview.requests.failed.toLocaleString("id-ID")} />
            <HealthTile icon={Wallet} label="Refunded usage" value={formatIdr(overview.totals.refundedUsageCost)} />
            <HealthTile icon={AlertTriangle} label="Pending reservations" value={overview.totals.pendingReservations.toLocaleString("id-ID")} />
            <HealthTile icon={ServerCog} label="Users" value={overview.totals.users.toLocaleString("id-ID")} />
            <HealthTile icon={Activity} label="Projects" value={overview.totals.projects.toLocaleString("id-ID")} />
          </CardContent>
        </Card>
      </div>

      <Card className="border-border/70 shadow-sm">
        <CardHeader>
          <CardTitle>Recent AI requests</CardTitle>
          <CardDescription>
            RequestLog terbaru dari proses generate, chat, inspect, dan fallback.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Status</TableHead>
                <TableHead>Project</TableHead>
                <TableHead>Mode</TableHead>
                <TableHead>Provider</TableHead>
                <TableHead>Latency</TableHead>
                <TableHead>Time</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {overview.recentRequests.map((request) => (
                <TableRow key={request.id}>
                  <TableCell>
                    <Badge variant={request.success ? "secondary" : "destructive"}>
                      {request.success ? "success" : "failed"}
                    </Badge>
                  </TableCell>
                  <TableCell>{request.project.name}</TableCell>
                  <TableCell>{request.taskType}</TableCell>
                  <TableCell>{request.provider || request.modelUsed}</TableCell>
                  <TableCell>{request.latencyMs}ms</TableCell>
                  <TableCell>{formatDistanceToNow(request.createdAt, { addSuffix: true })}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  )
}

function Metric({
  icon: Icon,
  label,
  value,
}: {
  icon: LucideIcon
  label: string
  value: string
}) {
  return (
    <Card className="border-border/70 shadow-sm">
      <CardContent className="flex items-center justify-between gap-3 p-5">
        <div>
          <div className="text-sm text-muted-foreground">{label}</div>
          <div className="mt-2 text-2xl font-semibold tracking-tight">{value}</div>
        </div>
        <div className="flex h-11 w-11 items-center justify-center rounded-2xl border border-border/70 bg-muted/40">
          <Icon className="h-5 w-5" />
        </div>
      </CardContent>
    </Card>
  )
}

function HealthTile({
  icon: Icon,
  label,
  value,
}: {
  icon: LucideIcon
  label: string
  value: string
}) {
  return (
    <div className="rounded-2xl border border-border/70 bg-background/60 p-4">
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Icon className="h-4 w-4" />
        {label}
      </div>
      <div className="mt-2 text-xl font-semibold text-foreground">{value}</div>
    </div>
  )
}

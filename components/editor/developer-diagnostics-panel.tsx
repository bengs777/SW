"use client"

import type { ReactNode } from "react"
import { ChevronDown, TerminalSquare } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { ScrollArea } from "@/components/ui/scroll-area"

export type DeveloperDiagnosticsSnapshot = {
  stage?: string
  status?: string
  retryCount?: number
  attemptCount?: number
  diagnostics?: {
    developer?: {
      currentStage?: string
      retryCount?: number
      lastSuccessfulStage?: string | null
      terminationReason?: string | null
      plannerOutput?: unknown
      generatedArtifactSummary?: unknown
      validatorFailures?: unknown[]
      artifactParseFailures?: unknown[]
      repairAttempts?: unknown[]
      buildFailures?: unknown[]
      previewStartupFailures?: unknown[]
      executionTimeline?: Array<{
        stage?: string
        status?: string
        reason?: string
        repairAttempt?: number
        at?: string
        data?: unknown
      }>
      activeRuntimeStage?: string | null
      retryMetrics?: unknown
      reports?: unknown
    }
  } | null
  metrics?: unknown
  plan?: unknown
  trace?: {
    traceId?: string | null
    workerId?: string | null
    leaseOwner?: string | null
    leaseExpiresAt?: string | null
    lastHeartbeatAt?: string | null
  }
  recovery?: {
    retryReason?: string | null
    retryClass?: string | null
    recoveryCount?: number
  }
}

type Props = {
  diagnostics: DeveloperDiagnosticsSnapshot | null
  expanded: boolean
  onToggle: () => void
}

export function DeveloperDiagnosticsPanel({ diagnostics, expanded, onToggle }: Props) {
  if (!diagnostics) return null

  const developer = diagnostics.diagnostics?.developer
  const currentStage = developer?.currentStage || diagnostics.stage || "UNKNOWN"
  const timeline = Array.isArray(developer?.executionTimeline) ? developer.executionTimeline : []
  const lastSuccessfulStage =
    developer?.lastSuccessfulStage ||
    [...timeline].reverse().find((item) => item.status === "passed")?.stage ||
    "UNKNOWN"
  const terminationReason =
    developer?.terminationReason ||
    [...timeline].reverse().find((item) => item.status === "failed" || item.stage === "FAILED")?.reason ||
    "Not terminated"

  return (
    <div className="border-t border-border bg-background">
      <div className="flex items-center justify-between gap-3 px-3 py-2">
        <div className="flex min-w-0 items-center gap-2">
          <TerminalSquare className="h-4 w-4 text-muted-foreground" />
          <p className="truncate text-sm font-medium">Developer Diagnostics</p>
          <Badge variant="outline" className="text-[10px]">{currentStage}</Badge>
          {typeof developer?.retryCount === "number" && (
            <Badge variant="secondary" className="text-[10px]">retries {developer.retryCount}</Badge>
          )}
        </div>
        <Button variant="ghost" size="sm" className="h-8 gap-1" onClick={onToggle}>
          <ChevronDown className={`h-4 w-4 transition-transform ${expanded ? "rotate-180" : ""}`} />
          Details
        </Button>
      </div>

      {expanded && (
        <ScrollArea className="max-h-80 border-t border-border">
          <div className="space-y-3 p-3 text-xs">
            <Section title="Orchestration Summary">
              <div className="grid gap-2 rounded-md border border-border bg-muted/30 p-2">
                <div>
                  <p className="text-[10px] uppercase tracking-wide text-muted-foreground">Last successful stage</p>
                  <p className="mt-1 font-medium">{lastSuccessfulStage}</p>
                </div>
                <div>
                  <p className="text-[10px] uppercase tracking-wide text-muted-foreground">Termination reason</p>
                  <p className="mt-1 whitespace-pre-wrap break-words font-medium">{terminationReason}</p>
                </div>
              </div>
            </Section>
            <Section title="Correlation">
              <div className="grid gap-1 rounded-md border border-border bg-muted/30 p-2 font-mono text-[11px]">
                <p>trace_id: {diagnostics.trace?.traceId || "unknown"}</p>
                <p>worker_id: {diagnostics.trace?.workerId || "unassigned"}</p>
                <p>lease_owner: {diagnostics.trace?.leaseOwner || "none"}</p>
                <p>lease_expiry: {diagnostics.trace?.leaseExpiresAt || "none"}</p>
                <p>retry_class: {diagnostics.recovery?.retryClass || "none"}</p>
                <p>retry_reason: {diagnostics.recovery?.retryReason || "none"}</p>
              </div>
            </Section>
            <Section title="Execution Timeline">
              {timeline.length === 0 ? (
                <p className="text-muted-foreground">No developer timeline events yet.</p>
              ) : (
                <div className="space-y-2">
                  {timeline.slice(-30).map((item, index) => (
                    <article key={`${item.at || "event"}-${index}`} className="rounded-md border border-border bg-muted/30 p-2">
                      <div className="mb-1 flex flex-wrap items-center gap-2">
                        <Badge variant="outline" className="text-[10px]">{item.stage || "UNKNOWN"}</Badge>
                        <Badge variant={item.status === "failed" ? "destructive" : "secondary"} className="text-[10px]">
                          {item.status || "info"}
                        </Badge>
                        {typeof item.repairAttempt === "number" && (
                          <span className="text-[10px] text-muted-foreground">repair {item.repairAttempt}</span>
                        )}
                        {item.at && <span className="text-[10px] text-muted-foreground">{new Date(item.at).toLocaleTimeString()}</span>}
                      </div>
                      <p className="whitespace-pre-wrap break-words text-foreground/90">{item.reason || "No reason provided"}</p>
                    </article>
                  ))}
                </div>
              )}
            </Section>

            <JsonSection title="Planner Output" value={developer?.plannerOutput || diagnostics.plan} />
            <JsonSection title="Architecture Plan" value={(developer?.plannerOutput as Record<string, unknown> | undefined)?.architecturePlan} />
            <JsonSection title="Project Memory Graph" value={(developer?.plannerOutput as Record<string, unknown> | undefined)?.projectMemoryGraph} />
            <JsonSection title="Dependency Graph" value={(developer?.plannerOutput as Record<string, unknown> | undefined)?.dependencyGraph} />
            <JsonSection title="Incremental Edit" value={(developer?.plannerOutput as Record<string, unknown> | undefined)?.incrementalEdit || (diagnostics.metrics as Record<string, unknown> | undefined)?.incrementalEdit} />
            <JsonSection title="Generated Artifact Summary" value={developer?.generatedArtifactSummary} />
            <JsonSection title="Validator Failures" value={developer?.validatorFailures} />
            <JsonSection title="Artifact Parse Failures" value={developer?.artifactParseFailures} />
            <JsonSection title="Repair Attempts" value={developer?.repairAttempts} />
            <JsonSection title="Build Failures" value={developer?.buildFailures} />
            <JsonSection title="Preview Startup Failures" value={developer?.previewStartupFailures} />
            <JsonSection title="Queue Lifecycle" value={diagnostics.recovery} />
            <JsonSection title="Worker Ownership" value={diagnostics.trace} />
            <JsonSection title="Terminal Failure Summary" value={(diagnostics.diagnostics as Record<string, unknown> | null)?.orchestrationSummary} />
            <JsonSection title="Retry Metrics" value={developer?.retryMetrics} />
            <JsonSection title="Reports" value={developer?.reports} />
          </div>
        </ScrollArea>
      )}
    </div>
  )
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section>
      <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{title}</h3>
      {children}
    </section>
  )
}

function JsonSection({ title, value }: { title: string; value: unknown }) {
  if (value === undefined || value === null) return null
  return (
    <Section title={title}>
      <pre className="max-h-48 overflow-auto rounded-md border border-border bg-muted/40 p-2 text-[11px] leading-relaxed">
        {JSON.stringify(value, null, 2)}
      </pre>
    </Section>
  )
}

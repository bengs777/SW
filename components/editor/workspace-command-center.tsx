"use client"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  CheckCircle2,
  Clock3,
  GitBranch,
  Github,
  History,
  Loader2,
  PlayCircle,
  Rocket,
  RotateCcw,
  ShieldCheck,
} from "lucide-react"
import { cn } from "@/lib/utils"

export type ProjectHistoryEntry = {
  id: string
  prompt: string
  intent?: string | null
  usedAutoRepair?: boolean
  createdAt: string
  fileCount: number
}

export type PreviewValidationState = {
  status: "idle" | "running" | "passed" | "failed"
  checkedAt?: string | null
  diagnosticsCount: number
  warningCount: number
  message?: string | null
}

export type DeployFlowState = {
  githubStatus: "idle" | "running" | "ready" | "setup-required" | "failed"
  vercelStatus: "idle" | "running" | "ready" | "failed"
  githubUrl?: string | null
  vercelUrl?: string | null
  message?: string | null
}

type WorkspaceCommandCenterProps = {
  projectName?: string | null
  fileCount: number
  currentVersion: number
  isDirty: boolean
  history: ProjectHistoryEntry[]
  previewValidation: PreviewValidationState
  deployFlow: DeployFlowState
  isValidatingPreview?: boolean
  isRollingBack?: boolean
  isPushingGitHub?: boolean
  isDeploying?: boolean
  onValidatePreview: () => void
  onRollback: (historyId: string) => void
  onPushGitHub: () => void
  onDeployVercel: () => void
}

const deployStatusLabel: Record<DeployFlowState["githubStatus"] | DeployFlowState["vercelStatus"], string> = {
  idle: "Idle",
  running: "Running",
  ready: "Ready",
  "setup-required": "Setup",
  failed: "Failed",
}

export function WorkspaceCommandCenter({
  projectName,
  fileCount,
  currentVersion,
  isDirty,
  history,
  previewValidation,
  deployFlow,
  isValidatingPreview = false,
  isRollingBack = false,
  isPushingGitHub = false,
  isDeploying = false,
  onValidatePreview,
  onRollback,
  onPushGitHub,
  onDeployVercel,
}: WorkspaceCommandCenterProps) {
  const latestHistory = history[0] || null
  const validationPassed = previewValidation.status === "passed"
  const validationFailed = previewValidation.status === "failed"

  return (
    <section
      aria-label="Workspace builder controls"
      className="border-b border-border bg-background px-3 py-3"
    >
      <div className="grid gap-3 lg:grid-cols-[minmax(0,1.1fr)_minmax(320px,0.9fr)_minmax(300px,0.8fr)]">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="secondary" className="gap-1">
              <GitBranch className="h-3.5 w-3.5" />
              Workspace Builder
            </Badge>
            <Badge variant={isDirty ? "outline" : "secondary"}>
              {isDirty ? "Unsaved edits" : "Saved"}
            </Badge>
            <Badge variant="outline">v{currentVersion}</Badge>
            <Badge variant="outline">{fileCount} files</Badge>
          </div>
          <h1 className="mt-2 truncate text-sm font-semibold text-foreground">
            {projectName || "Swift project"}
          </h1>
          <p className="mt-1 max-w-2xl text-xs leading-5 text-muted-foreground">
            Build with a patch-first loop: validate preview, keep rollback points, then ship through GitHub and Vercel.
          </p>
        </div>

        <div className="rounded-md border border-border bg-muted/30 p-3">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2 text-sm font-medium">
              <ShieldCheck className={cn("h-4 w-4", validationPassed && "text-emerald-600", validationFailed && "text-destructive")} />
              Preview validation
            </div>
            <Badge variant={validationFailed ? "destructive" : validationPassed ? "secondary" : "outline"}>
              {previewValidation.status}
            </Badge>
          </div>
          <div className="mt-2 text-xs text-muted-foreground">
            {previewValidation.message ||
              (previewValidation.checkedAt
                ? `${previewValidation.diagnosticsCount} diagnostics, ${previewValidation.warningCount} warnings`
                : "Run validation before rollback or deploy.")}
          </div>
          <Button
            size="sm"
            variant={validationFailed ? "default" : "outline"}
            className="mt-3 w-full gap-2"
            onClick={onValidatePreview}
            disabled={isValidatingPreview}
          >
            {isValidatingPreview ? <Loader2 className="h-4 w-4 animate-spin" /> : <PlayCircle className="h-4 w-4" />}
            Validate preview
          </Button>
        </div>

        <div className="rounded-md border border-border bg-muted/30 p-3">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2 text-sm font-medium">
              <History className="h-4 w-4" />
              Version history
            </div>
            <Badge variant="outline">{history.length}</Badge>
          </div>
          <div className="mt-2 space-y-2">
            {history.slice(0, 3).map((entry, index) => (
              <div key={entry.id} className="flex items-center justify-between gap-3 text-xs">
                <div className="min-w-0">
                  <div className="flex items-center gap-1 text-foreground">
                    {index === 0 ? <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600" /> : <Clock3 className="h-3.5 w-3.5 text-muted-foreground" />}
                    <span className="truncate">{entry.prompt || "Snapshot"}</span>
                  </div>
                  <div className="mt-0.5 text-muted-foreground">
                    {entry.fileCount} files - {new Date(entry.createdAt).toLocaleString()}
                  </div>
                </div>
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-7 shrink-0 gap-1 px-2"
                  onClick={() => onRollback(entry.id)}
                  disabled={isRollingBack || entry.id === latestHistory?.id}
                >
                  <RotateCcw className="h-3.5 w-3.5" />
                  Rollback
                </Button>
              </div>
            ))}
            {history.length === 0 && (
              <div className="text-xs text-muted-foreground">No saved versions yet.</div>
            )}
          </div>
        </div>
      </div>

      <div className="mt-3 flex flex-col gap-2 border-t border-border pt-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <span>Ship flow</span>
          <Badge variant={deployFlow.githubStatus === "failed" ? "destructive" : "outline"}>
            GitHub: {deployStatusLabel[deployFlow.githubStatus]}
          </Badge>
          <Badge variant={deployFlow.vercelStatus === "failed" ? "destructive" : deployFlow.vercelStatus === "ready" ? "secondary" : "outline"}>
            Vercel: {deployStatusLabel[deployFlow.vercelStatus]}
          </Badge>
          {deployFlow.message && <span className="truncate">{deployFlow.message}</span>}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {deployFlow.githubUrl && (
            <Button size="sm" variant="ghost" asChild>
              <a href={deployFlow.githubUrl} target="_blank" rel="noreferrer">Open GitHub</a>
            </Button>
          )}
          {deployFlow.vercelUrl && (
            <Button size="sm" variant="ghost" asChild>
              <a href={deployFlow.vercelUrl} target="_blank" rel="noreferrer">Open Vercel</a>
            </Button>
          )}
          <Button size="sm" variant="outline" className="gap-2" onClick={onPushGitHub} disabled={isPushingGitHub}>
            {isPushingGitHub ? <Loader2 className="h-4 w-4 animate-spin" /> : <Github className="h-4 w-4" />}
            Push GitHub
          </Button>
          <Button size="sm" className="gap-2" onClick={onDeployVercel} disabled={isDeploying}>
            {isDeploying ? <Loader2 className="h-4 w-4 animate-spin" /> : <Rocket className="h-4 w-4" />}
            Deploy Vercel
          </Button>
        </div>
      </div>
    </section>
  )
}

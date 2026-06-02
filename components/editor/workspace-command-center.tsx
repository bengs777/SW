"use client"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  AlertCircle,
  ArrowRight,
  CheckCircle2,
  Code2,
  Clock3,
  ExternalLink,
  Eye,
  GitBranch,
  Github,
  History,
  Loader2,
  MessageSquareText,
  PlayCircle,
  Rocket,
  RotateCcw,
  ShieldCheck,
  Sparkles,
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
  artifactStatus?: "empty" | "draft" | "persisted"
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

const deployStatusTone: Record<DeployFlowState["githubStatus"] | DeployFlowState["vercelStatus"], string> = {
  idle: "border-border bg-background text-muted-foreground",
  running: "border-sky-500/30 bg-sky-500/10 text-sky-700 dark:text-sky-300",
  ready: "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
  "setup-required": "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300",
  failed: "border-destructive/30 bg-destructive/10 text-destructive",
}

const stepStateTone = {
  done: {
    shell: "border-emerald-500/30 bg-emerald-500/10",
    icon: "bg-emerald-600 text-white",
    badge: "Done",
  },
  active: {
    shell: "border-sky-500/35 bg-sky-500/10 shadow-[inset_0_1px_0_rgba(255,255,255,0.08)]",
    icon: "bg-sky-600 text-white",
    badge: "Now",
  },
  pending: {
    shell: "border-border bg-background",
    icon: "bg-muted text-muted-foreground",
    badge: "Next",
  },
} as const

export function WorkspaceCommandCenter({
  projectName,
  fileCount,
  currentVersion,
  isDirty,
  artifactStatus = "empty",
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
  const hasFiles = fileCount > 0
  const isDraft = artifactStatus === "draft"
  const githubReady = deployFlow.githubStatus === "ready"
  const vercelReady = deployFlow.vercelStatus === "ready"
  const hasShipIssue = deployFlow.githubStatus === "failed" || deployFlow.githubStatus === "setup-required" || deployFlow.vercelStatus === "failed"
  const progressValue = Math.round(
    ([
      Boolean(latestHistory),
      validationPassed || (hasFiles && !isDraft),
      githubReady,
      vercelReady,
    ].filter(Boolean).length /
      4) *
      100
  )
  const activeStage = vercelReady
    ? "Live"
    : deployFlow.vercelStatus === "running"
      ? "Deploying"
      : githubReady
        ? "Ready to deploy"
        : deployFlow.githubStatus === "running"
          ? "Publishing"
          : isDraft
            ? "Drafting"
            : validationPassed
              ? "Ready to ship"
              : hasFiles
                ? "Review preview"
              : latestHistory
                ? "Generating"
                : "Prompting"
  const flowSteps = [
    {
      label: "Prompt",
      detail: latestHistory ? "Generation saved" : "Ready for first prompt",
      icon: MessageSquareText,
      state: latestHistory ? "done" : "active",
    },
    {
      label: "Preview",
      detail: validationPassed ? "Validated" : isDraft ? "Draft in editor" : hasFiles ? "Review running app" : "Waiting for files",
      icon: Eye,
      state: validationPassed && !isDraft ? "done" : hasFiles ? "active" : "pending",
    },
    {
      label: "GitHub",
      detail: githubReady ? "Repository ready" : deployFlow.githubStatus === "running" ? "Publishing" : "Optional handoff",
      icon: Github,
      state: githubReady ? "done" : deployFlow.githubStatus === "running" ? "active" : "pending",
    },
    {
      label: "Deploy",
      detail: vercelReady ? "Live on Vercel" : deployFlow.vercelStatus === "running" ? "Building" : "Ship when ready",
      icon: Rocket,
      state: vercelReady ? "done" : deployFlow.vercelStatus === "running" ? "active" : "pending",
    },
  ] as const

  return (
    <section
      aria-label="Workspace builder controls"
      className="border-b border-border bg-background px-3 py-3"
    >
      <div className="grid gap-3 xl:grid-cols-[minmax(0,1fr)_minmax(560px,1.25fr)]">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="secondary" className="h-6 gap-1 rounded-md">
              <Sparkles className="h-3.5 w-3.5" />
              AI Builder
            </Badge>
            <Badge variant={isDraft || isDirty ? "outline" : "secondary"} className="h-6 rounded-md">
              {isDraft ? "Draft" : isDirty ? "Unsaved edits" : "Saved"}
            </Badge>
            <Badge variant="outline" className="h-6 rounded-md">v{currentVersion}</Badge>
            <Badge variant="outline" className="h-6 rounded-md">{fileCount} files</Badge>
          </div>
          <h1 className="mt-2 truncate text-base font-semibold text-foreground">
            {projectName || "Swift project"}
          </h1>
          <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <span className="inline-flex items-center gap-1">
              <Code2 className="h-3.5 w-3.5" />
              Prompt to production
            </span>
            <span className="hidden text-border sm:inline">/</span>
            <span>{activeStage}</span>
            <span className="hidden text-border sm:inline">/</span>
            <span>{progressValue}% ready</span>
          </div>
          <div className="mt-3 h-1.5 w-full overflow-hidden rounded-full bg-muted">
            <div
              className="h-full rounded-full bg-gradient-to-r from-sky-500 via-emerald-500 to-amber-500 transition-all"
              style={{ width: `${progressValue}%` }}
            />
          </div>
        </div>

        <div className="grid gap-2 sm:grid-cols-4">
          {flowSteps.map((step, index) => {
            const Icon = step.icon
            const tone = stepStateTone[step.state]

            return (
              <div
                key={step.label}
                className={cn(
                  "relative rounded-lg border px-3 py-3 transition-colors",
                  tone.shell
                )}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className={cn("inline-flex h-7 w-7 items-center justify-center rounded-md", tone.icon)}>
                    <Icon className="h-4 w-4" />
                  </span>
                  <Badge variant="outline" className="h-5 rounded-md bg-background/70 text-[10px]">
                    {tone.badge}
                  </Badge>
                </div>
                <div className="mt-3 flex items-center gap-1 text-sm font-medium text-foreground">
                  <span>{step.label}</span>
                  {index < flowSteps.length - 1 && <ArrowRight className="h-3.5 w-3.5 text-muted-foreground sm:hidden" />}
                </div>
                <div className="mt-1 line-clamp-2 text-xs leading-5 text-muted-foreground">{step.detail}</div>
              </div>
            )
          })}
        </div>
      </div>

      <div className="mt-3 grid gap-3 lg:grid-cols-[minmax(320px,0.9fr)_minmax(300px,0.8fr)]">
        <div className="rounded-lg border border-border bg-background p-3">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2 text-sm font-medium">
              <ShieldCheck className={cn("h-4 w-4", validationPassed && "text-emerald-600", validationFailed && "text-destructive")} />
              Preview validation
            </div>
            <Badge variant={validationFailed ? "destructive" : validationPassed ? "secondary" : "outline"} className="rounded-md">
              {previewValidation.status}
            </Badge>
          </div>
          <div className="mt-2 text-xs text-muted-foreground">
            {previewValidation.message ||
              (fileCount === 0
                ? "No files available to validate yet."
                : previewValidation.checkedAt
                ? `${previewValidation.diagnosticsCount} diagnostics, ${previewValidation.warningCount} warnings`
                : "Run validation before rollback or deploy.")}
          </div>
          <Button
            size="sm"
            variant={validationFailed ? "default" : "outline"}
            className="mt-3 w-full gap-2"
            onClick={onValidatePreview}
            disabled={isValidatingPreview || fileCount === 0}
          >
            {isValidatingPreview ? <Loader2 className="h-4 w-4 animate-spin" /> : <PlayCircle className="h-4 w-4" />}
            Validate preview
          </Button>
        </div>

        <div className="rounded-lg border border-border bg-background p-3">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2 text-sm font-medium">
              <History className="h-4 w-4" />
              Version history
            </div>
            <Badge variant="outline" className="rounded-md">{history.length}</Badge>
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

      <div className="mt-3 flex flex-col gap-3 border-t border-border pt-3 lg:flex-row lg:items-center lg:justify-between">
        <div className="min-w-0 space-y-2">
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <span className="inline-flex items-center gap-1 font-medium text-foreground">
              <GitBranch className="h-3.5 w-3.5" />
              Ship flow
            </span>
            <span className={cn("rounded-md border px-2 py-1", deployStatusTone[deployFlow.githubStatus])}>
              GitHub: {deployStatusLabel[deployFlow.githubStatus]}
            </span>
            <span className={cn("rounded-md border px-2 py-1", deployStatusTone[deployFlow.vercelStatus])}>
              Vercel: {deployStatusLabel[deployFlow.vercelStatus]}
            </span>
          </div>
          {(isDraft || hasShipIssue || deployFlow.message) && (
            <div className="flex min-w-0 items-start gap-2 rounded-md border border-amber-500/25 bg-amber-500/10 px-3 py-2 text-xs text-amber-800 dark:text-amber-200">
              <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <span className="min-w-0 break-words">
                {isDraft
                  ? "Draft sudah bisa diedit, tapi Push/Deploy final menunggu sandbox verified."
                  : deployFlow.message || "Connect GitHub and Vercel tokens on the server to unlock one-click publish."}
              </span>
            </div>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {deployFlow.githubUrl && (
            <Button size="sm" variant="ghost" className="gap-2" asChild>
              <a href={deployFlow.githubUrl} target="_blank" rel="noreferrer">
                <ExternalLink className="h-4 w-4" />
                GitHub
              </a>
            </Button>
          )}
          {deployFlow.vercelUrl && (
            <Button size="sm" variant="ghost" className="gap-2" asChild>
              <a href={deployFlow.vercelUrl} target="_blank" rel="noreferrer">
                <ExternalLink className="h-4 w-4" />
                Vercel
              </a>
            </Button>
          )}
          <Button size="sm" variant="outline" className="gap-2" onClick={onPushGitHub} disabled={isPushingGitHub || isDraft}>
            {isPushingGitHub ? <Loader2 className="h-4 w-4 animate-spin" /> : <Github className="h-4 w-4" />}
            Push GitHub
          </Button>
          <Button size="sm" className="gap-2" onClick={onDeployVercel} disabled={isDeploying || isDraft}>
            {isDeploying ? <Loader2 className="h-4 w-4 animate-spin" /> : <Rocket className="h-4 w-4" />}
            Deploy Vercel
          </Button>
        </div>
      </div>
    </section>
  )
}

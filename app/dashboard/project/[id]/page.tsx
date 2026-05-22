"use client"

import { useState, useCallback, useEffect, useMemo, useRef } from "react"
import { useParams } from "next/navigation"
import { EditorHeader } from "@/components/editor/header"
import { ChatPanel } from "@/components/editor/chat-panel"
import { PreviewPanel } from "@/components/editor/preview-panel"
import { ErrorLogPanel } from "@/components/editor/error-log-panel"
import { DeveloperDiagnosticsPanel, type DeveloperDiagnosticsSnapshot } from "@/components/editor/developer-diagnostics-panel"
import {
  WorkspaceCommandCenter,
  type DeployFlowState,
  type PreviewValidationState,
  type ProjectHistoryEntry,
} from "@/components/editor/workspace-command-center"
import { ResizablePanelGroup, ResizablePanel, ResizableHandle } from "@/components/ui/resizable"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { useIsMobile } from "@/hooks/use-mobile"
import { DEFAULT_MODEL_KEY, DEFAULT_MODEL_OPTIONS } from "@/lib/ai/models"
import type { CollaborationMode } from "@/lib/ai/collaboration-mode"
import { buildPreviewContextPacket } from "@/lib/ai/preview-context"
import type { PromptLanguage } from "@/lib/ai/prompt-templates"
import type { GeneratedFile, ModelOption, PreviewContext, PreviewViewport, PromptAttachment } from "@/lib/types"
import {
  splitWorkspaceStateFiles,
  normalizeFileLanguage,
  readWorkspaceStateFile,
  buildWorkspaceStateFile,
  createWorkspaceStateSnapshot,
  type ValidLanguage,
  type WorkspaceState,
} from "@/lib/workspace-state"
import { ChevronDown } from "lucide-react"

const MAX_PROMPT_LENGTH = 12000

function readGenerationTimeoutMs() {
  const value = Number(
    process.env.NEXT_PUBLIC_SWIFT_GENERATION_JOB_TIMEOUT_MS ||
      process.env.SWIFT_GENERATION_JOB_TIMEOUT_MS ||
      600000
  )
  return Number.isFinite(value) ? Math.max(10_000, value) : 600000
}

const GENERATE_BACKEND_TIMEOUT_MS = readGenerationTimeoutMs()
const GENERATE_CLIENT_TIMEOUT_MS = GENERATE_BACKEND_TIMEOUT_MS + 15_000
const GENERATE_CLIENT_TIMEOUT_SECONDS = Math.round(GENERATE_CLIENT_TIMEOUT_MS / 1000)

function buildClientWorkPlan(prompt: string, mode: CollaborationMode, language: PromptLanguage) {
  const shortPrompt = prompt.replace(/\s+/g, " ").trim().slice(0, 120)
  if (language === "en") {
    return [
      `Confirm direction: ${shortPrompt}`,
      mode === "fix"
        ? "Find the smallest likely root cause before editing."
        : mode === "edit"
          ? "Select the smallest file scope that can satisfy the edit."
          : "Create the main visible page first.",
      mode === "build" ? "Keep generated files aligned with the prompt keywords." : "Preserve stable files outside the edit scope.",
      "Validate build and runtime before saving and opening preview.",
    ]
  }

  return [
    `Tangkap arah prompt: ${shortPrompt}`,
    mode === "fix"
      ? "Cari akar masalah terkecil sebelum patch."
      : mode === "edit"
        ? "Pilih scope file terkecil yang cukup untuk edit ini."
        : "Bangun halaman utama yang langsung terlihat.",
    mode === "build" ? "Jaga file tetap sesuai keyword prompt." : "Pertahankan file stabil di luar scope edit.",
    "Validasi build dan runtime sebelum disimpan dan dipreview.",
  ]
}

function mapJobStageToProgressStage(
  stage: string,
  status: string
): GenerationProgress["stage"] {
  if (status === "completed") return "preview"
  if (status === "failed") return "error"
  if (status === "cancelled" || status === "cancelling") return "cancelled"

  if (
    stage === "context" ||
    stage === "request" ||
    stage === "provider" ||
    stage === "parse" ||
    stage === "validate" ||
    stage === "save" ||
    stage === "preview" ||
    stage === "timeout" ||
    stage === "cancelled" ||
    stage === "error"
  ) {
    return stage
  }

  if (stage === "generating") return "provider"
  if (stage === "planning") return "request"
  if (stage === "scaffolding") return "provider"
  if (stage === "parsing" || stage === "normalizing") return "parse"
  if (stage === "validating" || stage === "typechecking" || stage === "linting" || stage === "repairing") return "validate"
  if (stage === "building" || stage === "compiling") return "preview"
  if (stage === "persisting" || stage === "saving") return "save"

  return "context"
}

const normalizeLanguage = (value: unknown): ValidLanguage => {
  const candidate = typeof value === "string" ? value : ""
  return normalizeFileLanguage(candidate) || "tsx"
}

const AUTOSAVE_DEBOUNCE_MS = 1200
const WORKSPACE_DRAFT_STORAGE_PREFIX = "swift-workspace-draft"

type WorkspaceDraft = {
  files: GeneratedFile[]
  workspaceState: WorkspaceState
}

const normalizeWorkspacePath = (path: string) => path.replace(/\\/g, "/").replace(/^\.\//, "").trim()

const normalizeWorkspaceFiles = (files: GeneratedFile[]) =>
  splitWorkspaceStateFiles(files).files.map((file) => ({
    path: normalizeWorkspacePath(file.path),
    content: String(file.content || ""),
    language: normalizeLanguage(file.language),
  }))

type StreamedGeneratedFilesPayload = {
  source?: string
  fileCount?: number
  manifest?: unknown
  fileDiff?: unknown
}

const buildWorkspaceDraftKey = (projectId: string) => `${WORKSPACE_DRAFT_STORAGE_PREFIX}:${projectId}`

function readWorkspaceDraftFromStorage(projectId: string): WorkspaceDraft | null {
  if (typeof window === "undefined") {
    return null
  }

  const rawDraft = window.localStorage.getItem(buildWorkspaceDraftKey(projectId))
  if (!rawDraft) {
    return null
  }

  try {
    const parsed = JSON.parse(rawDraft) as Partial<WorkspaceDraft>
    const files = Array.isArray(parsed.files) ? normalizeWorkspaceFiles(parsed.files) : []
    const workspaceState = readWorkspaceStateFile(
      parsed.workspaceState
        ? buildWorkspaceStateFile(parsed.workspaceState as WorkspaceState)
        : null
    )

    if (!workspaceState || files.length === 0) {
      return null
    }

    return {
      files,
      workspaceState,
    }
  } catch {
    return null
  }
}

const buildWorkspaceFingerprint = (files: GeneratedFile[], lockedPaths: string[]) =>
  `${files
    .map((file) => `${normalizeWorkspacePath(file.path)}:${file.language}:${file.content}`)
    .join("|")}::${Array.from(new Set(lockedPaths.map(normalizeWorkspacePath))).sort().join(",")}`

const getActiveFilePath = (files: GeneratedFile[], activeFileIndex: number) =>
  files[activeFileIndex]?.path || null

const updateProtectedPathsForUserChange = (
  previousFiles: GeneratedFile[],
  nextFiles: GeneratedFile[],
  existingProtectedPaths: string[]
) => {
  const previousByPath = new Map(previousFiles.map((file) => [normalizeWorkspacePath(file.path), file]))
  const nextPaths = new Set(nextFiles.map((file) => normalizeWorkspacePath(file.path)))
  const nextProtected = new Set(existingProtectedPaths.map(normalizeWorkspacePath).filter(Boolean))

  for (const previous of previousFiles) {
    const previousPath = normalizeWorkspacePath(previous.path)
    if (!nextPaths.has(previousPath)) {
      nextProtected.delete(previousPath)
    }
  }

  for (const file of nextFiles) {
    const normalizedPath = normalizeWorkspacePath(file.path)
    const previous = previousByPath.get(normalizedPath)
    const hasChanged =
      !previous ||
      previous.content !== file.content ||
      normalizeLanguage(previous.language) !== normalizeLanguage(file.language)

    if (hasChanged) {
      nextProtected.add(normalizedPath)
    }
  }

  return Array.from(nextProtected).sort()
}

const buildWorkspaceStateSnapshot = (input: {
  version: number
  dirty: boolean
  lockedPaths: string[]
  activeFilePath: string | null
}) =>
  createWorkspaceStateSnapshot({
    version: input.version,
    dirty: input.dirty,
    lockedPaths: input.lockedPaths,
    activeFilePath: input.activeFilePath,
  })

export type Message = {
  id: string
  role: "user" | "assistant"
  content: string
  timestamp: Date
  generatedCode?: string
  isGenerating?: boolean
  metadata?: {
    model?: string
    cost?: number
    remainingBalance?: number
    failSafeType?: "strict-fullstack"
    attachments?: string[]
    mode?: CollaborationMode
  }
}

export type ProviderStatus = {
  status: "connected" | "slow" | "error"
  issue?: "healthy" | "latency" | "auth" | "quota" | "config" | "unknown"
  reason?: string
  action?: string
  responseTimeMs?: number
  checkedAt?: string
}

function publicGenerationErrorMessage(message: string) {
  if (
    /MALFORMED_GENERATED_ARTIFACT|Unrecognized key\(s\)|strict-json-schema|required|PATH_ERROR|diagnostic payload/i.test(message)
  ) {
    return "AI generated invalid project structure. Repair loop attempting automatic correction..."
  }
  return message
}

export type GenerationProgress = {
  stage:
    | "context"
    | "request"
    | "provider"
    | "parse"
    | "validate"
    | "save"
    | "preview"
    | "timeout"
    | "cancelled"
    | "error"
  label: string
  startedAt: Date
  timeoutMs: number
  modelKey?: string
  prompt?: string
  workPlan?: string[]
  jobId?: string
  progressPercent?: number
}

type ErrorLogEntry = {
  id: string
  source: "project" | "provider" | "generate" | "preview" | "save" | "export" | "deploy" | "github"
  message: string
  timestamp: Date
}

export default function EditorPage() {
  const params = useParams()
  const projectId = params.id as string
  const isMobile = useIsMobile()

  const [messages, setMessages] = useState<Message[]>([])
  const [generatedFiles, setGeneratedFiles] = useState<GeneratedFile[]>([])
  const [previewFiles, setPreviewFiles] = useState<GeneratedFile[] | null>(null)
  const [currentVersion, setCurrentVersion] = useState(0)
  const [activeFileIndex, setActiveFileIndex] = useState(0)
  const [isGenerating, setIsGenerating] = useState(false)
  const [generationProgress, setGenerationProgress] = useState<GenerationProgress | null>(null)
  const [isSavingFiles, setIsSavingFiles] = useState(false)
  const [isLoadingProject, setIsLoadingProject] = useState(true)
  const [projectError, setProjectError] = useState<string | null>(null)
  const [isDirty, setIsDirty] = useState(false)
  const [activePreviewTab, setActivePreviewTab] = useState<"preview" | "code" | "explorer">("preview")
  const [providerStatus, setProviderStatus] = useState<ProviderStatus | null>(null)
  const [selectedModel, setSelectedModel] = useState(DEFAULT_MODEL_KEY)
  const [availableModels, setAvailableModels] = useState<ModelOption[]>([])
  const [mobileView, setMobileView] = useState<"chat" | "preview">("chat")
  const [layoutPreset, setLayoutPreset] = useState<"prompt" | "balanced" | "preview">("preview")
  const [layoutRenderKey, setLayoutRenderKey] = useState(0)
  const [isExporting, setIsExporting] = useState(false)
  const [isDeploying, setIsDeploying] = useState(false)
  const [isPushingGitHub, setIsPushingGitHub] = useState(false)
  const [isValidatingPreview, setIsValidatingPreview] = useState(false)
  const [isRollingBackVersion, setIsRollingBackVersion] = useState(false)
  const [deploymentUrl, setDeploymentUrl] = useState<string | null>(null)
  const [projectHistory, setProjectHistory] = useState<ProjectHistoryEntry[]>([])
  const [previewValidation, setPreviewValidation] = useState<PreviewValidationState>({
    status: "idle",
    diagnosticsCount: 0,
    warningCount: 0,
    message: null,
  })
  const [deployFlow, setDeployFlow] = useState<DeployFlowState>({
    githubStatus: "idle",
    vercelStatus: "idle",
    githubUrl: null,
    vercelUrl: null,
    message: null,
  })
  const [errorLogs, setErrorLogs] = useState<ErrorLogEntry[]>([])
  const [showLogsPanel, setShowLogsPanel] = useState(false)
  const [developerDiagnostics, setDeveloperDiagnostics] = useState<DeveloperDiagnosticsSnapshot | null>(null)
  const [showDeveloperDiagnostics, setShowDeveloperDiagnostics] = useState(false)
  const [latestPreviewError, setLatestPreviewError] = useState<string | null>(null)
  const [runtimePreviewUrl, setRuntimePreviewUrl] = useState<string | null>(null)
  const [customDomain, setCustomDomain] = useState<string | null>(null)
  const [, setDomainVerified] = useState<boolean>(false)
  const [subscriptionPlan, setSubscriptionPlan] = useState<string>("free")
  const [subscriptionStatus, setSubscriptionStatus] = useState<string>("active")
  const [previewViewport, setPreviewViewport] = useState<PreviewViewport>("desktop")
  const [projectName, setProjectName] = useState<string | null>(null)
  const [projectTemplateId, setProjectTemplateId] = useState<string | null>(null)
  const [projectPrompt, setProjectPrompt] = useState<string | null>(null)
  const [shouldAutoGeneratePrompt, setShouldAutoGeneratePrompt] = useState(false)
  const [hasAutoGeneratedFromPrompt, setHasAutoGeneratedFromPrompt] = useState(false)
  const [workspaceRestoreNotice, setWorkspaceRestoreNotice] = useState<string | null>(null)
  const [streamLockedPaths, setStreamLockedPaths] = useState<string[]>([])
  const activeGenerateControllerRef = useRef<AbortController | null>(null)
  const activeGenerateTimeoutRef = useRef<number | null>(null)
  const activeGenerateWasCancelledRef = useRef(false)
  const activeGenerationJobIdRef = useRef<string | null>(null)
  const activeGenerationStreamRef = useRef<EventSource | null>(null)
  const activeGenerationReconnectAttemptsRef = useRef(0)
  const activeGenerationLastEventIdRef = useRef("0")
  const activeGenerationReconnectTimerRef = useRef<number | null>(null)
  const streamedGenerationFilesSeenRef = useRef(false)
  const workspaceProtectedPathsRef = useRef<string[]>([])
  const workspaceAutosaveTimerRef = useRef<number | null>(null)
  const workspaceDraftFingerprintRef = useRef<string | null>(null)
  const workspaceSaveFingerprintRef = useRef<string | null>(null)
  const workspaceDraftRef = useRef<WorkspaceDraft | null>(null)
  const projectRefreshSequenceRef = useRef(0)

  const latestUserPrompt = useMemo(() => {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index]
      if (message.role === "user" && message.content.trim()) {
        return message.content.trim()
      }
    }

    return projectPrompt || "Manual code edit save"
  }, [messages, projectPrompt])

  const closeGenerationStream = useCallback(() => {
    if (activeGenerationReconnectTimerRef.current !== null) {
      window.clearTimeout(activeGenerationReconnectTimerRef.current)
      activeGenerationReconnectTimerRef.current = null
    }
    activeGenerationStreamRef.current?.close()
    activeGenerationStreamRef.current = null
    activeGenerationReconnectAttemptsRef.current = 0
  }, [])

  const clearGenerateDeadline = useCallback(() => {
    if (activeGenerateTimeoutRef.current !== null) {
      window.clearTimeout(activeGenerateTimeoutRef.current)
      activeGenerateTimeoutRef.current = null
    }
  }, [])

  const refreshProjectState = useCallback(async (reason = "project-load") => {
    const refreshSequence = projectRefreshSequenceRef.current + 1
    projectRefreshSequenceRef.current = refreshSequence
    const response = await fetch(`/api/projects/${projectId}?reason=${encodeURIComponent(reason)}`)
    const data = await response.json()
    if (!response.ok) {
      throw new Error(data.error || "Failed to refresh project")
    }
    if (refreshSequence < projectRefreshSequenceRef.current) {
      console.info(JSON.stringify({
        level: "info",
        msg: "project_refresh_ignored",
        projectId,
        reason,
        refreshSequence,
        latestRefreshSequence: projectRefreshSequenceRef.current,
        manifestHash: data.project?.fileState?.manifest?.sha256 || null,
        latestUpdatedAt: data.project?.fileState?.latestUpdatedAt || null,
      }))
      return
    }

    const serverFiles = Array.isArray(data.project?.files)
      ? data.project.files.map((file: GeneratedFile) => ({
          path: file.path,
          content: file.content,
          language: normalizeLanguage(file.language),
        }))
      : []
    const serverHistory: ProjectHistoryEntry[] = Array.isArray(data.project?.history)
      ? data.project.history.map((entry: ProjectHistoryEntry) => ({
          id: String(entry.id),
          prompt: String(entry.prompt || "Snapshot"),
          intent: typeof entry.intent === "string" ? entry.intent : null,
          usedAutoRepair: Boolean(entry.usedAutoRepair),
          createdAt: String(entry.createdAt),
          fileCount: Number(entry.fileCount || 0),
        }))
      : []
    const { files } = splitWorkspaceStateFiles(serverFiles)
    const expectedFileCount = Number(data.project?.fileState?.count ?? files.length)
    if (expectedFileCount !== files.length) {
      throw new Error(`Explorer file count mismatch. API=${expectedFileCount}, client=${files.length}`)
    }
    const serverWorkspaceState =
      readWorkspaceStateFile(
        data.project?.workspaceState
          ? buildWorkspaceStateFile(data.project.workspaceState as WorkspaceState)
          : null
      ) ||
      buildWorkspaceStateSnapshot({
        version: data.project?.history?.length || (files.length > 0 ? 1 : 0),
        dirty: false,
        lockedPaths: [],
        activeFilePath: files[0]?.path || null,
      })

    setGeneratedFiles(files)
    setProjectHistory(serverHistory)
    setPreviewFiles(null)
    if (reason === "project-load") {
      setRuntimePreviewUrl(null)
    }
    setCurrentVersion(serverWorkspaceState.version)
    setActiveFileIndex(0)
    setIsDirty(false)
    setStreamLockedPaths([])
    workspaceProtectedPathsRef.current = serverWorkspaceState.lockedPaths
    if (reason === "generation-completed" || reason === "explorer-refresh" || reason === "filesystem-persisted") {
      console.info(JSON.stringify({
        level: "info",
        msg: "explorer_refreshed",
        projectId,
        fileCount: files.length,
        latestHistoryId: data.project?.fileState?.latestHistoryId || null,
        latestUpdatedAt: data.project?.fileState?.latestUpdatedAt || null,
        manifestHash: data.project?.fileState?.manifest?.sha256 || null,
      }))
    }
  }, [projectId])

  const pushErrorLog = useCallback((
    source: ErrorLogEntry["source"],
    message: string
  ) => {
    const trimmed = message.trim()
    if (!trimmed) return

    setErrorLogs((previous) => [
      {
        id:
          typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
            ? crypto.randomUUID()
            : `${Date.now()}_${Math.random().toString(36).slice(2, 10)}`,
        source,
        message: trimmed,
        timestamp: new Date(),
      },
      ...previous,
    ].slice(0, 100))
  }, [])

  const applyStreamedGeneratedFiles = useCallback((rawPayload: unknown) => {
    const payload = rawPayload && typeof rawPayload === "object"
      ? rawPayload as { data?: StreamedGeneratedFilesPayload } & StreamedGeneratedFilesPayload
      : null
    const data = payload?.data && typeof payload.data === "object" ? payload.data : payload

    if (data?.source !== "persisted") {
      console.info(JSON.stringify({
        level: "info",
        msg: "streamed_files_ignored",
        projectId,
        reason: "explorer_uses_project_api_as_source_of_truth",
        source: data?.source || null,
        fileCount: data?.fileCount ?? null,
      }))
      return
    }

    void refreshProjectState("filesystem-persisted").catch((error) => {
      const message = error instanceof Error ? error.message : "Gagal refresh Explorer setelah file tersimpan."
      pushErrorLog("project", message)
    })

    if (!streamedGenerationFilesSeenRef.current) {
      streamedGenerationFilesSeenRef.current = true
      setActivePreviewTab("explorer")
    }

    console.info(JSON.stringify({
      level: "info",
      msg: "filesystem_persisted_refresh_requested",
      projectId,
      manifest: data?.manifest || null,
      fileDiff: data?.fileDiff || null,
    }))
  }, [projectId, pushErrorLog, refreshProjectState])

  const applyPreviewReady = useCallback((rawPayload: unknown) => {
    const payload = rawPayload && typeof rawPayload === "object"
      ? rawPayload as { data?: { previewUrl?: string | null; historyId?: string | null; fileCount?: number | null; previewStatus?: string | null } }
      : null
    const data = payload?.data || {}
    const previewUrl = typeof data.previewUrl === "string" && data.previewUrl.trim()
      ? data.previewUrl.trim()
      : null

    console.info(JSON.stringify({
      level: "info",
      msg: "preview_ready_received",
      projectId,
      previewUrl,
      historyId: data.historyId || null,
      fileCount: data.fileCount ?? null,
      previewStatus: data.previewStatus || null,
    }))

    if (previewUrl) {
      setRuntimePreviewUrl(previewUrl)
    }

    void refreshProjectState("generation-completed").then(() => {
      setActivePreviewTab("preview")
    }).catch((error) => {
      const message = error instanceof Error ? error.message : "Gagal refresh preview setelah file siap."
      pushErrorLog("project", message)
    })
  }, [projectId, pushErrorLog, refreshProjectState])

  const applyJobProgress = useCallback((job: {
    id: string
    stage: string
    status: string
    label: string
    progress: number
    prompt?: string
    model?: string
    plan?: string[]
    createdAt?: string
  }) => {
    const mappedStage = mapJobStageToProgressStage(job.stage, job.status)
    setGenerationProgress((current) => ({
      stage: mappedStage,
      label: job.label || current?.label || "Swift sedang bekerja",
      startedAt: current?.startedAt || (job.createdAt ? new Date(job.createdAt) : new Date()),
      timeoutMs: current?.timeoutMs || GENERATE_CLIENT_TIMEOUT_MS,
      modelKey: job.model || current?.modelKey,
      prompt: job.prompt || current?.prompt,
      workPlan: Array.isArray(job.plan) && job.plan.length > 0 ? job.plan : current?.workPlan,
      jobId: job.id,
      progressPercent: job.progress,
    }))
  }, [])

  const startGenerationStream = useCallback((jobId: string, reconnectAttempt = 0) => {
    closeGenerationStream()
    activeGenerationReconnectAttemptsRef.current = reconnectAttempt
    const lastEventId = activeGenerationLastEventIdRef.current || "0"
    const stream = new EventSource(`/api/generate/jobs/${jobId}/stream?lastEventId=${encodeURIComponent(lastEventId)}`)
    activeGenerationStreamRef.current = stream

    const recordEventId = (event: MessageEvent) => {
      if (event.lastEventId) {
        activeGenerationLastEventIdRef.current = event.lastEventId
      }
    }

    stream.addEventListener("job", (event) => {
      try {
        recordEventId(event as MessageEvent)
        const job = JSON.parse((event as MessageEvent).data)
        applyJobProgress(job)
        if (typeof job.previewUrl === "string" && job.previewUrl.trim()) {
          setRuntimePreviewUrl(job.previewUrl.trim())
        }
        if (["completed", "failed", "cancelled"].includes(job.status)) {
          console.log("sse_closed")
          stream.close()
          clearGenerateDeadline()
          activeGenerateControllerRef.current = null
          activeGenerationJobIdRef.current = null
          activeGenerateWasCancelledRef.current = false
          if (activeGenerationStreamRef.current === stream) {
            activeGenerationStreamRef.current = null
          }
          if (job.status === "completed") {
            setGenerationProgress((current) =>
              current
                ? {
                    ...current,
                    stage: "save",
                    label: "Mengambil file project terbaru",
                    progressPercent: Math.max(current.progressPercent ?? 0, 98),
                  }
                : current
            )
            void (async () => {
              try {
                await refreshProjectState("generation-completed")
                if (typeof job.previewUrl === "string" && job.previewUrl.trim()) {
                  setRuntimePreviewUrl(job.previewUrl.trim())
                }
                setActivePreviewTab("preview")
                setMessages((prev) =>
                  prev.map((msg) =>
                    msg.isGenerating
                      ? {
                          ...msg,
                          content: "Swift menyelesaikan generation job. File project dan preview sudah diperbarui dari worker.",
                          isGenerating: false,
                        }
                      : msg
                  )
                )
                setGenerationProgress((current) =>
                  current
                    ? {
                        ...current,
                        stage: "preview",
                        label: "Preview siap",
                        progressPercent: 100,
                      }
                    : current
                )
                setStreamLockedPaths([])
              } catch (error) {
                const message = error instanceof Error ? error.message : String(error)
                pushErrorLog("project", `Generation selesai, tapi refresh file gagal: ${message}`)
                setMessages((prev) =>
                  prev.map((msg) =>
                    msg.isGenerating
                      ? {
                          ...msg,
                          content: "Generation selesai, tapi file project belum bisa dimuat ulang. Coba refresh halaman atau buka Logs.",
                          isGenerating: false,
                        }
                      : msg
                  )
                )
                setGenerationProgress((current) =>
                  current
                    ? {
                        ...current,
                        stage: "error",
                        label: "Refresh file gagal",
                        progressPercent: 100,
                      }
                    : current
                )
              } finally {
                setIsGenerating(false)
                window.setTimeout(() => setGenerationProgress(null), 1600)
              }
            })()
            return
          }
          if (job.status === "failed") {
            const message = publicGenerationErrorMessage(job.error || job.label || "Generate gagal. Buka Logs untuk detail error.")
            pushErrorLog("generate", message)
            setShowLogsPanel(true)
            setMessages((prev) =>
              prev.map((msg) =>
                msg.isGenerating
                  ? {
                      ...msg,
                      content: message,
                      isGenerating: false,
                    }
                  : msg
              )
            )
          }
          setStreamLockedPaths([])
          setIsGenerating(false)
          window.setTimeout(() => setGenerationProgress(null), 1200)
        }
      } catch {
        // Ignore malformed progress events and keep the existing client-side state.
      }
    })

    stream.addEventListener("developer.diagnostics", (event) => {
      try {
        recordEventId(event as MessageEvent)
        const payload = JSON.parse((event as MessageEvent).data) as DeveloperDiagnosticsSnapshot
        setDeveloperDiagnostics(payload)
      } catch {
        // Developer diagnostics are optional and should never interrupt generation.
      }
    })

    stream.addEventListener("job.files.updated", (event) => {
      try {
        recordEventId(event as MessageEvent)
        const payload = JSON.parse((event as MessageEvent).data)
        applyStreamedGeneratedFiles(payload)
      } catch (error) {
        const message = error instanceof Error ? error.message : "Gagal membaca update file dari stream."
        pushErrorLog("project", message)
      }
    })

    stream.addEventListener("job.files.persisted", (event) => {
      try {
        recordEventId(event as MessageEvent)
        const payload = JSON.parse((event as MessageEvent).data)
        applyStreamedGeneratedFiles(payload)
      } catch (error) {
        const message = error instanceof Error ? error.message : "Gagal membaca status persist file dari stream."
        pushErrorLog("project", message)
      }
    })

    stream.addEventListener("files_written", (event) => {
      try {
        recordEventId(event as MessageEvent)
        const payload = JSON.parse((event as MessageEvent).data)
        applyStreamedGeneratedFiles(payload)
      } catch (error) {
        const message = error instanceof Error ? error.message : "Gagal membaca event files_written dari stream."
        pushErrorLog("project", message)
      }
    })

    stream.addEventListener("preview_ready", (event) => {
      try {
        recordEventId(event as MessageEvent)
        const payload = JSON.parse((event as MessageEvent).data)
        applyPreviewReady(payload)
      } catch (error) {
        const message = error instanceof Error ? error.message : "Gagal membaca event preview_ready dari stream."
        pushErrorLog("project", message)
      }
    })

    stream.onerror = () => {
      console.log("sse_closed")
      stream.close()
      if (activeGenerationStreamRef.current === stream) {
        activeGenerationStreamRef.current = null
      }
      const nextAttempt = activeGenerationReconnectAttemptsRef.current + 1
      if (nextAttempt > 5) {
        setGenerationProgress((current) =>
          current
            ? {
                ...current,
                stage: "error",
                label: "Progress stream disconnected",
              }
            : current
        )
        setIsGenerating(false)
        clearGenerateDeadline()
        activeGenerateControllerRef.current = null
        activeGenerationJobIdRef.current = null
        return
      }
      const delay = Math.min(10_000, 1000 * 2 ** (nextAttempt - 1))
      activeGenerationReconnectTimerRef.current = window.setTimeout(() => {
        startGenerationStream(jobId, nextAttempt)
      }, delay)
    }
  }, [applyJobProgress, applyPreviewReady, applyStreamedGeneratedFiles, clearGenerateDeadline, closeGenerationStream, pushErrorLog, refreshProjectState])

  useEffect(() => {
    return () => {
      closeGenerationStream()
      clearGenerateDeadline()
      activeGenerateControllerRef.current?.abort()
      if (workspaceAutosaveTimerRef.current !== null) {
        window.clearTimeout(workspaceAutosaveTimerRef.current)
        workspaceAutosaveTimerRef.current = null
      }
    }
  }, [clearGenerateDeadline, closeGenerationStream])

  useEffect(() => {
    if (generatedFiles.length === 0) {
      if (activeFileIndex !== 0) {
        setActiveFileIndex(0)
      }
      return
    }

    if (activeFileIndex >= generatedFiles.length) {
      setActiveFileIndex(generatedFiles.length - 1)
    }
  }, [activeFileIndex, generatedFiles.length])

  const createIdempotencyKey = useCallback((prompt: string, modelKey: string, attachments: PromptAttachment[], previewContext?: PreviewContext | null) => {
    const attachmentFingerprint = attachments
      .map((attachment) => `${attachment.storagePath || attachment.originalName || attachment.name}:${attachment.kind}:${attachment.size}:${attachment.content.slice(0, 48)}`)
      .join("|")
    const previewFingerprint = previewContext
      ? [
          previewContext.projectId,
          previewContext.activeTab,
          previewContext.viewport,
          previewContext.activeFilePath || "",
          previewContext.activeFileLanguage || "",
          previewContext.previewError?.message || "",
          previewContext.previewFiles
            .slice(0, 6)
            .map((file) => `${file.path}:${file.size}:${file.isActive ? "active" : "preview"}`)
            .join("|"),
        ].join(":")
      : ""
    const base = `${projectId}:${modelKey}:${prompt.trim().toLowerCase()}:${attachmentFingerprint}:${previewFingerprint}`
    const hash = Array.from(base).reduce((acc, char, index) => {
      return (acc * 33 + char.charCodeAt(0) + index) % 2147483647
    }, 5381)

    const nonce =
      typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
        ? crypto.randomUUID().slice(0, 8)
        : Math.random().toString(36).slice(2, 10)

    return `gen_${hash.toString(36)}_${Date.now().toString(36)}_${nonce}`
  }, [projectId])

  useEffect(() => {
    let isMounted = true

    const loadProject = async () => {
      setIsLoadingProject(true)
      setProjectError(null)
      setMessages([])
      setGeneratedFiles([])
      setPreviewFiles(null)
      setCurrentVersion(0)
      setActiveFileIndex(0)
      setIsGenerating(false)
      setIsSavingFiles(false)
      setIsDirty(false)
      setActivePreviewTab("preview")
      setProviderStatus(null)
      setShowLogsPanel(false)
      setLatestPreviewError(null)
      setCustomDomain(null)
      setDomainVerified(false)
      setSubscriptionPlan("free")
      setSubscriptionStatus("active")
      setPreviewViewport("desktop")
      setProjectName(null)
      setProjectTemplateId(null)
      setProjectPrompt(null)
      setShouldAutoGeneratePrompt(false)
      setHasAutoGeneratedFromPrompt(false)
      setWorkspaceRestoreNotice(null)
      workspaceProtectedPathsRef.current = []
      if (workspaceAutosaveTimerRef.current !== null) {
        window.clearTimeout(workspaceAutosaveTimerRef.current)
        workspaceAutosaveTimerRef.current = null
      }
      workspaceDraftFingerprintRef.current = null
      workspaceSaveFingerprintRef.current = null
      workspaceDraftRef.current = null
      streamedGenerationFilesSeenRef.current = false

      try {
        const response = await fetch(`/api/projects/${projectId}`)
        const data = await response.json()

        if (!response.ok) {
          throw new Error(data.error || "Failed to load project")
        }

        if (!isMounted) return

        const serverFiles = Array.isArray(data.project?.files)
          ? data.project.files.map((file: GeneratedFile) => ({
              path: file.path,
              content: file.content,
              language: normalizeLanguage(file.language),
            }))
          : []
        const { files: visibleServerFiles } = splitWorkspaceStateFiles(serverFiles)
        const serverWorkspaceState =
          readWorkspaceStateFile(
            data.project?.workspaceState
              ? buildWorkspaceStateFile(data.project.workspaceState as WorkspaceState)
              : null
          ) ||
          buildWorkspaceStateSnapshot({
            version: data.project?.history?.length || (visibleServerFiles.length > 0 ? 1 : 0),
            dirty: false,
            lockedPaths: [],
            activeFilePath: visibleServerFiles[0]?.path || null,
          })
          const localDraft = readWorkspaceDraftFromStorage(projectId)
        const serverFingerprint = buildWorkspaceFingerprint(
          visibleServerFiles,
          serverWorkspaceState.lockedPaths
        )
        const localFingerprint = localDraft
          ? buildWorkspaceFingerprint(localDraft.files, localDraft.workspaceState.lockedPaths)
          : null
        const shouldRestoreDraft = Boolean(
          localDraft && (localDraft.workspaceState.dirty || localFingerprint !== serverFingerprint)
        )
        const nextFiles = shouldRestoreDraft ? localDraft!.files : visibleServerFiles
        const nextProtectedPaths = shouldRestoreDraft
          ? localDraft!.workspaceState.lockedPaths
          : serverWorkspaceState.lockedPaths

        workspaceProtectedPathsRef.current = nextProtectedPaths
        workspaceDraftRef.current = shouldRestoreDraft ? localDraft : null
        if (shouldRestoreDraft && localDraft) {
          workspaceDraftFingerprintRef.current = buildWorkspaceFingerprint(
            localDraft.files,
            localDraft.workspaceState.lockedPaths
          )
          setWorkspaceRestoreNotice("Pulihkan perubahan lokal yang belum tersimpan.")
        }

        setGeneratedFiles(nextFiles)
        setActiveFileIndex(0)
        setCurrentVersion(serverWorkspaceState.version)
        setProjectName(data.project?.name || null)
        setProjectTemplateId(data.project?.templateId || null)
        setProjectPrompt(typeof data.project?.prompt === "string" ? data.project.prompt.trim() || null : null)
        setCustomDomain(data.project?.customDomain || null)
        setDomainVerified(Boolean(data.project?.domainVerified))
        setSubscriptionPlan(data.project?.workspace?.subscription?.plan || "free")
        setSubscriptionStatus(data.project?.workspace?.subscription?.status || "active")
        setShouldAutoGeneratePrompt(
          Boolean(data.project?.prompt?.trim()) &&
            (data.project?.history?.length || 0) === 0 &&
            visibleServerFiles.length === 0
        )
        setIsDirty(Boolean(shouldRestoreDraft && localDraft?.workspaceState.dirty))
      } catch (error) {
        if (!isMounted) return
        const message = error instanceof Error ? error.message : "Failed to load project"
        setProjectError(message)
        pushErrorLog("project", message)
      } finally {
        if (isMounted) {
          setIsLoadingProject(false)
        }
      }
    }

    void loadProject()

    return () => {
      isMounted = false
    }
  }, [projectId, pushErrorLog])

  useEffect(() => {
    let isMounted = true

    const loadModels = async () => {
      try {
        const response = await fetch("/api/models")
        if (!response.ok) {
          setAvailableModels(DEFAULT_MODEL_OPTIONS)
          setSelectedModel(DEFAULT_MODEL_KEY)
          return
        }

        const data = await response.json()
        if (!isMounted || !Array.isArray(data.models) || data.models.length === 0) {
          setAvailableModels(DEFAULT_MODEL_OPTIONS)
          setSelectedModel(DEFAULT_MODEL_KEY)
          return
        }

        const normalizedModels: ModelOption[] = data.models.map((model: ModelOption) => ({
          ...model,
          key: model.key,
          label:
            model.label ||
            DEFAULT_MODEL_OPTIONS.find((option) => option.key === model.key)?.label ||
            model.modelName ||
            model.key,
          provider: model.provider,
          modelName: model.modelName,
          price: model.price,
          isActive: model.isActive,
          rank: model.rank,
          description: model.description,
          note: model.note,
        }))

        setAvailableModels(normalizedModels)

        if (!normalizedModels.some((model) => model.key === selectedModel)) {
          setSelectedModel(normalizedModels[0].key)
        }
      } catch {
        if (!isMounted) return
        setAvailableModels(DEFAULT_MODEL_OPTIONS)
        setSelectedModel(DEFAULT_MODEL_KEY)
      }
    }

    void loadModels()

    return () => {
      isMounted = false
    }
  }, [selectedModel])

  useEffect(() => {
    setProviderStatus(null)
  }, [selectedModel])

  const buildProviderStatusFromError = useCallback((errorMessage: string): ProviderStatus => {
    const normalized = errorMessage.toLowerCase()

    if (
      normalized.includes("unauthorized client") ||
      normalized.includes("unauthenticated") ||
      normalized.includes("authentication or model access") ||
      normalized.includes("api error (401)") ||
      normalized.includes("api error (403)")
    ) {
      return {
        status: "error",
        issue: "auth",
        reason: "Swift AI engine rejected authentication or model access",
        action: "Hubungi admin atau cek konfigurasi Swift engine di dashboard production.",
        checkedAt: new Date().toISOString(),
      }
    }

    if (
      normalized.includes("quota") ||
      normalized.includes("api error (402)") ||
      normalized.includes("requires more credits") ||
      normalized.includes("more credits") ||
      normalized.includes("can only afford") ||
      normalized.includes("fewer max_tokens") ||
      normalized.includes("insufficient_user_quota") ||
      normalized.includes("额度不足")
    ) {
      return {
        status: "error",
        issue: "quota",
        reason: normalized.includes("fewer max_tokens") || normalized.includes("can only afford")
          ? "Kapasitas Swift internal tidak cukup untuk batas output request saat ini"
          : "Swift AI engine sedang rate-limited",
        action: normalized.includes("fewer max_tokens") || normalized.includes("can only afford")
          ? "Turunkan batas output tier atau coba lagi sebentar lagi."
          : "Coba lagi beberapa menit.",
        checkedAt: new Date().toISOString(),
      }
    }

    if (
      normalized.includes("rate-limit") ||
      normalized.includes("rate limited") ||
      normalized.includes("max_tokens")
    ) {
      return {
        status: "error",
        issue: "latency",
        reason: normalized.includes("max_tokens")
          ? "Batas token output terlalu tinggi untuk request ini"
          : "Swift sedang rate-limited",
        action: normalized.includes("max_tokens")
          ? "Coba lagi dengan prompt lebih singkat atau pilih tier yang lebih ringan."
          : "Tunggu beberapa menit lalu coba lagi.",
        checkedAt: new Date().toISOString(),
      }
    }

    if (
      normalized.includes("no endpoints found") ||
      normalized.includes("model not found") ||
      normalized.includes("unknown model")
    ) {
      return {
        status: "error",
        issue: "config",
        reason: "Tier Swift yang dipilih sedang tidak tersedia",
        action: "Cek konfigurasi Swift AI engine.",
        checkedAt: new Date().toISOString(),
      }
    }

    if (normalized.includes("timed out")) {
      return {
        status: "slow",
        issue: "latency",
        reason: "Swift AI engine timeout",
        action: "Coba lagi nanti dengan prompt lebih fokus. Swift membatasi retry agar biaya tetap terkendali.",
        checkedAt: new Date().toISOString(),
      }
    }

    if (normalized.includes("not configured") || normalized.includes("api key is missing")) {
      return {
        status: "error",
        issue: "config",
        reason: "Swift AI configuration is incomplete",
        action: "Pastikan gateway Swift aktif, lalu restart server.",
        checkedAt: new Date().toISOString(),
      }
    }

    return {
      status: "error",
      issue: "unknown",
      reason: "Swift AI engine sedang mengalami gangguan sementara",
      action: "Saldo otomatis dikembalikan jika generate gagal. Coba lagi sebentar lagi.",
      checkedAt: new Date().toISOString(),
    }
  }, [])

  const persistWorkspaceDraft = useCallback((input: WorkspaceDraft) => {
    const fingerprint = buildWorkspaceFingerprint(
      input.files,
      input.workspaceState.lockedPaths
    )

    workspaceDraftRef.current = input
    if (workspaceDraftFingerprintRef.current === fingerprint) {
      return
    }

    workspaceDraftFingerprintRef.current = fingerprint

    if (typeof window === "undefined") {
      return
    }

    window.localStorage.setItem(
      buildWorkspaceDraftKey(projectId),
      JSON.stringify(input)
    )
  }, [projectId])

  const clearWorkspaceDraft = useCallback(() => {
    workspaceDraftRef.current = null
    workspaceDraftFingerprintRef.current = null

    if (typeof window === "undefined") {
      return
    }

    window.localStorage.removeItem(buildWorkspaceDraftKey(projectId))
  }, [projectId])

  const saveFiles = useCallback(async (files: GeneratedFile[], prompt: string) => {
    setIsSavingFiles(true)

    if (workspaceAutosaveTimerRef.current !== null) {
      window.clearTimeout(workspaceAutosaveTimerRef.current)
      workspaceAutosaveTimerRef.current = null
    }

    const workspaceState = buildWorkspaceStateSnapshot({
      version: currentVersion + 1,
      dirty: false,
      lockedPaths: workspaceProtectedPathsRef.current,
      activeFilePath: getActiveFilePath(files, activeFileIndex),
    })
    const payloadFiles = [...normalizeWorkspaceFiles(files), buildWorkspaceStateFile(workspaceState)]
    const fingerprint = buildWorkspaceFingerprint(files, workspaceState.lockedPaths)
    workspaceSaveFingerprintRef.current = fingerprint

    try {
      const response = await fetch(`/api/projects/${projectId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          files: payloadFiles,
          prompt,
          tokensUsed: 0,
        }),
      })

      const data = await response.json()
      if (!response.ok) {
        throw new Error(data.error || "Failed to save files")
      }

      const isCurrentSnapshot = workspaceSaveFingerprintRef.current === fingerprint
      if (isCurrentSnapshot) {
        setIsDirty(false)
        setCurrentVersion((version) => version + 1)
        setWorkspaceRestoreNotice(null)
        clearWorkspaceDraft()
      }

      return data
    } finally {
      setIsSavingFiles(false)
    }
  }, [activeFileIndex, clearWorkspaceDraft, currentVersion, projectId])

  useEffect(() => {
    if (isLoadingProject || !isDirty || generatedFiles.length === 0) {
      if (workspaceAutosaveTimerRef.current !== null) {
        window.clearTimeout(workspaceAutosaveTimerRef.current)
        workspaceAutosaveTimerRef.current = null
      }
      return
    }

    const workspaceState = buildWorkspaceStateSnapshot({
      version: currentVersion,
      dirty: true,
      lockedPaths: workspaceProtectedPathsRef.current,
      activeFilePath: getActiveFilePath(generatedFiles, activeFileIndex),
    })
    const draft: WorkspaceDraft = {
      files: normalizeWorkspaceFiles(generatedFiles),
      workspaceState,
    }

    persistWorkspaceDraft(draft)

    if (workspaceAutosaveTimerRef.current !== null) {
      window.clearTimeout(workspaceAutosaveTimerRef.current)
    }

    const snapshotFiles = draft.files
    const snapshotPrompt = latestUserPrompt
    const snapshotFingerprint = buildWorkspaceFingerprint(snapshotFiles, workspaceState.lockedPaths)
    workspaceSaveFingerprintRef.current = snapshotFingerprint

    workspaceAutosaveTimerRef.current = window.setTimeout(() => {
      void saveFiles(snapshotFiles, snapshotPrompt).catch((error) => {
        const message = error instanceof Error ? error.message : "Failed to autosave workspace"
        pushErrorLog("save", message)

        workspaceAutosaveTimerRef.current = window.setTimeout(() => {
          void saveFiles(snapshotFiles, snapshotPrompt).catch((retryError) => {
            const retryMessage = retryError instanceof Error ? retryError.message : "Failed to autosave workspace"
            pushErrorLog("save", retryMessage)
          })
        }, AUTOSAVE_DEBOUNCE_MS * 2)
      })
    }, AUTOSAVE_DEBOUNCE_MS)

    return () => {
      if (workspaceAutosaveTimerRef.current !== null) {
        window.clearTimeout(workspaceAutosaveTimerRef.current)
        workspaceAutosaveTimerRef.current = null
      }
    }
  }, [activeFileIndex, currentVersion, generatedFiles, isDirty, isLoadingProject, latestUserPrompt, persistWorkspaceDraft, pushErrorLog, saveFiles])

  const handleSendMessage = useCallback(async (
    content: string,
    modelKey: string,
    attachments: PromptAttachment[] = [],
    promptLanguage: PromptLanguage = "id",
    previewErrorContext?: string | null,
    collaborationMode: CollaborationMode = "build"
  ) => {
    const trimmedContent = content.trim()

    if (!trimmedContent) {
      return
    }

    if (trimmedContent.length > MAX_PROMPT_LENGTH) {
      const assistantId = Math.random().toString(36).substring(7)
      const validationMessage: Message = {
        id: assistantId,
        role: "assistant",
        content: `Prompt terlalu panjang. Maksimal ${MAX_PROMPT_LENGTH.toLocaleString("id-ID")} karakter.`,
        timestamp: new Date(),
      }

      setMessages((prev) => [...prev, validationMessage])
      return
    }

    const userMessage: Message = {
      id: Math.random().toString(36).substring(7),
      role: "user",
      content: trimmedContent,
      timestamp: new Date(),
      metadata: {
        model: modelKey,
        attachments: attachments.map((attachment) => attachment.originalName || attachment.name),
        mode: collaborationMode,
      },
    }
    const workPlan = buildClientWorkPlan(trimmedContent, collaborationMode, promptLanguage)
    if (collaborationMode === "edit") {
      console.log("edit_mode_started")
    }

    setMessages((prev) => [...prev, userMessage])
    setIsGenerating(true)
    streamedGenerationFilesSeenRef.current = false
    activeGenerateWasCancelledRef.current = false
    setProviderStatus(null)
    setGenerationProgress({
      stage: "context",
      label: "Membaca konteks project",
      startedAt: new Date(),
      timeoutMs: GENERATE_CLIENT_TIMEOUT_MS,
      modelKey,
      prompt: trimmedContent,
      workPlan,
      progressPercent: 4,
    })
    const activeFile = generatedFiles[activeFileIndex] || null
    const previewContext = buildPreviewContextPacket({
      source: "editor",
      projectId,
      projectName,
      templateId: projectTemplateId,
      activeTab: activePreviewTab,
      viewport: previewViewport,
      currentVersion,
      activeFile,
      files: generatedFiles,
      previewFiles,
      previewError: previewErrorContext?.trim() || latestPreviewError,
      notes: ["Preview context captured from the editor before sending the request."],
    })

    const promptForGeneration = trimmedContent

    // Add assistant message placeholder
    const assistantId = Math.random().toString(36).substring(7)
    const assistantMessage: Message = {
      id: assistantId,
      role: "assistant",
      content: "",
      timestamp: new Date(),
      isGenerating: true,
    }

    setMessages((prev) => [...prev, assistantMessage])
    let handoffToJobStream = false
    clearGenerateDeadline()
    const generateController = new AbortController()
    activeGenerateControllerRef.current = generateController
    activeGenerateTimeoutRef.current = window.setTimeout(() => {
      console.log("client_timeout_triggered")
      const jobId = activeGenerationJobIdRef.current
      if (jobId) {
        void fetch(`/api/generate/jobs/${jobId}/cancel`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ reason: "timeout" }),
        }).catch(() => null)
      }

      generateController.abort()
      closeGenerationStream()
      setIsGenerating(false)
      setGenerationProgress((current) =>
        current
          ? {
              ...current,
              stage: "timeout",
              label: "Swift timeout",
              progressPercent: 100,
            }
          : current
      )
      setMessages((prev) =>
        prev.map((msg) =>
          msg.id === assistantId
            ? {
                ...msg,
                content: `Swift timeout setelah ${GENERATE_CLIENT_TIMEOUT_SECONDS} detik. Request dihentikan otomatis dan saldo akan dikembalikan jika job gagal.`,
                isGenerating: false,
              }
            : msg
        )
      )
      activeGenerateTimeoutRef.current = null
      activeGenerateControllerRef.current = null
      activeGenerationJobIdRef.current = null
      activeGenerateWasCancelledRef.current = false
    }, GENERATE_CLIENT_TIMEOUT_MS)

    try {
      const idempotencyKey = createIdempotencyKey(promptForGeneration, modelKey, attachments, previewContext)
      const jobResponse = await fetch("/api/generate/jobs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: generateController.signal,
        body: JSON.stringify({
          projectId,
          prompt: promptForGeneration,
          model: modelKey,
          provider: "swift",
          plan: workPlan,
          attachments,
          promptLanguage,
          idempotencyKey,
          previewContext,
          collaborationMode,
        }),
      })
      const jobData = await jobResponse.json().catch(() => null)
      if (!jobResponse.ok || !jobData?.job?.id) {
        throw new Error(jobData?.error || "Failed to create generation job")
      }

      const jobId = String(jobData.job.id)
      activeGenerationJobIdRef.current = jobId
      activeGenerationLastEventIdRef.current = "0"
      applyJobProgress(jobData.job)
      startGenerationStream(jobId)

      setGenerationProgress((current) =>
        current
          ? {
              ...current,
              stage: "request",
              label: "Mengirim prompt dan menyiapkan rencana kerja",
              jobId,
              progressPercent: Math.max(current.progressPercent || 0, 10),
            }
          : current
      )
      handoffToJobStream = true
      setMessages((prev) =>
        prev.map((msg) =>
          msg.id === assistantId
            ? {
                ...msg,
                content: "Swift menerima request dan memindahkan generation ke worker. Progress akan terus masuk lewat event stream.",
                isGenerating: true,
              }
            : msg
        )
      )
      return

    } catch (error) {
      const wasCancelled =
        error instanceof DOMException &&
        error.name === "AbortError" &&
        activeGenerateWasCancelledRef.current
      const message =
        wasCancelled
          ? "Generate dihentikan. Perubahan belum diterapkan dan file project terakhir tetap dipertahankan."
          : error instanceof DOMException && error.name === "AbortError"
          ? "Swift AI engine timeout. Request dihentikan otomatis. Saldo akan otomatis dikembalikan jika request gagal."
          : error instanceof Error
            ? error.message
            : "Sorry, I encountered an error while generating. Please try again."

      setGenerationProgress((current) =>
        current
          ? {
              ...current,
              stage: wasCancelled
                ? "cancelled"
                : error instanceof DOMException && error.name === "AbortError"
                  ? "timeout"
                  : "error",
              label:
                wasCancelled
                  ? "Generate dihentikan"
                  : error instanceof DOMException && error.name === "AbortError"
                  ? "Swift timeout"
                  : "Generate gagal",
            }
          : current
      )

      const finalMessage =
        error instanceof Error
          ? publicGenerationErrorMessage(message)
          : message

      pushErrorLog("generate", finalMessage)
      setProviderStatus(buildProviderStatusFromError(finalMessage))

      // Update with error message
      setMessages((prev) =>
        prev.map((msg) =>
          msg.id === assistantId
            ? {
                ...msg,
                content: finalMessage,
                isGenerating: false,
              }
            : msg
        )
      )
    } finally {
      if (!handoffToJobStream && activeGenerationJobIdRef.current) {
        activeGenerationJobIdRef.current = null
      }
      if (!handoffToJobStream && activeGenerateTimeoutRef.current !== null) {
        window.clearTimeout(activeGenerateTimeoutRef.current)
        activeGenerateTimeoutRef.current = null
      }
      if (!handoffToJobStream) {
        activeGenerateControllerRef.current = null
        activeGenerateWasCancelledRef.current = false
        setIsGenerating(false)
        window.setTimeout(() => {
          setGenerationProgress(null)
          closeGenerationStream()
        }, 1200)
      }
    }
  }, [
    activeFileIndex,
    activePreviewTab,
    buildProviderStatusFromError,
    clearGenerateDeadline,
    closeGenerationStream,
    createIdempotencyKey,
    currentVersion,
    generatedFiles,
    latestPreviewError,
    previewFiles,
    previewViewport,
    projectId,
    projectName,
    projectTemplateId,
    pushErrorLog,
    applyJobProgress,
    startGenerationStream,
  ])

  const handleCancelGeneration = useCallback(() => {
    const controller = activeGenerateControllerRef.current
    const jobId = activeGenerationJobIdRef.current

    activeGenerateWasCancelledRef.current = true
    clearGenerateDeadline()
    if (jobId) {
      void fetch(`/api/generate/jobs/${jobId}/cancel`, { method: "POST" }).catch(() => null)
    }
    setGenerationProgress((current) =>
      current
        ? {
            ...current,
            stage: "cancelled",
            label: "Menghentikan generate...",
            progressPercent: 100,
          }
        : current
    )
    controller?.abort()
  }, [clearGenerateDeadline])

  useEffect(() => {
    if (
      isLoadingProject ||
      hasAutoGeneratedFromPrompt ||
      !shouldAutoGeneratePrompt ||
      !projectPrompt ||
      !selectedModel
    ) {
      return
    }

    setHasAutoGeneratedFromPrompt(true)
    void handleSendMessage(projectPrompt, selectedModel, [], "id")
  }, [
    handleSendMessage,
    hasAutoGeneratedFromPrompt,
    isLoadingProject,
    projectPrompt,
    selectedModel,
    shouldAutoGeneratePrompt,
  ])

  const handleUpdateFile = useCallback((index: number, content: string) => {
    setGeneratedFiles((currentFiles) => {
      const nextFiles = currentFiles.map((file, fileIndex) =>
        fileIndex === index
          ? {
              ...file,
              content,
            }
          : file
      )

      workspaceProtectedPathsRef.current = updateProtectedPathsForUserChange(
        currentFiles,
        nextFiles,
        workspaceProtectedPathsRef.current
      )

      return nextFiles
    })
    setIsDirty(true)
  }, [])

  const handleReplaceFiles = useCallback((files: GeneratedFile[]) => {
    setGeneratedFiles((currentFiles) => {
      const nextFiles = normalizeWorkspaceFiles(files)
      workspaceProtectedPathsRef.current = updateProtectedPathsForUserChange(
        currentFiles,
        nextFiles,
        workspaceProtectedPathsRef.current
      )

      return nextFiles
    })
    setIsDirty(true)
  }, [])

  const handleSaveFiles = useCallback(async () => {
    const latestPrompt = latestUserPrompt || "Manual code edit save"

    try {
      await saveFiles(generatedFiles, latestPrompt)
      await refreshProjectState("manual-save")
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to save files"
      pushErrorLog("save", message)
      setMessages((prev) => [
        ...prev,
        {
          id: Math.random().toString(36).substring(7),
          content: message,
          role: "assistant",
          timestamp: new Date(),
        },
      ])
    }
  }, [generatedFiles, latestUserPrompt, pushErrorLog, refreshProjectState, saveFiles])

  const applyLayoutPreset = useCallback((preset: "prompt" | "balanced" | "preview") => {
    setLayoutPreset(preset)
    setLayoutRenderKey((current) => current + 1)
  }, [])

  const appendAssistantMessage = useCallback((content: string) => {
    setMessages((prev) => [
      ...prev,
      {
        id: Math.random().toString(36).substring(7),
        role: "assistant",
        content,
        timestamp: new Date(),
      },
    ])
  }, [])

  const extractDownloadFilename = (contentDisposition: string | null, fallback: string) => {
    if (!contentDisposition) return fallback

    const filenameStarMatch = contentDisposition.match(/filename\*=UTF-8''([^;]+)/i)
    if (filenameStarMatch?.[1]) {
      try {
        return decodeURIComponent(filenameStarMatch[1])
      } catch {
        return filenameStarMatch[1]
      }
    }

    const filenameMatch = contentDisposition.match(/filename="?([^"]+)"?/i)
    return filenameMatch?.[1] || fallback
  }

  const handleExportZip = useCallback(async () => {
    if (isExporting) return
    if (generatedFiles.length === 0) {
      appendAssistantMessage("Belum ada file untuk di-export. Generate dulu, lalu coba Export lagi.")
      return
    }

    setIsExporting(true)
    try {
      const response = await fetch(`/api/projects/${projectId}/export`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          files: generatedFiles,
        }),
      })

      if (!response.ok) {
        const data = (await response.json().catch(() => ({}))) as { error?: string }
        throw new Error(data.error || `Failed to export (${response.status})`)
      }

      const blob = await response.blob()
      const fileName = extractDownloadFilename(
        response.headers.get("content-disposition"),
        `swift-project-${projectId}.zip`
      )

      const downloadUrl = window.URL.createObjectURL(blob)
      const link = document.createElement("a")
      link.href = downloadUrl
      link.download = fileName
      document.body.appendChild(link)
      link.click()
      link.remove()
      window.URL.revokeObjectURL(downloadUrl)

      appendAssistantMessage(`Export berhasil: ${fileName}`)
    } catch (error) {
      pushErrorLog(
        "export",
        error instanceof Error ? error.message : "Gagal export project ke ZIP."
      )
      appendAssistantMessage(
        error instanceof Error ? error.message : "Gagal export project ke ZIP."
      )
    } finally {
      setIsExporting(false)
    }
  }, [appendAssistantMessage, generatedFiles, isExporting, projectId, pushErrorLog])

  const handleDeployToVercel = useCallback(async () => {
    if (isDeploying) return
    if (generatedFiles.length === 0) {
      appendAssistantMessage("Belum ada file untuk deploy. Generate dulu, lalu coba Deploy lagi.")
      return
    }

    setIsDeploying(true)
    setDeployFlow((current) => ({
      ...current,
      vercelStatus: "running",
      message: "Deploying to Vercel...",
    }))
    try {
      const response = await fetch(`/api/projects/${projectId}/deploy`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          files: generatedFiles,
        }),
      })

      const data = (await response.json().catch(() => ({}))) as {
        error?: string
        deployment?: {
          url?: string | null
          readyState?: string
        }
      }

      if (!response.ok) {
        throw new Error(data.error || `Failed to deploy (${response.status})`)
      }

      const url = data.deployment?.url || null
      setDeploymentUrl(url)
      setDeployFlow((current) => ({
        ...current,
        vercelStatus: "ready",
        vercelUrl: url,
        message: `Vercel deployment ${data.deployment?.readyState || "BUILDING"}`,
      }))

      if (url) {
        appendAssistantMessage(
          `Deployment dikirim ke Vercel (status: ${data.deployment?.readyState || "BUILDING"}): ${url}`
        )
        window.open(url, "_blank", "noopener,noreferrer")
      } else {
        appendAssistantMessage("Deployment berhasil dibuat, tapi URL belum tersedia.")
      }
    } catch (error) {
      pushErrorLog(
        "deploy",
        error instanceof Error ? error.message : "Gagal deploy project ke Vercel."
      )
      setDeployFlow((current) => ({
        ...current,
        vercelStatus: "failed",
        message: error instanceof Error ? error.message : "Gagal deploy project ke Vercel.",
      }))
      appendAssistantMessage(
        error instanceof Error ? error.message : "Gagal deploy project ke Vercel."
      )
    } finally {
      setIsDeploying(false)
    }
  }, [appendAssistantMessage, generatedFiles, isDeploying, projectId, pushErrorLog])

  const handlePushToGitHub = useCallback(async () => {
    if (isPushingGitHub) return
    if (generatedFiles.length === 0) {
      appendAssistantMessage("Belum ada file untuk push ke GitHub. Generate dulu, lalu coba lagi.")
      return
    }

    setIsPushingGitHub(true)
    setDeployFlow((current) => ({
      ...current,
      githubStatus: "running",
      message: "Pushing project snapshot to GitHub...",
    }))

    try {
      const response = await fetch(`/api/projects/${projectId}/github`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          files: generatedFiles,
          repoName: projectName || `swift-project-${projectId}`,
        }),
      })
      const data = (await response.json().catch(() => ({}))) as {
        error?: string
        setupRequired?: boolean
        repository?: {
          url?: string | null
          owner?: string
          name?: string
          branch?: string
          commitSha?: string
        }
      }

      if (!response.ok) {
        const message = data.error || `GitHub push failed (${response.status})`
        setDeployFlow((current) => ({
          ...current,
          githubStatus: data.setupRequired ? "setup-required" : "failed",
          message,
        }))
        throw new Error(message)
      }

      const url = data.repository?.url || null
      setDeployFlow((current) => ({
        ...current,
        githubStatus: "ready",
        githubUrl: url,
        message: data.repository?.name
          ? `GitHub repo ready: ${data.repository.owner}/${data.repository.name}`
          : "GitHub repo ready.",
      }))

      appendAssistantMessage(url ? `GitHub repository siap: ${url}` : "GitHub repository siap.")
    } catch (error) {
      const message = error instanceof Error ? error.message : "Gagal push project ke GitHub."
      pushErrorLog("github", message)
      appendAssistantMessage(message)
    } finally {
      setIsPushingGitHub(false)
    }
  }, [appendAssistantMessage, generatedFiles, isPushingGitHub, projectId, projectName, pushErrorLog])

  const handleValidatePreview = useCallback(async () => {
    if (isValidatingPreview) return
    if (generatedFiles.length === 0) {
      setPreviewValidation({
        status: "failed",
        diagnosticsCount: 1,
        warningCount: 0,
        checkedAt: new Date().toISOString(),
        message: "No files available to validate.",
      })
      return
    }

    setIsValidatingPreview(true)
    setPreviewValidation((current) => ({
      ...current,
      status: "running",
      message: "Running syntax, import, and preview compile checks...",
    }))

    try {
      const response = await fetch(`/api/projects/${projectId}/validate-preview`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ files: generatedFiles }),
      })
      const data = (await response.json().catch(() => ({}))) as {
        ok?: boolean
        checkedAt?: string
        diagnostics?: Array<{ message?: string }>
        warnings?: string[]
        error?: string
      }

      if (!response.ok) {
        throw new Error(data.error || `Preview validation failed (${response.status})`)
      }

      const diagnosticsCount = Array.isArray(data.diagnostics) ? data.diagnostics.length : 0
      const warningCount = Array.isArray(data.warnings) ? data.warnings.length : 0
      setPreviewValidation({
        status: data.ok ? "passed" : "failed",
        checkedAt: data.checkedAt || new Date().toISOString(),
        diagnosticsCount,
        warningCount,
        message: data.ok
          ? `Preview validation passed for ${generatedFiles.length} files.`
          : data.diagnostics?.[0]?.message || "Preview validation found issues.",
      })
      appendAssistantMessage(
        data.ok
          ? "Preview validation passed. Project siap untuk deploy."
          : `Preview validation gagal: ${data.diagnostics?.[0]?.message || "cek diagnostics."}`
      )
    } catch (error) {
      const message = error instanceof Error ? error.message : "Gagal validate preview."
      setPreviewValidation({
        status: "failed",
        checkedAt: new Date().toISOString(),
        diagnosticsCount: 1,
        warningCount: 0,
        message,
      })
      pushErrorLog("preview", message)
      appendAssistantMessage(message)
    } finally {
      setIsValidatingPreview(false)
    }
  }, [appendAssistantMessage, generatedFiles, isValidatingPreview, projectId, pushErrorLog])

  const handleRollbackVersion = useCallback(async (historyId: string) => {
    if (isRollingBackVersion) return
    setIsRollingBackVersion(true)

    try {
      const response = await fetch(`/api/projects/${projectId}/history`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ historyId }),
      })
      const data = (await response.json().catch(() => ({}))) as {
        error?: string
        files?: GeneratedFile[]
        historyId?: string
      }

      if (!response.ok || !Array.isArray(data.files)) {
        throw new Error(data.error || `Rollback failed (${response.status})`)
      }

      setGeneratedFiles(normalizeWorkspaceFiles(data.files))
      setPreviewFiles(null)
      setCurrentVersion((version) => version + 1)
      setIsDirty(false)
      setWorkspaceRestoreNotice("Rollback berhasil. Workspace dikembalikan ke snapshot pilihan dan versi baru sudah dibuat.")
      await refreshProjectState("rollback")
      appendAssistantMessage("Rollback berhasil. Snapshot lama dipulihkan sebagai versi baru.")
    } catch (error) {
      const message = error instanceof Error ? error.message : "Gagal rollback version."
      pushErrorLog("project", message)
      appendAssistantMessage(message)
    } finally {
      setIsRollingBackVersion(false)
    }
  }, [appendAssistantMessage, isRollingBackVersion, projectId, pushErrorLog, refreshProjectState])

  const handleDomainSaved = useCallback((domain: string | null) => {
    setCustomDomain(domain)
    if (!domain) setDomainVerified(false)
  }, [])

  const handlePreviewErrorChange = useCallback((message: string | null) => {
    setLatestPreviewError(message?.trim() ? message : null)

    if (!message) return
    pushErrorLog("preview", message)
  }, [pushErrorLog])

  const handleClearErrorLogs = useCallback(() => {
    setErrorLogs([])
  }, [])

  const baseChatSize = layoutPreset === "prompt" ? 34 : layoutPreset === "preview" ? 30 : 32
  const logsDefaultSize = showLogsPanel ? 10 : 0
  const availableSize = 100 - logsDefaultSize

  const normalizePanelSizes = (available: number, chatBase: number) => {
    const rawChatSize = (chatBase / 100) * available
    let chatSize = Math.max(rawChatSize, 28)
    let previewSize = available - chatSize

    if (previewSize < 30) {
      previewSize = 30
      chatSize = Math.max(available - previewSize, 28)
    }

    return {
      chatSize: Number(chatSize.toFixed(2)),
      previewSize: Number(previewSize.toFixed(2)),
    }
  }

  const { chatSize: chatDefaultSize, previewSize: previewDefaultSize } = normalizePanelSizes(
    availableSize,
    baseChatSize
  )

  if (isLoadingProject) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        Loading project...
      </div>
    )
  }

  if (projectError) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-destructive">
        {projectError}
      </div>
    )
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <EditorHeader
        projectId={projectId}
        currentVersion={currentVersion}
        onExportZip={handleExportZip}
        onPushGitHub={handlePushToGitHub}
        subscriptionPlan={subscriptionPlan}
        subscriptionStatus={subscriptionStatus}
        onDeploy={handleDeployToVercel}
        isExporting={isExporting}
        isPushingGitHub={isPushingGitHub}
        isDeploying={isDeploying}
        deploymentUrl={deploymentUrl}
        customDomain={customDomain}
        onDomainSaved={handleDomainSaved}
      />

      {workspaceRestoreNotice && (
        <div className="border-b border-amber-200 bg-amber-50 px-4 py-2 text-xs text-amber-900 dark:border-amber-900/50 dark:bg-amber-950/30 dark:text-amber-200">
          {workspaceRestoreNotice}
        </div>
      )}

      <WorkspaceCommandCenter
        projectName={projectName}
        fileCount={generatedFiles.length}
        currentVersion={currentVersion}
        isDirty={isDirty}
        history={projectHistory}
        previewValidation={previewValidation}
        deployFlow={deployFlow}
        isValidatingPreview={isValidatingPreview}
        isRollingBack={isRollingBackVersion}
        isPushingGitHub={isPushingGitHub}
        isDeploying={isDeploying}
        onValidatePreview={handleValidatePreview}
        onRollback={handleRollbackVersion}
        onPushGitHub={handlePushToGitHub}
        onDeployVercel={handleDeployToVercel}
      />

      {isMobile ? (
        <>
          <div className="flex items-center gap-2 border-b border-border px-3 py-2">
            <Button
              size="sm"
              variant={mobileView === "chat" ? "default" : "outline"}
              onClick={() => setMobileView("chat")}
            >
              Prompt
            </Button>
            <Button
              size="sm"
              variant={mobileView === "preview" ? "default" : "outline"}
              onClick={() => setMobileView("preview")}
            >
              Preview
            </Button>
          </div>
          <div className="min-h-0 flex-1 overflow-hidden">
            {mobileView === "chat" ? (
              <ChatPanel
                projectId={projectId}
                messages={messages}
                onSendMessage={handleSendMessage}
                onCancelGeneration={handleCancelGeneration}
                isGenerating={isGenerating}
                modelOptions={availableModels}
                selectedModel={selectedModel}
                onModelChange={setSelectedModel}
                onViewCode={() => {
                  setActivePreviewTab("code")
                  setMobileView("preview")
                }}
                providerStatus={providerStatus}
                previewErrorContext={latestPreviewError}
                generationProgress={generationProgress}
              />
            ) : (
              <PreviewPanel
                files={generatedFiles}
                previewFiles={previewFiles}
                currentVersion={currentVersion}
                activeFileIndex={activeFileIndex}
                onSelectFile={setActiveFileIndex}
                onViewportChange={setPreviewViewport}
                onUpdateFile={handleUpdateFile}
                onReplaceFiles={handleReplaceFiles}
                onSaveFiles={handleSaveFiles}
                isSaving={isSavingFiles}
                isDirty={isDirty}
                activeTab={activePreviewTab}
                onTabChange={setActivePreviewTab}
                onPreviewErrorChange={handlePreviewErrorChange}
                isGenerating={isGenerating}
                streamLockedPaths={streamLockedPaths}
                generationProgress={generationProgress}
                onCancelGeneration={handleCancelGeneration}
                projectId={projectId}
                runtimePreviewUrl={runtimePreviewUrl}
              />
            )}
          </div>
        </>
      ) : (
        <>
          <div className="flex items-center justify-between gap-2 border-b border-border px-3 py-2">
            <div className="text-xs text-muted-foreground">
              Layout disembunyikan di menu agar toolbar tetap ringan.
            </div>
            <div className="flex items-center gap-2">
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button size="sm" variant="outline" className="gap-2">
                    Layout: {layoutPreset === "prompt" ? "Prompt" : layoutPreset === "balanced" ? "Seimbang" : "Preview"}
                    <ChevronDown className="h-4 w-4" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem onSelect={() => applyLayoutPreset("prompt")}>Prompt besar</DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => applyLayoutPreset("balanced")}>Seimbang</DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => applyLayoutPreset("preview")}>Preview besar</DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>

              <Button
                size="sm"
                variant={showLogsPanel ? "default" : "outline"}
                onClick={() => setShowLogsPanel((current) => !current)}
                className="gap-2"
              >
                Logs
                {errorLogs.length > 0 && (
                  <span className="rounded-full bg-background/20 px-2 py-0.5 text-[10px] font-medium">
                    {errorLogs.length}
                  </span>
                )}
              </Button>
              {developerDiagnostics && (
                <Button
                  size="sm"
                  variant={showDeveloperDiagnostics ? "default" : "outline"}
                  onClick={() => setShowDeveloperDiagnostics((current) => !current)}
                >
                  Diagnostics
                </Button>
              )}
            </div>
          </div>
          <ResizablePanelGroup
            key={`${layoutRenderKey}-${showLogsPanel ? "logs" : "no-logs"}-${showDeveloperDiagnostics ? "dev" : "nodev"}`}
            direction="horizontal"
            className="min-h-0 flex-1"
          >
            <ResizablePanel className="min-h-0" defaultSize={chatDefaultSize} minSize={28}>
              <ChatPanel
                projectId={projectId}
                messages={messages}
                onSendMessage={handleSendMessage}
                onCancelGeneration={handleCancelGeneration}
                isGenerating={isGenerating}
                modelOptions={availableModels}
                selectedModel={selectedModel}
                onModelChange={setSelectedModel}
                onViewCode={() => setActivePreviewTab("code")}
                providerStatus={providerStatus}
                previewErrorContext={latestPreviewError}
                generationProgress={generationProgress}
              />
            </ResizablePanel>
            <ResizableHandle withHandle />
            <ResizablePanel className="min-h-0" defaultSize={previewDefaultSize} minSize={30}>
              <PreviewPanel
                files={generatedFiles}
                previewFiles={previewFiles}
                currentVersion={currentVersion}
                activeFileIndex={activeFileIndex}
                onSelectFile={setActiveFileIndex}
                onViewportChange={setPreviewViewport}
                onUpdateFile={handleUpdateFile}
                onReplaceFiles={handleReplaceFiles}
                onSaveFiles={handleSaveFiles}
                isSaving={isSavingFiles}
                isDirty={isDirty}
                activeTab={activePreviewTab}
                onTabChange={setActivePreviewTab}
                onPreviewErrorChange={handlePreviewErrorChange}
                isGenerating={isGenerating}
                streamLockedPaths={streamLockedPaths}
                generationProgress={generationProgress}
                onCancelGeneration={handleCancelGeneration}
                projectId={projectId}
                runtimePreviewUrl={runtimePreviewUrl}
              />
            </ResizablePanel>
            {showLogsPanel && (
              <>
                <ResizableHandle withHandle />
                <ResizablePanel className="min-h-0" defaultSize={10} minSize={8} maxSize={18}>
                  <ErrorLogPanel logs={errorLogs} onClear={handleClearErrorLogs} />
                </ResizablePanel>
              </>
            )}
            {developerDiagnostics && showDeveloperDiagnostics && (
              <>
                <ResizableHandle withHandle />
                <ResizablePanel className="min-h-0" defaultSize={18} minSize={12} maxSize={28}>
                  <DeveloperDiagnosticsPanel
                    diagnostics={developerDiagnostics}
                    expanded={showDeveloperDiagnostics}
                    onToggle={() => setShowDeveloperDiagnostics((current) => !current)}
                  />
                </ResizablePanel>
              </>
            )}
          </ResizablePanelGroup>
        </>
      )}
    </div>
  )
}

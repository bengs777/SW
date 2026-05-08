"use client"

import { useState, useCallback, useEffect } from "react"
import { useParams } from "next/navigation"
import { EditorHeader } from "@/components/editor/header"
import { ChatPanel } from "@/components/editor/chat-panel"
import type { CollaborationMode } from "@/components/editor/chat-panel"
import { PreviewPanel } from "@/components/editor/preview-panel"
import { ErrorLogPanel } from "@/components/editor/error-log-panel"
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
import { buildPreviewContextPacket } from "@/lib/ai/preview-context"
import type { PromptLanguage } from "@/lib/ai/prompt-templates"
import type { GeneratedFile, ModelOption, PreviewContext, PreviewViewport, PromptAttachment } from "@/lib/types"
import { ChevronDown } from "lucide-react"

const MAX_PROMPT_LENGTH = 12000
const COLLABORATION_MODE_INSTRUCTIONS: Record<PromptLanguage, Record<CollaborationMode, string>> = {
  id: {
    build:
      "Mode kolaborasi: BUILD. Buat atau perluas fitur sesuai prompt. Gunakan konteks editor sebagai source of truth dan jaga hasil tetap previewable.",
    edit:
      "Mode kolaborasi: EDIT. Utamakan mengubah file aktif dan file terkait. Hindari rewrite seluruh project kecuali benar-benar diperlukan.",
    fix:
      "Mode kolaborasi: FIX. Diagnosis error berdasarkan preview context, active file, dan file terkait. Terapkan patch minimal yang memperbaiki root cause.",
    review:
      "Mode kolaborasi: REVIEW. Cari bug, risiko regresi, gap validasi, dan perbaikan paling bernilai. Jika membuat perubahan, batasi ke patch kecil yang jelas.",
    ask:
      "Mode kolaborasi: ASK. Jawab pertanyaan user berdasarkan konteks editor. Jangan mengubah file kecuali user secara eksplisit meminta patch.",
  },
  en: {
    build:
      "Collaboration mode: BUILD. Create or extend features from the prompt. Treat editor context as the source of truth and keep the result previewable.",
    edit:
      "Collaboration mode: EDIT. Prefer changing the active file and related files. Avoid broad rewrites unless they are truly necessary.",
    fix:
      "Collaboration mode: FIX. Diagnose the issue from preview context, the active file, and related files. Apply the smallest patch that fixes the root cause.",
    review:
      "Collaboration mode: REVIEW. Look for bugs, regression risks, validation gaps, and high-value improvements. If changing files, keep patches small and clear.",
    ask:
      "Collaboration mode: ASK. Answer the user based on editor context. Do not change files unless the user explicitly asks for a patch.",
  },
}

function buildCollaborationPrompt(input: {
  content: string
  mode: CollaborationMode
  language: PromptLanguage
}) {
  const instruction = COLLABORATION_MODE_INSTRUCTIONS[input.language][input.mode]
  return [
    instruction,
    "Gunakan AI_CONTEXT_JSON dan PREVIEW_CONTEXT_JSON bila tersedia. Jangan mengarang file, error, atau state yang tidak ada di konteks.",
    "",
    "Prompt user:",
    input.content,
  ].join("\n")
}

const SUPPORTED_LANGUAGES: GeneratedFile["language"][] = [
  "tsx",
  "ts",
  "css",
  "json",
  "html",
  "prisma",
  "md",
  "env",
]

const normalizeLanguage = (value: unknown): GeneratedFile["language"] => {
  const candidate = typeof value === "string" ? value : ""
  return SUPPORTED_LANGUAGES.includes(candidate as GeneratedFile["language"])
    ? (candidate as GeneratedFile["language"])
    : "tsx"
}

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

type ErrorLogEntry = {
  id: string
  source: "project" | "provider" | "generate" | "preview" | "save" | "export" | "deploy"
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
  const [deploymentUrl, setDeploymentUrl] = useState<string | null>(null)
  const [errorLogs, setErrorLogs] = useState<ErrorLogEntry[]>([])
  const [showLogsPanel, setShowLogsPanel] = useState(false)
  const [latestPreviewError, setLatestPreviewError] = useState<string | null>(null)
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

      try {
        const response = await fetch(`/api/projects/${projectId}`)
        const data = await response.json()

        if (!response.ok) {
          throw new Error(data.error || "Failed to load project")
        }

        if (!isMounted) return

        const files = Array.isArray(data.project?.files)
          ? data.project.files.map((file: GeneratedFile) => ({
              path: file.path,
              content: file.content,
              language: normalizeLanguage(file.language),
            }))
          : []

        setGeneratedFiles(files)
        setActiveFileIndex(0)
        setCurrentVersion(data.project?.history?.length || (files.length > 0 ? 1 : 0))
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
            files.length === 0
        )
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
        reason: "Provider rejected authentication or model access",
        action: "Periksa OPENROUTER_API_KEY, akses model deepseek/deepseek-v4-flash, dan endpoint OpenRouter.",
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
          ? "Credit OpenRouter tidak cukup untuk batas output request saat ini"
          : "Provider quota atau upstream rate limit sedang penuh",
        action: normalized.includes("fewer max_tokens") || normalized.includes("can only afford")
          ? "Turunkan OPENROUTER_MAX_TOKENS di .env lalu restart dev server, atau isi ulang credit OpenRouter."
          : "Coba lagi beberapa menit, ganti model, atau gunakan key provider sendiri (BYOK).",
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
          : "Provider sedang rate-limited",
        action: normalized.includes("max_tokens")
          ? "Coba lagi dengan prompt lebih singkat, atau turunkan OPENROUTER_MAX_TOKENS di .env."
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
        reason: "Model yang dipilih sedang tidak tersedia di provider",
        action: "Pastikan model deepseek/deepseek-v4-flash tersedia di OpenRouter.",
        checkedAt: new Date().toISOString(),
      }
    }

    if (normalized.includes("timed out")) {
      return {
        status: "slow",
        issue: "latency",
        reason: "Provider request timed out",
        action: "Coba lagi nanti. Tidak ada fallback otomatis ke model lain.",
        checkedAt: new Date().toISOString(),
      }
    }

    if (normalized.includes("not configured") || normalized.includes("api key is missing")) {
      return {
        status: "error",
        issue: "config",
        reason: "Provider configuration is incomplete",
        action: "Periksa OPENROUTER_API_KEY dan restart dev server.",
        checkedAt: new Date().toISOString(),
      }
    }

    return {
      status: "error",
      issue: "unknown",
      reason: "Provider request failed",
      action: "Periksa koneksi server dan konfigurasi provider.",
      checkedAt: new Date().toISOString(),
    }
  }, [])

  const saveFiles = useCallback(async (files: GeneratedFile[], prompt: string) => {
    setIsSavingFiles(true)
    try {
      const response = await fetch(`/api/projects/${projectId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          files,
          prompt,
          tokensUsed: 0,
        }),
      })

      const data = await response.json()
      if (!response.ok) {
        throw new Error(data.error || "Failed to save files")
      }

      setIsDirty(false)
      setCurrentVersion((v) => v + 1)
      return data
    } finally {
      setIsSavingFiles(false)
    }
  }, [projectId])

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

    setMessages((prev) => [...prev, userMessage])
    setIsGenerating(true)
    setProviderStatus(null)
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

    const promptForGeneration = buildCollaborationPrompt({
      content: trimmedContent,
      mode: collaborationMode,
      language: promptLanguage,
    })

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

    try {
      // Call AI API
      const response = await fetch("/api/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          prompt: promptForGeneration,
          attachments,
          projectId,
          history: messages,
          selectedModel: modelKey,
          promptLanguage,
          idempotencyKey: createIdempotencyKey(promptForGeneration, modelKey, attachments, previewContext),
          previewContext,
          collaborationMode,
        }),
      })

      const contentType = response.headers.get("content-type") || ""
      const responseText = await response.text()

      if (!response.ok) {
        let errorMessage = `Failed to generate (${response.status})`

        try {
          const parsed = JSON.parse(responseText)
          errorMessage = parsed.error || parsed.details || parsed.message || errorMessage
        } catch {
          // Keep fallback error message if the response was not JSON.
        }

        throw new Error(errorMessage)
      }

      if (!contentType.includes("application/json")) {
        throw new Error("Generate API returned a non-JSON response. You may need to sign in again.")
      }

      const data = JSON.parse(responseText)

      if (data.warning) {
        pushErrorLog("provider", String(data.warning))
        setProviderStatus(buildProviderStatusFromError(String(data.warning)))
      } else {
        setProviderStatus({
          status: "connected",
          issue: "healthy",
          reason: "Request terakhir berhasil.",
          action: "Provider siap dipakai.",
          checkedAt: new Date().toISOString(),
        })
      }

      if (data.mode === "chat" || data.mode === "clarify" || data.mode === "inspect") {
        setMessages((prev) =>
          prev.map((msg) =>
            msg.id === assistantId
              ? {
                  ...msg,
                  content: data.message,
                  isGenerating: false,
                  metadata: {
                    model: data.usage?.model,
                    cost: data.usage?.cost,
                    remainingBalance: data.usage?.remainingBalance,
                  },
                }
              : msg
          )
        )
        return
      }

      // Update assistant message with response
      setMessages((prev) =>
        prev.map((msg) =>
          msg.id === assistantId
            ? {
                ...msg,
                content: data.message,
                generatedCode: data.code,
                isGenerating: false,
                metadata: {
                  model: data.usage?.model,
                  cost: data.usage?.cost,
                  remainingBalance: data.usage?.remainingBalance,
                  failSafeType:
                    data?.failSafe?.type === "strict-fullstack"
                      ? "strict-fullstack"
                      : undefined,
                },
              }
            : msg
        )
      )

      // Update generated files only when the backend confirms that AI produced
      // valid file output. Provider failures preserve the current Explorer state.
      if (data.preserveFiles) {
        setIsDirty(false)
      } else if (Array.isArray(data.files)) {
        const normalizedFiles: GeneratedFile[] = data.files.map(
          (file: { path: string; content: string; language?: string }) => ({
            path: file.path,
            content: file.content,
            language: normalizeLanguage(file.language),
          })
        )

        setGeneratedFiles(normalizedFiles)
        setActiveFileIndex(0)
        setCurrentVersion((v) => v + 1)
        setIsDirty(false)
        setActivePreviewTab("code")
      } else {
        setGeneratedFiles([])
      }

      const previewFilesPayload = data as {
        previewFiles?: Array<{ path: string; content: string; language?: string }> | null
      }

      if (data.preserveFiles) {
        setPreviewFiles(null)
      } else if (Array.isArray(previewFilesPayload.previewFiles)) {
        const normalizedPreview: GeneratedFile[] = previewFilesPayload.previewFiles.map(
          (file: { path: string; content: string; language?: string }) => ({
            path: file.path,
            content: file.content,
            language: normalizeLanguage(file.language),
          })
        )
        setPreviewFiles(normalizedPreview)
      } else {
        setPreviewFiles(null)
      }
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : "Sorry, I encountered an error while generating. Please try again."

      pushErrorLog("generate", message)
      setProviderStatus(buildProviderStatusFromError(message))

      // Update with error message
      setMessages((prev) =>
        prev.map((msg) =>
          msg.id === assistantId
            ? {
                ...msg,
                content: message,
                isGenerating: false,
              }
            : msg
        )
      )
    } finally {
      setIsGenerating(false)
    }
  }, [
    activeFileIndex,
    activePreviewTab,
    buildProviderStatusFromError,
    createIdempotencyKey,
    currentVersion,
    generatedFiles,
    latestPreviewError,
    messages,
    previewFiles,
    previewViewport,
    projectId,
    projectName,
    projectTemplateId,
    pushErrorLog,
  ])

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
    setGeneratedFiles((currentFiles) =>
      currentFiles.map((file, fileIndex) =>
        fileIndex === index
          ? {
              ...file,
              content,
            }
          : file
      )
    )
    setIsDirty(true)
  }, [])

  const handleReplaceFiles = useCallback((files: GeneratedFile[]) => {
    setGeneratedFiles(files)
    setIsDirty(true)
  }, [])

  const handleSaveFiles = useCallback(async () => {
    const latestPrompt =
      [...messages].reverse().find((message) => message.role === "user")?.content ||
      "Manual code edit save"

    try {
      await saveFiles(generatedFiles, latestPrompt)
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to save files"
      pushErrorLog("save", message)
      setMessages((prev) => [
        ...prev,
        {
          id: Math.random().toString(36).substring(7),
          role: "assistant",
          content: message,
          timestamp: new Date(),
        },
      ])
    }
  }, [generatedFiles, messages, pushErrorLog, saveFiles])

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
      appendAssistantMessage(
        error instanceof Error ? error.message : "Gagal deploy project ke Vercel."
      )
    } finally {
      setIsDeploying(false)
    }
  }, [appendAssistantMessage, generatedFiles, isDeploying, projectId, pushErrorLog])

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
        subscriptionPlan={subscriptionPlan}
        subscriptionStatus={subscriptionStatus}
        onDeploy={handleDeployToVercel}
        isExporting={isExporting}
        isDeploying={isDeploying}
        deploymentUrl={deploymentUrl}
        customDomain={customDomain}
        onDomainSaved={handleDomainSaved}
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
            </div>
          </div>
          <ResizablePanelGroup
            key={`${layoutRenderKey}-${showLogsPanel ? "logs" : "no-logs"}`}
            direction="horizontal"
            className="min-h-0 flex-1"
          >
            <ResizablePanel className="min-h-0" defaultSize={chatDefaultSize} minSize={28}>
              <ChatPanel
                projectId={projectId}
                messages={messages}
                onSendMessage={handleSendMessage}
                isGenerating={isGenerating}
                modelOptions={availableModels}
                selectedModel={selectedModel}
                onModelChange={setSelectedModel}
                onViewCode={() => setActivePreviewTab("code")}
                providerStatus={providerStatus}
                previewErrorContext={latestPreviewError}
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
          </ResizablePanelGroup>
        </>
      )}
    </div>
  )
}

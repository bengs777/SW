"use client"

import { useState, useRef, useEffect } from "react"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Collapsible, CollapsibleContent } from "@/components/ui/collapsible"
import { Zap, Send, Paperclip, Image as ImageIcon, ShieldAlert, ChevronDown, X, Square } from "lucide-react"
import { cn } from "@/lib/utils"
import type { Message } from "@/app/dashboard/project/[id]/page"
import type { ProviderStatus } from "@/app/dashboard/project/[id]/page"
import type { GenerationProgress } from "@/app/dashboard/project/[id]/page"
import type { ModelOption, PromptAttachment } from "@/lib/types"
import { analyzePromptIntent } from "@/lib/ai/prompt-intent"
import { getTemplate, PROMPT_LANGUAGE_LABELS } from "@/lib/ai/prompt-templates"
import type { PromptLanguage, PromptTemplateKey, TemplateVariant } from "@/lib/ai/prompt-templates"
import type { CollaborationMode } from "@/lib/ai/collaboration-mode"
import { isMutatingCollaborationMode } from "@/lib/ai/collaboration-mode"

const MAX_PROMPT_LENGTH = 12000
const MAX_ATTACHMENTS = 5
const VISION_CAPABLE_MODEL_KEYS = new Set<string>()
const MAX_FILE_SIZE_BYTES = 3 * 1024 * 1024
const MAX_TEXT_FILE_CHARS = 18000
const MAX_IMAGE_DATA_URL_CHARS = 18000

type UploadedProjectAttachment = {
  id: string
  name: string
  originalName: string
  mimeType: string
  size: number
  kind: PromptAttachment["kind"]
  storageBucket: string
  storagePath: string
  uploadedAt: string
  uploadedByUserId: string
}
const sanitizeModelDisplayName = (value: string) =>
  sanitizePublicAiCopy(value).replace(/:free\b/gi, "").trim()

const sanitizePublicAiCopy = (value: string) =>
  value.replace(/DeepSeek V4 Flash/gi, "Swift AI")

interface ChatPanelProps {
  projectId: string
  messages: Message[]
  onSendMessage: (
    content: string,
    selectedModel: string,
    attachments: PromptAttachment[],
    promptLanguage?: PromptLanguage,
    previewErrorContext?: string | null,
    collaborationMode?: CollaborationMode
  ) => void
  onCancelGeneration?: () => void
  isGenerating: boolean
  modelOptions: ModelOption[]
  selectedModel: string
  onModelChange: (model: string) => void
  onViewCode?: () => void
  providerStatus?: ProviderStatus | null
  previewErrorContext?: string | null
  generationProgress?: GenerationProgress | null
}

type EstimateState = {
  isLoading: boolean
  estimatedTokens?: number
  estimatedCost?: number
  canAfford?: boolean
  remainingBalance?: number
  currentBalance?: number
  error?: string
}

type PromptExample = {
  label: string
  title: string
  prompt: string
  variant: TemplateVariant
}

type PromptPanelCopy = {
  collaborationLabel: string
  collaborationDescription: string
  languageLabel: string
  languageDescription: string
  templateOptions: Record<PromptTemplateKey, string>
  variantOptions: Record<TemplateVariant, string>
  useTemplate: string
  readyBadge: string
  examplesTitle: string
  examplesDescription: string
  promptPlaceholder: string
  promptHint: string
  submitLabel: string
  submittingLabel: string
  charactersLabel: string
  emptyTitle: string
  emptyDescription: string
  emptySuggestions: string[]
}

type PromptStructureHelper = {
  label: string
  description: string
}

type CollaborationModeCopy = {
  label: string
  description: string
}

const COLLABORATION_MODES: Record<PromptLanguage, Record<CollaborationMode, CollaborationModeCopy>> = {
  id: {
    build: {
      label: "Build",
      description: "Buat fitur, halaman, atau app baru dari prompt.",
    },
    ask: {
      label: "Ask",
      description: "Tanya jawab dengan AI tanpa mengubah file.",
    },
  },
  en: {
    build: {
      label: "Build",
      description: "Create a new feature, page, or app from the prompt.",
    },
    ask: {
      label: "Ask",
      description: "Ask the AI questions without changing files.",
    },
  },
}


const PROMPT_PANEL_COPY: Record<PromptLanguage, PromptPanelCopy> = {
  id: {
    collaborationLabel: "Mode kolaborasi AI",
    collaborationDescription: "Pilih cara AI bekerja dengan editor dan preview saat prompt dikirim.",
    languageLabel: "Bahasa prompt",
    languageDescription: "Pilih Indonesia atau English untuk template, contoh, dan brief terstruktur yang dikirim ke AI.",
    templateOptions: {
      landing: "Landing page",
      auth: "Alur auth",
      dashboard: "Dashboard",
      workspace: "Workspace builder",
    },
    variantOptions: {
      short: "Pendek",
      medium: "Sedang",
      extended: "Panjang",
    },
    useTemplate: "Gunakan template",
    readyBadge: "Siap dipakai",
    examplesTitle: "Contoh prompt",
    examplesDescription: "Klik contoh untuk mengisi prompt yang lebih jelas.",
    promptPlaceholder: "Tulis brief singkat: tujuan, fitur wajib, UI / visual, data / backend, batasan, preview...",
    promptHint: "Enter untuk kirim, Shift+Enter untuk baris baru.",
    submitLabel: "Generate sekarang",
    submittingLabel: "Sedang generate...",
    charactersLabel: "karakter",
    emptyTitle: "Mulai dari prompt singkat",
    emptyDescription: "Kalau ingin bikin web atau workspace, isi Tujuan, Fitur wajib, UI, Data / backend, Batasan, dan Preview.",
    emptySuggestions: [
      "Buat workspace builder dengan Tujuan, Fitur wajib, UI, Data / backend, dan Preview",
      "Buat form login dengan validasi dan session-ready flow",
      "Buat dashboard dengan chart, tabel, dan state loading",
    ],
  },
  en: {
    collaborationLabel: "AI collaboration mode",
    collaborationDescription: "Choose how the AI should work with the editor and preview when the prompt is sent.",
    languageLabel: "Prompt language",
    languageDescription: "Choose Indonesian or English for templates, examples, and the structured brief sent to the AI.",
    templateOptions: {
      landing: "Landing page",
      auth: "Auth flow",
      dashboard: "Dashboard",
      workspace: "Workspace builder",
    },
    variantOptions: {
      short: "Short",
      medium: "Medium",
      extended: "Extended",
    },
    useTemplate: "Use template",
    readyBadge: "Ready to use",
    examplesTitle: "Prompt examples",
    examplesDescription: "Click an example to fill the prompt with a clearer brief.",
    promptPlaceholder: "Write a short brief: goal, must-have features, UI / visual, data / backend, constraints, preview...",
    promptHint: "Press Enter to send, Shift+Enter for a new line.",
    submitLabel: "Generate now",
    submittingLabel: "Generating...",
    charactersLabel: "characters",
    emptyTitle: "Start with a short prompt",
    emptyDescription: "If you want a web app or workspace, fill Goal, Must-have features, UI, Data / backend, Constraints, and Preview.",
    emptySuggestions: [
      "Build a workspace builder with Goal, Must-have features, UI, Data / backend, and Preview",
      "Build a login form with validation and session-ready flow",
      "Build a dashboard with charts, tables, and loading states",
    ],
  },
}

const PROMPT_STRUCTURE_HELPERS: Record<PromptLanguage, PromptStructureHelper[]> = {
  id: [
    { label: "Tujuan", description: "Apa hasil akhir yang ingin dibuat?" },
    { label: "Fitur wajib", description: "Komponen, halaman, atau flow yang harus ada." },
    { label: "UI / visual", description: "Tentukan feel, warna, dan gaya layout." },
    { label: "Data / backend", description: "Data, route, service, atau model yang dibutuhkan." },
    { label: "Batasan", description: "Hal yang tidak boleh ditambah atau diubah." },
    { label: "Preview", description: "Bagaimana hasil harus tampil di browser preview." },
  ],
  en: [
    { label: "Goal", description: "What should be built in the end?" },
    { label: "Must-have features", description: "Screens, components, or flows that must exist." },
    { label: "UI / visual", description: "Set the feel, colors, and layout style." },
    { label: "Data / backend", description: "Data, routes, services, or models required." },
    { label: "Constraints", description: "What should not be added or changed?" },
    { label: "Preview", description: "How the result should appear in browser preview." },
  ],
}

const PROMPT_EXAMPLES: Record<PromptLanguage, Record<PromptTemplateKey, PromptExample[]>> = {
  id: {
    landing: [
      {
        label: "SaaS",
        title: "Landing page SaaS modern",
        prompt:
          "Buat landing page SaaS AI untuk tim kecil. Wajib ada hero singkat, 3 benefit cards, pricing, testimonial, FAQ, dan CTA demo. Desain clean, modern, mobile-first.",
        variant: "extended",
      },
      {
        label: "Produk",
        title: "Landing page produk",
        prompt:
          "Buat landing page produk skincare dengan hero, before-after, ingredients, review pelanggan, dan CTA beli sekarang. Pakai tone premium dan warna lembut.",
        variant: "medium",
      },
      {
        label: "Event",
        title: "Landing page webinar",
        prompt:
          "Buat landing page webinar dengan countdown, agenda acara, speaker section, form registrasi, dan CTA daftar. Fokus ke conversion dan responsif.",
        variant: "short",
      },
    ],
    auth: [
      {
        label: "Login",
        title: "Auth flow lengkap",
        prompt:
          "Buat halaman login, register, forgot password, validasi form, dan session handling untuk aplikasi web. Tampilan modern dan mobile-friendly.",
        variant: "extended",
      },
      {
        label: "OAuth",
        title: "Auth dengan Google",
        prompt:
          "Buat sistem auth dengan login email/password dan tombol Google OAuth. Sertakan halaman sign in, sign up, serta route stub yang aman.",
        variant: "medium",
      },
      {
        label: "Reset",
        title: "Reset password",
        prompt:
          "Buat flow reset password yang ringkas: request reset, kirim email, set password baru, dan validasi input. Gunakan Next.js App Router.",
        variant: "short",
      },
    ],
    dashboard: [
      {
        label: "Admin",
        title: "Dashboard admin",
        prompt:
          "Buat dashboard admin dengan sidebar, KPI cards, chart revenue, tabel transaksi, dan filter tanggal. Layout harus rapi dan responsif.",
        variant: "extended",
      },
      {
        label: "Analytics",
        title: "Dashboard analytics",
        prompt:
          "Buat dashboard analytics untuk SaaS dengan ringkasan KPI, chart tren, recent activity, dan halaman detail project. Gunakan komponen reusable.",
        variant: "medium",
      },
      {
        label: "Project",
        title: "Dashboard project",
        prompt:
          "Buat dashboard project dengan overview, list project, status card, dan halaman detail project. Sertakan state empty dan loading.",
        variant: "short",
      },
    ],
    workspace: [
      {
        label: "Lovable",
        title: "Workspace builder seperti Lovable",
        prompt:
          "Buat workspace builder seperti Lovable atau Replit dengan file explorer, editor kode, live preview, terminal/output panel, share link, dan version history. Layout harus terasa seperti IDE yang modern, cepat, dan patch-first.",
        variant: "extended",
      },
      {
        label: "App builder",
        title: "AI app builder workspace",
        prompt:
          "Buat workspace AI app builder untuk web app Next.js. Wajib ada sidebar explorer, editor file, preview, panel error/log, dan command bar. Fokus ke alur edit, preview, perbaiki, lalu simpan.",
        variant: "medium",
      },
      {
        label: "IDE",
        title: "IDE ringan untuk project web",
        prompt:
          "Buat IDE ringan untuk project web dengan file tree, code editor, preview, dan area output. Tambahkan state kosong yang jelas, aksi cepat, dan layout split pane yang nyaman.",
        variant: "short",
      },
    ],
  },
  en: {
    landing: [
      {
        label: "SaaS",
        title: "Modern SaaS landing page",
        prompt:
          "Build an AI SaaS landing page for a small team. Include a short hero, 3 benefit cards, pricing, testimonials, FAQ, and a demo CTA. Keep the design clean, modern, and mobile-first.",
        variant: "extended",
      },
      {
        label: "Product",
        title: "Product landing page",
        prompt:
          "Build a skincare product landing page with a hero, before-and-after section, ingredients, customer reviews, and a buy-now CTA. Use a premium tone and soft colors.",
        variant: "medium",
      },
      {
        label: "Event",
        title: "Webinar landing page",
        prompt:
          "Build a webinar landing page with a countdown, agenda, speaker section, registration form, and sign-up CTA. Focus on conversion and responsiveness.",
        variant: "short",
      },
    ],
    auth: [
      {
        label: "Login",
        title: "Complete auth flow",
        prompt:
          "Build login, register, forgot password, form validation, and session handling pages for a web app. Keep the UI modern and mobile-friendly.",
        variant: "extended",
      },
      {
        label: "OAuth",
        title: "Auth with Google",
        prompt:
          "Build an auth system with email/password login and a Google OAuth button. Include sign in, sign up, and safe route stubs.",
        variant: "medium",
      },
      {
        label: "Reset",
        title: "Password reset",
        prompt:
          "Build a compact password reset flow: request reset, email delivery, new password form, and input validation. Use Next.js App Router.",
        variant: "short",
      },
    ],
    dashboard: [
      {
        label: "Admin",
        title: "Admin dashboard",
        prompt:
          "Build an admin dashboard with a sidebar, KPI cards, revenue charts, transaction table, and date filters. Keep the layout clean and responsive.",
        variant: "extended",
      },
      {
        label: "Analytics",
        title: "Analytics dashboard",
        prompt:
          "Build a SaaS analytics dashboard with KPI summaries, trend charts, recent activity, and a project detail page. Use reusable components.",
        variant: "medium",
      },
      {
        label: "Project",
        title: "Project dashboard",
        prompt:
          "Build a project dashboard with an overview, project list, status cards, and a project detail page. Include empty and loading states.",
        variant: "short",
      },
    ],
    workspace: [
      {
        label: "Lovable",
        title: "Lovable-style workspace builder",
        prompt:
          "Build a Lovable or Replit-style workspace builder with a file explorer, code editor, live preview, terminal/output panel, share link, and version history. The layout should feel like a modern IDE that is fast and patch-first.",
        variant: "extended",
      },
      {
        label: "App builder",
        title: "AI app builder workspace",
        prompt:
          "Build an AI app builder workspace for a Next.js web app. Include a sidebar explorer, file editor, preview, error/log panel, and a command bar. Focus on edit, preview, fix, and save.",
        variant: "medium",
      },
      {
        label: "IDE",
        title: "Lightweight web IDE",
        prompt:
          "Build a lightweight web IDE with a file tree, code editor, preview, and output area. Add clear empty states, quick actions, and a comfortable split-pane layout.",
        variant: "short",
      },
    ],
  },
}

function getPromptExamples(templateKey: PromptTemplateKey, language: PromptLanguage) {
  return PROMPT_EXAMPLES[language][templateKey]
}

export function ChatPanel({
  projectId,
  messages,
  onSendMessage,
  onCancelGeneration,
  isGenerating,
  modelOptions,
  selectedModel,
  onModelChange,
  onViewCode,
  providerStatus,
  previewErrorContext,
  generationProgress,
}: ChatPanelProps) {
  const [input, setInput] = useState("")
  const [templateKey, setTemplateKey] = useState<PromptTemplateKey>("workspace")
  const [templateVariant, setTemplateVariant] = useState<TemplateVariant>("short")
  const [promptLanguage, setPromptLanguage] = useState<PromptLanguage>("id")
  const [collaborationMode, setCollaborationMode] = useState<CollaborationMode>("build")
  const [showAdvancedTools, setShowAdvancedTools] = useState(false)
  const [estimate, setEstimate] = useState<EstimateState>({ isLoading: false })
  const [attachments, setAttachments] = useState<PromptAttachment[]>([])
  const [attachmentError, setAttachmentError] = useState<string | null>(null)
  const [isReadingFiles, setIsReadingFiles] = useState(false)
  const scrollRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const selectedModelInfo = modelOptions.find((model) => model.key === selectedModel)
  const selectedModelLabel = selectedModelInfo
    ? sanitizeModelDisplayName(selectedModelInfo.label)
    : "Pilih AI"
  const selectedModelDescription =
    selectedModelInfo?.description || selectedModelInfo?.note || "Swift AI"
  const promptCopy = PROMPT_PANEL_COPY[promptLanguage]
  const collaborationCopy = COLLABORATION_MODES[promptLanguage]
  const isChatCollaborationMode = !isMutatingCollaborationMode(collaborationMode)
  const submitLabel = isChatCollaborationMode
    ? promptLanguage === "id"
      ? "Tanya AI"
      : "Ask AI"
    : promptCopy.submitLabel
  const stopLabel = isChatCollaborationMode
    ? promptLanguage === "id"
      ? "Stop jawaban"
      : "Stop answer"
    : promptLanguage === "id"
      ? "Stop generate"
      : "Stop generation"
  const promptHint = isChatCollaborationMode
    ? promptLanguage === "id"
      ? "Mode ini menjawab saja: tidak mengubah file dan tidak memakai kuota generate."
      : "This mode only answers: it does not change files or use generate quota."
    : promptCopy.promptHint
  const promptPlaceholder = isChatCollaborationMode
    ? promptLanguage === "id"
      ? "Tanyakan apa saja soal project, kode, atau rencana fitur..."
      : "Ask anything about the project, code, or feature plans..."
    : promptCopy.promptPlaceholder
  const promptIntent = analyzePromptIntent(input, promptLanguage)
  const promptExamples = getPromptExamples(templateKey, promptLanguage)
  const selectedModelSupportsVision = VISION_CAPABLE_MODEL_KEYS.has(selectedModel)
  const hasImageAttachments = attachments.some((attachment) => attachment.kind === "image")
  const canSubmit = Boolean(
    input.trim() &&
      selectedModel &&
      !isGenerating &&
      !isReadingFiles &&
      input.length <= MAX_PROMPT_LENGTH
  )

  // Auto-scroll to bottom when new messages arrive
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
  }, [messages])

  const removeAttachment = (id: string) => {
    setAttachments((current) => current.filter((attachment) => attachment.id !== id))
  }

  const readAttachment = async (file: File): Promise<PromptAttachment> => {
    const id =
      typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
        ? crypto.randomUUID()
        : `${Date.now()}_${Math.random().toString(36).slice(2, 10)}`
    const mimeType = file.type || "application/octet-stream"
    const name = file.name || "attachment"

    if (mimeType.startsWith("image/")) {
      const dataUrl = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader()
        reader.onload = () => resolve(String(reader.result || ""))
        reader.onerror = () => reject(new Error(`Gagal membaca gambar "${name}".`))
        reader.readAsDataURL(file)
      })

      return {
        id,
        name,
        originalName: name,
        mimeType,
        size: file.size,
        kind: "image",
        content: dataUrl.slice(0, MAX_IMAGE_DATA_URL_CHARS),
      }
    }

    const textContent = await file.text()

    return {
      id,
      name,
      originalName: name,
      mimeType,
      size: file.size,
      kind: "text",
      content: textContent.slice(0, MAX_TEXT_FILE_CHARS),
    }
  }

  const uploadAttachments = async (files: File[]) => {
    const formData = new FormData()

    for (const file of files) {
      formData.append("files", file)
    }

    const response = await fetch(`/api/projects/${projectId}/attachments`, {
      method: "POST",
      body: formData,
    })

    const payload = (await response.json().catch(() => ({}))) as {
      error?: string
      attachments?: UploadedProjectAttachment[]
    }

    if (!response.ok) {
      throw new Error(payload.error || "Gagal mengunggah file ke Supabase.")
    }

    if (!Array.isArray(payload.attachments)) {
      throw new Error("Unexpected upload response from server.")
    }

    return payload.attachments
  }

  const handleChooseFiles = () => {
    if (isGenerating || isReadingFiles) return
    fileInputRef.current?.click()
  }

  const handleFileChange = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files || [])
    event.target.value = ""

    if (files.length === 0) return

    const availableSlots = Math.max(0, MAX_ATTACHMENTS - attachments.length)
    if (availableSlots === 0) {
      setAttachmentError(`Maksimal ${MAX_ATTACHMENTS} lampiran per prompt.`)
      return
    }

    const filesToRead = files.slice(0, availableSlots)
    const oversized = filesToRead.find((file) => file.size > MAX_FILE_SIZE_BYTES)
    if (oversized) {
      setAttachmentError(`File "${oversized.name}" melebihi batas ${(MAX_FILE_SIZE_BYTES / (1024 * 1024)).toFixed(0)}MB.`)
      return
    }

    try {
      setIsReadingFiles(true)
      setAttachmentError(null)
      const [parsed, uploaded] = await Promise.all([
        Promise.all(filesToRead.map((file) => readAttachment(file))),
        uploadAttachments(filesToRead),
      ])

      if (uploaded.length !== parsed.length) {
        throw new Error("Upload response does not match selected files.")
      }

      const hydratedAttachments = parsed.map((attachment, index) => {
        const uploadedAttachment = uploaded[index]

        return {
          ...attachment,
          id: uploadedAttachment.id,
          name: uploadedAttachment.originalName || attachment.name,
          originalName: uploadedAttachment.originalName || attachment.originalName || attachment.name,
          assetId: uploadedAttachment.id,
          storageBucket: uploadedAttachment.storageBucket,
          storagePath: uploadedAttachment.storagePath,
          uploadedAt: uploadedAttachment.uploadedAt,
          uploadedByUserId: uploadedAttachment.uploadedByUserId,
        }
      })

      setAttachments((current) => [...current, ...hydratedAttachments])
    } catch (error) {
      setAttachmentError(error instanceof Error ? error.message : "Gagal memproses lampiran.")
    } finally {
      setIsReadingFiles(false)
    }
  }

  const handleSubmit = () => {
    if (!canSubmit) return
    onSendMessage(input.trim(), selectedModel, attachments, promptLanguage, previewErrorContext, collaborationMode)
    setInput("")
    setAttachments([])
    setAttachmentError(null)
  }

  const handleFixPreviewError = () => {
    const previewError = previewErrorContext?.trim()
    if (!previewError || !selectedModel || isGenerating || isReadingFiles) return

    const fixPrompt =
      promptLanguage === "id"
        ? [
            "Perbaiki error preview berikut dengan patch minimal.",
            "Jangan rewrite seluruh project. Gunakan file aktif, preview context, dan file terkait sebagai evidence.",
            "",
            `Error preview: ${previewError}`,
          ].join("\n")
        : [
            "Fix the following preview error with the smallest safe patch.",
            "Do not rewrite the whole project. Use the active file, preview context, and related files as evidence.",
            "",
            `Preview error: ${previewError}`,
          ].join("\n")

    setCollaborationMode("build")
    onSendMessage(fixPrompt, selectedModel, attachments, promptLanguage, previewError, "build")
    setInput("")
    setAttachments([])
    setAttachmentError(null)
  }

  const handleApplyTemplate = () => {
    setInput(getTemplate(templateKey, templateVariant, promptLanguage))
  }

  const handleApplyPromptExample = (example: PromptExample) => {
    setTemplateVariant(example.variant)
    setInput(example.prompt)
    window.requestAnimationFrame(() => {
      textareaRef.current?.focus()
    })
  }

  const handleInsertPromptLine = (label: string) => {
    setInput((current) => {
      const normalizedLabel = `${label}:`
      const alreadyIncluded = current
        .split("\n")
        .some((line) => line.trim().toLowerCase().startsWith(normalizedLabel.toLowerCase()))

      if (alreadyIncluded) {
        return current
      }

      const trimmedCurrent = current.trimEnd()
      return trimmedCurrent ? `${trimmedCurrent}\n\n${label}:\n- ` : `${label}:\n- `
    })

    window.requestAnimationFrame(() => {
      textareaRef.current?.focus()
    })
  }

  useEffect(() => {
    const prompt = input.trim()

    if (!prompt || prompt.length > MAX_PROMPT_LENGTH || !isMutatingCollaborationMode(collaborationMode)) {
      setEstimate({ isLoading: false })
      return
    }

    const controller = new AbortController()
    const timeout = window.setTimeout(async () => {
      setEstimate((prev) => ({
        ...prev,
        isLoading: true,
        error: undefined,
      }))

      try {
        const response = await fetch("/api/generate/estimate", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            prompt,
            attachments,
            selectedModel,
            projectId,
          }),
          signal: controller.signal,
        })

        const payload = await response.json().catch(() => null)

        if (!response.ok) {
          throw new Error(payload?.error || "Failed to estimate request")
        }

        setEstimate({
          isLoading: false,
          estimatedTokens: payload?.estimatedTokens,
          estimatedCost: payload?.estimatedCost,
          canAfford: payload?.canAfford,
          remainingBalance: payload?.remainingBalance,
          currentBalance: payload?.currentBalance,
        })
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") {
          return
        }

        setEstimate({
          isLoading: false,
          error: error instanceof Error ? error.message : "Failed to estimate request",
        })
      }
    }, 320)

    return () => {
      window.clearTimeout(timeout)
      controller.abort()
    }
  }, [attachments, input, selectedModel, projectId, collaborationMode])

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault()
      handleSubmit()
    }
  }

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden border-r border-border/70 bg-background">
      {/* Messages */}
      <ScrollArea ref={scrollRef} className="min-h-0 flex-1 p-4">
        {messages.length === 0 ? (
          <EmptyState
            promptLanguage={promptLanguage}
            onSuggestionSelect={setInput}
            onTemplateSelect={(key) => {
              setTemplateKey(key)
              setTemplateVariant("short")
              setInput(getTemplate(key, "short", promptLanguage))
            }}
          />
        ) : (
          <div className="space-y-6">
            {messages.map((message) => (
              <MessageBubble
                key={message.id}
                message={message}
                onViewCode={onViewCode}
                generationProgress={generationProgress}
              />
            ))}
          </div>
        )}
      </ScrollArea>

      {/* Input - Streamlined Replit-style */}
      <div className="shrink-0 border-t border-border/70 bg-background/95 p-3 backdrop-blur-xl">
        <div className="space-y-2.5">
          {providerStatus && providerStatus.issue !== "healthy" && (
            <ProviderHealthCard status={providerStatus} />
          )}

          {generationProgress && (
            <GenerationProgressCard
              progress={generationProgress}
              isGenerating={isGenerating}
              onCancelGeneration={onCancelGeneration}
            />
          )}

          {previewErrorContext && (
            <div className="flex items-center justify-between gap-2 rounded-xl border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-xs">
              <div className="min-w-0">
                <span className="font-medium text-rose-300">Preview Error</span>
                <p className="line-clamp-1 text-[11px] text-muted-foreground">{previewErrorContext}</p>
              </div>
              <Button
                type="button"
                size="sm"
                variant="destructive"
                className="h-7 shrink-0 gap-1.5 px-2.5 text-xs font-medium"
                onClick={handleFixPreviewError}
                disabled={!selectedModel || isGenerating || isReadingFiles}
              >
                <ShieldAlert className="h-3.5 w-3.5" />
                Fix dengan AI
              </Button>
            </div>
          )}

          {/* Mode Switcher: Build / Ask (Replit style) */}
          <div className="flex items-center justify-between px-0.5">
            <div className="inline-flex rounded-lg border border-border/80 bg-muted/40 p-0.5">
              <button
                type="button"
                onClick={() => setCollaborationMode("build")}
                disabled={isGenerating}
                className={cn(
                  "inline-flex items-center gap-1.5 rounded-md px-3 py-1 text-xs font-medium transition-colors",
                  collaborationMode === "build"
                    ? "bg-primary text-primary-foreground shadow-sm"
                    : "text-muted-foreground hover:text-foreground"
                )}
              >
                <Zap className="h-3.5 w-3.5" />
                Build
              </button>
              <button
                type="button"
                onClick={() => setCollaborationMode("ask")}
                disabled={isGenerating}
                className={cn(
                  "inline-flex items-center gap-1.5 rounded-md px-3 py-1 text-xs font-medium transition-colors",
                  collaborationMode === "ask"
                    ? "bg-primary text-primary-foreground shadow-sm"
                    : "text-muted-foreground hover:text-foreground"
                )}
              >
                Ask
              </button>
            </div>

            <span className="text-[11px] text-muted-foreground">
              {collaborationMode === "build" ? "🔨 Generate & edit code" : "💬 Tanya jawab tanpa ubah file"}
            </span>
          </div>

          {/* Attachments Pills */}
          {attachments.length > 0 && (
            <div className="flex flex-wrap gap-1.5 px-0.5">
              {attachments.map((attachment) => (
                <span
                  key={attachment.id}
                  className="inline-flex items-center gap-1 rounded-full border border-border bg-background px-2.5 py-0.5 text-xs text-muted-foreground"
                >
                  <span className="max-w-[140px] truncate">{attachment.originalName || attachment.name}</span>
                  <button
                    type="button"
                    onClick={() => removeAttachment(attachment.id)}
                    className="hover:text-destructive"
                  >
                    <X className="h-3 w-3" />
                  </button>
                </span>
              ))}
            </div>
          )}

          {/* Input Box Card */}
          <div className="rounded-xl border border-border/80 bg-card p-2 shadow-sm focus-within:border-primary/50 focus-within:ring-1 focus-within:ring-primary/20">
            <Textarea
              ref={textareaRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder={
                collaborationMode === "build"
                  ? "Ketik apa yang ingin Anda buat... (contoh: Buat aplikasi kasir laundry lengkap)"
                  : "Tanyakan tentang kode atau arsitektur project..."
              }
              className="min-h-[72px] max-h-[180px] w-full resize-none border-0 bg-transparent p-1.5 text-sm leading-relaxed placeholder:text-muted-foreground/60 focus-visible:ring-0 focus-visible:ring-offset-0"
              disabled={isGenerating}
            />

            <div className="mt-1 flex items-center justify-between border-t border-border/40 pt-1.5">
              <div className="flex items-center gap-1">
                <input
                  ref={fileInputRef}
                  type="file"
                  className="hidden"
                  multiple
                  onChange={handleFileChange}
                />
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7 text-muted-foreground hover:text-foreground"
                  disabled={isGenerating || isReadingFiles || attachments.length >= MAX_ATTACHMENTS}
                  onClick={handleChooseFiles}
                  title="Upload file"
                >
                  <Paperclip className="h-3.5 w-3.5" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7 text-muted-foreground hover:text-foreground"
                  disabled={isGenerating || isReadingFiles || attachments.length >= MAX_ATTACHMENTS}
                  onClick={handleChooseFiles}
                  title="Upload gambar"
                >
                  <ImageIcon className="h-3.5 w-3.5" />
                </Button>

                <Select value={selectedModel} onValueChange={onModelChange} disabled={isGenerating}>
                  <SelectTrigger className="h-7 gap-1 border-0 bg-transparent px-2 text-[11px] text-muted-foreground hover:text-foreground">
                    <SelectValue placeholder="Model" />
                  </SelectTrigger>
                  <SelectContent align="start" className="w-[280px] p-1">
                    {modelOptions.map((model) => (
                      <SelectItem key={model.key} value={model.key} className="rounded-md text-xs">
                        <div className="flex items-center justify-between gap-2 w-full">
                          <span className="font-medium text-foreground">{sanitizeModelDisplayName(model.label)}</span>
                          <span className="text-[10px] text-muted-foreground">
                            Rp {(typeof model.price === "number" ? model.price : 0).toLocaleString("id-ID")}
                          </span>
                        </div>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <ProviderStatusBadge status={providerStatus} />
              </div>

              <div className="flex items-center gap-2">
                <span className="hidden text-[10px] text-muted-foreground sm:inline">
                  Enter ↵ untuk kirim
                </span>
                <Button
                  type="button"
                  size="sm"
                  variant={isGenerating ? "destructive" : "default"}
                  className="h-7 gap-1.5 rounded-lg px-3 text-xs font-semibold shadow-sm"
                  onClick={isGenerating ? onCancelGeneration : handleSubmit}
                  disabled={isGenerating ? !onCancelGeneration : !canSubmit}
                >
                  {isGenerating ? (
                    <>
                      <Square className="h-3.5 w-3.5" />
                      Stop
                    </>
                  ) : (
                    <>
                      <Send className="h-3.5 w-3.5" />
                      {collaborationMode === "build" ? "Build" : "Ask"}
                    </>
                  )}
                </Button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

function ProviderStatusBadge({ status }: { status?: ProviderStatus | null }) {
  if (!status) {
    return (
      <span className="rounded-full border border-border px-2 py-1 text-[11px] text-muted-foreground">
        idle
      </span>
    )
  }

  const statusConfig =
    status.issue === "healthy"
      ? {
          label: "connected",
          className: "border-emerald-500/40 bg-emerald-500/10 text-emerald-300",
        }
      : status.issue === "latency" || status.status === "slow"
        ? {
          label: "slow",
          className: "border-amber-500/40 bg-amber-500/10 text-amber-300",
        }
      : status.issue === "auth"
        ? {
            label: "auth",
            className: "border-rose-500/40 bg-rose-500/10 text-rose-300",
          }
        : status.issue === "quota"
          ? {
              label: "quota",
              className: "border-rose-500/40 bg-rose-500/10 text-rose-300",
            }
          : status.issue === "limit"
            ? {
                label: "limit",
                className: "border-amber-500/40 bg-amber-500/10 text-amber-300",
              }
            : status.issue === "config"
              ? {
                  label: "config",
                  className: "border-rose-500/40 bg-rose-500/10 text-rose-300",
                }
        : {
            label: "error",
            className: "border-rose-500/40 bg-rose-500/10 text-rose-300",
          }

  return (
    <span
      title={status.reason || "Provider status"}
      className={cn(
        "rounded-full border px-2 py-1 text-[11px] font-medium uppercase tracking-wide",
        statusConfig.className
      )}
    >
      {statusConfig.label}
    </span>
  )
}

function ProviderHealthCard({
  status,
}: {
  status?: ProviderStatus | null
}) {
  if (!status) {
    return null
  }

  const config =
    status.issue === "healthy"
      ? {
          title: "Swift siap dipakai",
          className: "border-emerald-500/30 bg-emerald-500/10 text-emerald-100",
        }
      : status.issue === "latency"
        ? {
            title: "Swift hidup tapi lambat",
            className: "border-amber-500/30 bg-amber-500/10 text-amber-100",
          }
        : status.issue === "auth"
          ? {
              title: "Masalah auth atau akses model",
              className: "border-rose-500/30 bg-rose-500/10 text-rose-100",
            }
        : status.issue === "quota"
          ? {
              title: "Kapasitas Swift sedang penuh",
              className: "border-rose-500/30 bg-rose-500/10 text-rose-100",
            }
          : status.issue === "limit"
            ? {
                title: "Kuota generate harian sudah habis",
                className: "border-amber-500/30 bg-amber-500/10 text-amber-100",
              }
            : status.issue === "config"
              ? {
                  title: "Konfigurasi Swift belum lengkap",
                  className: "border-rose-500/30 bg-rose-500/10 text-rose-100",
                }
              : {
                  title: "Kesehatan Swift belum ideal",
                  className: "border-border bg-card/80 text-foreground",
                }

  return (
    <div className={cn("rounded-xl border px-3 py-3", config.className)}>
      <div className="flex items-center justify-between gap-3">
        <div>
          <p className="text-sm font-medium">{config.title}</p>
          <p className="mt-1 text-xs opacity-90">{sanitizePublicAiCopy(status.reason || "Status Swift tersedia.")}</p>
        </div>
        <ProviderStatusBadge status={status} />
      </div>
      <div className="mt-2 flex flex-wrap gap-3 text-[11px] opacity-80">
        {typeof status.responseTimeMs === "number" && (
          <span>Response {status.responseTimeMs} ms</span>
        )}
        {status.checkedAt && (
          <span>Checked {formatCheckedAt(status.checkedAt)}</span>
        )}
      </div>
      {status.action && (
        <p className="mt-2 text-xs opacity-90">{sanitizePublicAiCopy(status.action)}</p>
      )}
    </div>
  )
}

function GenerationProgressCard({
  progress,
  isGenerating,
  onCancelGeneration,
}: {
  progress: GenerationProgress
  isGenerating?: boolean
  onCancelGeneration?: () => void
}) {
  const [elapsedMs, setElapsedMs] = useState(() => Date.now() - progress.startedAt.getTime())

  useEffect(() => {
    const interval = window.setInterval(() => {
      setElapsedMs(Date.now() - progress.startedAt.getTime())
    }, 1000)

    return () => window.clearInterval(interval)
  }, [progress.startedAt])

  const timeoutSeconds = Math.max(1, Math.ceil(progress.timeoutMs / 1000))
  const isTerminal = progress.stage === "timeout" || progress.stage === "error" || progress.stage === "cancelled"
  const isOverdue = !isTerminal && elapsedMs > progress.timeoutMs
  const displayElapsedMs = Math.min(elapsedMs, progress.timeoutMs)
  const elapsedSeconds = Math.max(0, Math.floor(displayElapsedMs / 1000))
  const percent =
    typeof progress.progressPercent === "number"
      ? Math.max(0, Math.min(isTerminal ? 100 : 95, progress.progressPercent))
      : Math.min(isTerminal ? 100 : 95, Math.round((displayElapsedMs / progress.timeoutMs) * 100))
  const elapsedLabel = `${elapsedSeconds}s`
  const steps = getGenerationSteps(progress.stage)

  return (
    <div className={cn(
      "rounded-xl border px-3 py-3 text-xs",
      isTerminal ? "border-rose-500/30 bg-rose-500/10" : "border-sky-500/30 bg-sky-500/10"
    )}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-medium text-foreground">{progress.label}</p>
          <p className="mt-1 text-muted-foreground">
            {progress.modelKey || "Swift AI"} · {elapsedLabel} / {timeoutSeconds}s
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <span className="rounded-full border border-border bg-background px-2 py-0.5 text-[10px] uppercase text-muted-foreground">
            {progress.stage}
          </span>
          {isGenerating && onCancelGeneration && progress.stage !== "cancelled" && (
            <Button
              type="button"
              size="sm"
              variant="destructive"
              className="h-7 gap-1 px-2 text-[11px]"
              onClick={onCancelGeneration}
            >
              <Square className="h-3 w-3" />
              Stop
            </Button>
          )}
        </div>
      </div>
      <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-background">
        <div
          className={cn("h-full rounded-full transition-all", isTerminal ? "bg-rose-500" : "bg-sky-500")}
          style={{ width: `${percent}%` }}
        />
      </div>
      {isOverdue && (
        <p className="mt-2 text-[11px] text-amber-300">
          Batas {timeoutSeconds} detik tercapai. Swift sedang menghentikan job dan memproses refund bila diperlukan.
        </p>
      )}
      {!isTerminal && progress.queueState === "waiting_worker" && elapsedMs > 45_000 && (
        <p className="mt-2 text-[11px] text-amber-300">
          Worker generation belum juga mengambil job ini. Jalankan <span className="font-mono">npm run worker:generation</span>{" "}
          (lokal) atau cek service worker di production, lalu biarkan tab terbuka sampai job masuk.
        </p>
      )}
      {progress.prompt && (
        <p className="mt-2 line-clamp-2 text-muted-foreground">
          Prompt: {progress.prompt}
        </p>
      )}
      {progress.statusHint && (
        <p className="mt-2 rounded-md border border-border bg-background/70 px-2 py-1 text-[11px] text-muted-foreground">
          {progress.statusHint}
        </p>
      )}
      {progress.retryHint && (
        <p className="mt-2 rounded-md border border-amber-500/30 bg-amber-500/10 px-2 py-1 text-[11px] text-amber-300">
          {progress.retryHint}
        </p>
      )}
      {progress.workPlan && progress.workPlan.length > 0 && (
        <details className="mt-2.5 rounded-lg border border-border/80 bg-background/50 p-2 text-xs">
          <summary className="cursor-pointer text-[11px] font-medium text-muted-foreground hover:text-foreground">
            ▸ Rencana Arsitektur ({progress.workPlan.length} detail)
          </summary>
          <div className="mt-2 max-h-36 overflow-y-auto space-y-1 pr-1">
            {progress.workPlan
              .filter((item) => !item.startsWith("Allowed packages:") && !item.includes("blueprint requires") && !item.includes("context ranking"))
              .map((item) => (
                <div key={item} className="flex items-start gap-1.5 text-[11px] text-muted-foreground">
                  <span className="mt-1 h-1.5 w-1.5 shrink-0 rounded-full bg-sky-500" />
                  <span className="break-words">{item}</span>
                </div>
              ))}
          </div>
        </details>
      )}
      <div className="mt-3 grid gap-1">
        {steps.map((step) => (
          <div key={step.label} className="flex items-center gap-2 text-[11px] text-muted-foreground">
            <span
              className={cn(
                "h-1.5 w-1.5 rounded-full",
                step.state === "done"
                  ? "bg-emerald-500"
                  : step.state === "active"
                    ? "bg-sky-500"
                    : "bg-muted-foreground/30"
              )}
            />
            <span className={cn(step.state === "active" && "font-medium text-foreground")}>{step.label}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

function getGenerationSteps(stage: GenerationProgress["stage"]) {
  const order: Array<{ stage: GenerationProgress["stage"]; label: string }> = [
    { stage: "context", label: "Planning app intent" },
    { stage: "request", label: "Selecting architecture or edit scope" },
    { stage: "provider", label: "Applying targeted file slices" },
    { stage: "parse", label: "Normalizing generated artifacts" },
    { stage: "validate", label: "Validating build and runtime" },
    { stage: "save", label: "Persisting validated project" },
    { stage: "preview", label: "Launching runnable preview" },
  ]
  const currentIndex = order.findIndex((item) => item.stage === stage)

  return order.map((item, index) => ({
    label: item.label,
    state:
      stage === "cancelled" || stage === "timeout" || stage === "error"
        ? index < Math.max(currentIndex, 0)
          ? "done"
          : index === Math.max(currentIndex, 0)
            ? "active"
            : "pending"
        : currentIndex < 0
          ? "pending"
          : index < currentIndex
            ? "done"
            : index === currentIndex
              ? "active"
              : "pending",
  }))
}

function formatCheckedAt(value: string) {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) {
    return "just now"
  }

  return date.toLocaleTimeString("id-ID", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  })
}

function EmptyState({
  promptLanguage,
  onSuggestionSelect,
  onTemplateSelect,
}: {
  promptLanguage: PromptLanguage
  onSuggestionSelect: (value: string) => void
  onTemplateSelect: (key: PromptTemplateKey) => void
}) {
  const copy = PROMPT_PANEL_COPY[promptLanguage]

  return (
    <div className="flex h-full flex-col items-center justify-center py-12 text-center">
      <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-primary">
        <Zap className="h-6 w-6 text-primary-foreground" />
      </div>
      <h3 className="text-lg font-semibold text-foreground">{copy.emptyTitle}</h3>
      <p className="mt-1 max-w-xs text-sm text-muted-foreground">{copy.emptyDescription}</p>
      <div className="mt-6 space-y-2">
        <SuggestionChip onClick={() => onSuggestionSelect(copy.emptySuggestions[0])}>{copy.emptySuggestions[0]}</SuggestionChip>
        <SuggestionChip onClick={() => onSuggestionSelect(copy.emptySuggestions[1])}>{copy.emptySuggestions[1]}</SuggestionChip>
        <SuggestionChip onClick={() => onSuggestionSelect(copy.emptySuggestions[2])}>{copy.emptySuggestions[2]}</SuggestionChip>
      </div>
      <div className="mt-4 flex flex-wrap justify-center gap-2">
        <Button type="button" variant="secondary" size="sm" onClick={() => onTemplateSelect("workspace")}>
          {copy.templateOptions.workspace}
        </Button>
        <Button type="button" variant="secondary" size="sm" onClick={() => onTemplateSelect("landing")}>
          {copy.templateOptions.landing}
        </Button>
        <Button type="button" variant="secondary" size="sm" onClick={() => onTemplateSelect("auth")}>
          {copy.templateOptions.auth}
        </Button>
        <Button type="button" variant="secondary" size="sm" onClick={() => onTemplateSelect("dashboard")}>
          {copy.templateOptions.dashboard}
        </Button>
      </div>
    </div>
  )
}

function SuggestionChip({ children, onClick }: { children: string; onClick?: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="block w-full rounded-lg border border-border bg-card px-4 py-2 text-left text-sm text-muted-foreground transition-colors hover:border-muted-foreground/30 hover:text-foreground"
    >
      {children}
    </button>
  )
}

function MessageBubble({
  message,
  onViewCode,
  generationProgress,
}: {
  message: Message
  onViewCode?: () => void
  generationProgress?: GenerationProgress | null
}) {
  const isUser = message.role === "user"

  return (
    <div className={cn("flex gap-3", isUser ? "justify-end" : "justify-start")}>
      {!isUser && (
        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-primary">
          <Zap className="h-4 w-4 text-primary-foreground" />
        </div>
      )}
      <div
        className={cn(
          "max-w-[85%] rounded-lg px-4 py-2",
          isUser ? "bg-secondary text-secondary-foreground" : "bg-card text-card-foreground"
        )}
      >
        {message.isGenerating ? (
          <div className="flex items-center gap-2">
            <div className="h-4 w-4 animate-spin rounded-full border-2 border-muted-foreground border-t-transparent" />
            <GeneratingStatus startedAt={message.timestamp} progress={generationProgress} />
          </div>
        ) : (
          <>
            <p className="text-sm whitespace-pre-wrap">{sanitizePublicAiCopy(message.content)}</p>
            {isUser && Array.isArray(message.metadata?.attachments) && message.metadata.attachments.length > 0 && (
              <div className="mt-2 flex flex-wrap gap-2 text-[11px] text-muted-foreground">
                {message.metadata.attachments.map((name) => (
                  <span key={name} className="rounded-full border border-border px-2 py-1">
                    {name}
                  </span>
                ))}
              </div>
            )}
            {!isUser && message.metadata?.model && (
              <div className="mt-3 flex flex-wrap gap-2 text-[11px] text-muted-foreground">
                <span className="rounded-full border border-border px-2 py-1">
                  Model: {sanitizeModelDisplayName(message.metadata.model)}
                </span>
                {message.metadata.failSafeType === "strict-fullstack" && (
                  <span className="inline-flex items-center gap-1 rounded-full border border-amber-500/40 bg-amber-500/10 px-2 py-1 font-medium text-amber-300">
                    <ShieldAlert className="h-3 w-3" />
                    strict-failsafe
                  </span>
                )}
                {typeof message.metadata.cost === "number" && (
                  <span className="rounded-full border border-border px-2 py-1">
                    Cost: Rp {message.metadata.cost.toLocaleString("id-ID")}
                  </span>
                )}
                {typeof message.metadata.remainingBalance === "number" && (
                  <span className="rounded-full border border-border px-2 py-1">
                    Balance: Rp {message.metadata.remainingBalance.toLocaleString("id-ID")}
                  </span>
                )}
              </div>
            )}
            {message.generatedCode && (
              <div className="mt-3 rounded-lg border border-border bg-background p-3">
                <div className="flex items-center justify-between text-xs text-muted-foreground">
                  <span>Generated Component</span>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-6 text-xs"
                    onClick={onViewCode}
                  >
                    View Code
                  </Button>
                </div>
              </div>
            )}
          </>
        )}
      </div>
      {isUser && (
        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-secondary">
          <span className="text-xs font-medium text-secondary-foreground">U</span>
        </div>
      )}
    </div>
  )
}

function GeneratingStatus({ startedAt, progress }: { startedAt: Date; progress?: GenerationProgress | null }) {
  const [elapsedMs, setElapsedMs] = useState(() => Date.now() - startedAt.getTime())

  useEffect(() => {
    const interval = window.setInterval(() => {
      setElapsedMs(Date.now() - startedAt.getTime())
    }, 1000)

    return () => {
      window.clearInterval(interval)
    }
  }, [startedAt])

  let label = progress?.label || "Menghubungi model..."

  if (!progress && elapsedMs >= 4000) {
    label = "Model sedang menyusun jawaban..."
  }

  if (!progress && elapsedMs >= 10000) {
    label = "Swift sedang lambat, mohon tunggu..."
  }

  if (!progress && elapsedMs >= 18000) {
    label = "Masih menunggu Swift. Request akan dihentikan otomatis jika terlalu lama."
  }

  const timeoutSeconds = progress ? Math.ceil(progress.timeoutMs / 1000) : null
  const displayElapsedMs = progress ? Math.min(elapsedMs, progress.timeoutMs) : elapsedMs
  const elapsedSeconds = Math.max(0, Math.floor(displayElapsedMs / 1000))

  return (
    <span className="text-sm text-muted-foreground">
      {label}
      {timeoutSeconds ? ` (${elapsedSeconds}s / ${timeoutSeconds}s)` : ""}
    </span>
  )
}

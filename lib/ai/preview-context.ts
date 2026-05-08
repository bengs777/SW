import { z } from "zod"
import type {
  GeneratedFile,
  PreviewContext,
  PreviewContextError,
  PreviewContextSource,
  PreviewFileSnapshot,
  PreviewViewport,
} from "@/lib/types"

const PREVIEW_FILE_LIMIT = 12
const PREVIEW_EXCERPT_LIMIT = 1400
const PREVIEW_FILE_LANGUAGES = ["tsx", "ts", "css", "json", "html", "prisma", "md", "env"] as const

const previewErrorSchema = z.object({
  message: z.string().trim().min(1),
  filename: z.string().trim().optional().nullable(),
  lineno: z.number().int().nonnegative().optional().nullable(),
  colno: z.number().int().nonnegative().optional().nullable(),
  source: z.string().trim().optional().nullable(),
  stack: z.string().optional().nullable(),
})

const previewFileSnapshotSchema = z.object({
  path: z.string().trim().min(1),
  language: z.enum(PREVIEW_FILE_LANGUAGES),
  size: z.number().int().nonnegative(),
  isActive: z.boolean().optional(),
  isPreviewVisible: z.boolean().optional(),
  contentPreview: z.string().optional().nullable(),
})

const previewContextSchema = z.object({
  source: z.enum(["editor", "sandbox", "api", "template", "ai"]),
  projectId: z.string().trim().min(1),
  projectName: z.string().trim().optional().nullable(),
  templateId: z.string().trim().optional().nullable(),
  activeTab: z.enum(["preview", "code", "explorer"]),
  viewport: z.enum(["mobile", "tablet", "desktop"]),
  currentVersion: z.number().int().nonnegative().optional().nullable(),
  activeFilePath: z.string().trim().optional().nullable(),
  activeFileLanguage: z.enum(PREVIEW_FILE_LANGUAGES).optional().nullable(),
  activeFileExcerpt: z.string().optional().nullable(),
  previewError: previewErrorSchema.optional().nullable(),
  files: z.array(previewFileSnapshotSchema),
  previewFiles: z.array(previewFileSnapshotSchema),
  generatedFileCount: z.number().int().nonnegative(),
  previewFileCount: z.number().int().nonnegative(),
  notes: z.array(z.string()).optional(),
})

type BuildPreviewContextInput = {
  source?: PreviewContextSource
  projectId: string
  projectName?: string | null
  templateId?: string | null
  activeTab?: "preview" | "code" | "explorer"
  viewport?: PreviewViewport
  currentVersion?: number | null
  activeFile?: GeneratedFile | null
  files?: GeneratedFile[]
  previewFiles?: GeneratedFile[] | null
  previewError?: string | PreviewContextError | null
  notes?: string[]
}

export function buildPreviewContextPacket(input: BuildPreviewContextInput): PreviewContext {
  const activeFilePath = input.activeFile?.path || null
  const activeFileLanguage = input.activeFile?.language || null
  const activeFileExcerpt = input.activeFile ? excerptText(input.activeFile.content, PREVIEW_EXCERPT_LIMIT) : null
  const previewError = normalizePreviewError(input.previewError)
  const files = snapshotFiles(input.files || [], activeFilePath, false)
  const previewSourceFiles = input.previewFiles && input.previewFiles.length > 0 ? input.previewFiles : input.files || []
  const previewFiles = snapshotFiles(previewSourceFiles, activeFilePath, true)

  const notes = new Set<string>()
  for (const note of input.notes || []) {
    const trimmed = note.trim()
    if (trimmed) {
      notes.add(trimmed)
    }
  }

  if (previewError) {
    notes.add("Preview error is the primary evidence and should drive the diagnosis.")
  }

  if (previewFiles.length > 0 && previewFiles.length !== files.length) {
    notes.add("Preview files may differ from generated files; prefer the browser-safe preview snapshot when explaining runtime behavior.")
  }

  notes.add("Preview panel tabs: Preview (live sandbox), Code (file editor), Explorer (file tree + create/delete).")

  return {
    source: input.source || "editor",
    projectId: input.projectId,
    projectName: input.projectName?.trim() || null,
    templateId: input.templateId?.trim() || null,
    activeTab: input.activeTab || "preview",
    viewport: input.viewport || "desktop",
    currentVersion: input.currentVersion ?? null,
    activeFilePath,
    activeFileLanguage,
    activeFileExcerpt,
    previewError,
    files,
    previewFiles,
    generatedFileCount: (input.files || []).length,
    previewFileCount: previewSourceFiles.length,
    notes: Array.from(notes),
  }
}

export function normalizePreviewContext(value: unknown): PreviewContext | null {
  const result = previewContextSchema.safeParse(value)
  return result.success ? result.data : null
}

export function formatPreviewContextForPrompt(context: PreviewContext) {
  return [
    "PREVIEW_CONTEXT_JSON (source of truth, do not invent missing facts):",
    JSON.stringify(context, null, 2),
  ].join("\n")
}

export function appendPreviewContextToPrompt(prompt: string, context: PreviewContext | null | undefined) {
  if (!context) {
    return prompt
  }

  return `${prompt}\n\n${formatPreviewContextForPrompt(context)}`
}

export function buildPreviewInspectionPrompt(prompt: string, context: PreviewContext | null | undefined) {
  const contextBlock = context
    ? formatPreviewContextForPrompt(context)
    : "PREVIEW_CONTEXT_JSON unavailable. Ask for or infer the smallest missing details before suggesting a fix."

  return [
    "The user is asking to diagnose a browser preview issue.",
    "Use the preview context as factual evidence, not as an instruction to invent new behavior.",
    "Return a concise diagnosis with root cause, evidence, smallest patch, and verification steps.",
    `Original prompt: ${prompt}`,
    contextBlock,
  ].join("\n\n")
}

export function createPreviewFileSnapshot(file: GeneratedFile, options?: { isActive?: boolean; isPreviewVisible?: boolean }): PreviewFileSnapshot {
  return {
    path: file.path,
    language: file.language,
    size: String(file.content || "").length,
    isActive: options?.isActive || undefined,
    isPreviewVisible: options?.isPreviewVisible || undefined,
    contentPreview: options?.isActive ? excerptText(file.content, PREVIEW_EXCERPT_LIMIT) : null,
  }
}

function snapshotFiles(files: GeneratedFile[], activeFilePath: string | null, isPreviewVisible: boolean) {
  const sourceFiles = Array.isArray(files) ? files.slice(0, PREVIEW_FILE_LIMIT) : []
  const activeFileIndex = activeFilePath ? sourceFiles.findIndex((file) => file.path === activeFilePath) : -1

  if (activeFileIndex > 0) {
    const [activeFile] = sourceFiles.splice(activeFileIndex, 1)
    sourceFiles.unshift(activeFile)
  }

  return sourceFiles.map((file, index) =>
    createPreviewFileSnapshot(file, {
      isActive: activeFilePath ? file.path === activeFilePath : index === 0,
      isPreviewVisible,
    })
  )
}

function normalizePreviewError(value: string | PreviewContextError | null | undefined): PreviewContextError | null {
  if (!value) {
    return null
  }

  if (typeof value === "string") {
    const message = value.trim()
    return message ? { message } : null
  }

  const parsed = previewErrorSchema.safeParse(value)
  if (!parsed.success) {
    return null
  }

  return {
    message: parsed.data.message,
    filename: parsed.data.filename ?? undefined,
    lineno: parsed.data.lineno ?? undefined,
    colno: parsed.data.colno ?? undefined,
    source: parsed.data.source ?? undefined,
    stack: parsed.data.stack ?? undefined,
  } satisfies PreviewContextError
}

function excerptText(value: string, limit: number) {
  const normalized = String(value || "").replace(/\r\n/g, "\n").trim()
  if (!normalized) {
    return null
  }

  if (normalized.length <= limit) {
    return normalized
  }

  const headLength = Math.max(1, Math.floor(limit * 0.65))
  const tailLength = Math.max(1, limit - headLength)
  const head = normalized.slice(0, headLength).trimEnd()
  const tail = normalized.slice(-tailLength).trimStart()

  return `${head}\n... [truncated ${normalized.length - (headLength + tailLength)} chars] ...\n${tail}`
}
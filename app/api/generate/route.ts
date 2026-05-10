import { NextRequest, NextResponse } from "next/server"
import { auth } from "@/auth"
import { prisma } from "@/lib/db/client"
import { BillingService } from "@/lib/services/billing.service"
import { ModelConfigService } from "@/lib/services/model-config.service"
import { ProjectFilePersistenceService } from "@/lib/services/project-file-persistence.service"
import { enforceAiUsageRateLimit } from "@/lib/security/rate-limit"
import { buildModuleStatusReport, buildProjectFiles } from "@/lib/ai/project-scaffold"
import { extractGeneratedFilesFromProviderMessage, mergeGeneratedFiles } from "@/lib/ai/provider-output"
import { enhancePromptWithAgentRouter } from "@/lib/ai/prompt-enhancer"
import { appendPreviewContextToPrompt, buildPreviewContextPacket, buildPreviewInspectionPrompt, normalizePreviewContext } from "@/lib/ai/preview-context"
import { appendAIContextToPrompt, buildAIContextSnapshot } from "@/lib/ai/context-engine"
import { autoRepairFullStackFiles, validateFullStackFiles } from "@/lib/ai/fullstack-validator"
import { ProviderRouter, SwiftProviderFailureError } from "@/lib/ai/provider-router"
import { SWIFT_AI_DISPLAY_NAME, isSupportedSwiftModelKey, isVisionCapableModel } from "@/lib/ai/models"
import { analyzePromptIntent, buildClarifyingPrompt } from "@/lib/ai/prompt-intent"
import type { PromptLanguage } from "@/lib/ai/prompt-templates"
import type { GeneratedFile, ProjectMemoryData, PromptAttachment } from "@/lib/types"
import { z } from "zod"
import ts from "typescript"
import { orchestrateGeneration } from "@/lib/ai/orchestrator"
import { log } from "@/lib/logging"
import { calculateModelRequestPrice } from "@/lib/ai/pricing"
import { USER_FRIENDLY_AI_ENGINE_ERROR } from "@/lib/ai/model-tiers"

export const runtime = "nodejs"
export const maxDuration = 300

class StrictFullStackValidationError extends Error {
  details: {
    missingBeforeRepair: string[]
    missingAfterRepair: string[]
    addedFiles: string[]
    parseMode: string
    providerFileCount: number
    finalFileCount: number
  }

  constructor(details: StrictFullStackValidationError["details"]) {
    super("STRICT_FULLSTACK_FAILSAFE_TRIGGERED")
    this.name = "StrictFullStackValidationError"
    this.details = details
  }
}

class RelevanceValidationError extends Error {
  details: RelevanceReport

  constructor(details: RelevanceReport) {
    super("RELEVANCE_FAILSAFE_TRIGGERED")
    this.name = "RelevanceValidationError"
    this.details = details
  }
}

type RelevanceReport = {
  score: number
  totalTerms: number
  matchedTerms: string[]
  missingTerms: string[]
  promptTerms: string[]
}

const MAX_PROMPT_LENGTH = 12000
const MAX_CONTEXTUAL_PROMPT_LENGTH = 36000
const MAX_PROVIDER_PROMPT_LENGTH = 42000
const MAX_ATTACHMENTS = 5
const MAX_ATTACHMENT_SIZE_BYTES = 3 * 1024 * 1024
const MAX_ATTACHMENT_CONTEXT_CHARS = 20000
const CONTEXT_FILE_CHAR_LIMIT = 2200
const CONTEXT_TOTAL_CHAR_LIMIT = 20000
const CONTEXT_MAX_FILE_COUNT = 18
const PROJECT_STRUCTURE_TREE_MAX_FILES = 140
const PROJECT_STRUCTURE_RELEVANT_FILE_LIMIT = 12
const PROJECT_STRUCTURE_RELEVANT_FILE_CHAR_LIMIT = 1400
const PROJECT_STRUCTURE_CONTEXT_CHAR_LIMIT = 14000
const PREVIEW_EXECUTABLE_FILE_PATTERN = /\.(tsx|ts|jsx|js|mjs|cjs)$/i
const PREVIEW_JSON_FILE_PATTERN = /\.json$/i
const PREVIEW_ASSET_FILE_PATTERN = /\.(css|scss|sass|less|md|env|prisma|html|txt|csv|yml|yaml|svg|png|jpe?g|gif|webp|avif|ico|bmp|mp4|webm|mp3|wav|ogg|woff2?|ttf|otf|lock|toml|ini|xml|pdf|webmanifest|manifest|d\.ts|d\.mts|d\.cts)$/i
const COLLABORATION_MODES = ["build", "edit", "fix", "review", "ask"] as const
const MAX_CONCURRENT_GENERATIONS_PER_USER = Math.max(1, Number(process.env.AI_MAX_CONCURRENT_GENERATIONS || 2))

type CollaborationMode = (typeof COLLABORATION_MODES)[number]
type FinalPromptMode = "generator" | "fix-complex" | "fix-simple" | "sandbox"
const activeGenerationsByUser = new Map<string, number>()
const inFlightGenerationKeys = new Set<string>()

const GenerateSchema = z.object({
  prompt: z.string().min(1),
  projectId: z.string().min(1),
  selectedModel: z.string().min(1),
  promptLanguage: z.enum(["id", "en"]).optional().default("id"),
  collaborationMode: z.enum(COLLABORATION_MODES).optional().default("build"),
  idempotencyKey: z.string().optional(),
  previewContext: z.unknown().optional(),
  attachments: z.array(
    z.object({
      id: z.string().min(1).max(100),
      name: z.string().min(1).max(180),
      originalName: z.string().max(180).optional(),
      mimeType: z.string().max(120).optional().default("application/octet-stream"),
      size: z.number().int().nonnegative().max(MAX_ATTACHMENT_SIZE_BYTES),
      kind: z.enum(["image", "text", "binary"]),
      content: z.string().min(1),
      assetId: z.string().max(100).optional(),
      storageBucket: z.string().max(120).optional(),
      storagePath: z.string().max(500).optional(),
      uploadedAt: z.string().optional(),
      uploadedByUserId: z.string().max(100).optional(),
    }).passthrough()
  ).max(MAX_ATTACHMENTS).optional().default([]),
})

function compactText(value: string | null | undefined, limit: number) {
  const text = String(value || "").replace(/\r\n/g, "\n").trim()
  if (text.length <= limit) {
    return text
  }

  const headLength = Math.max(1, Math.floor(limit * 0.7))
  const tailLength = Math.max(1, limit - headLength)
  return `${text.slice(0, headLength).trimEnd()}\n... [truncated ${text.length - limit} chars] ...\n${text
    .slice(-tailLength)
    .trimStart()}`
}

function appendProjectStructureContextToPrompt(
  prompt: string,
  input: {
    prompt: string
    projectName: string
    files: GeneratedFile[]
    activeFile?: GeneratedFile | null
    promptLanguage: PromptLanguage
  }
) {
  if (input.files.length === 0) {
    return prompt
  }

  const context = buildProjectStructureContext(input)
  if (!context) {
    return prompt
  }

  return `${prompt}\n\n${context}`
}

function buildProjectStructureContext(input: {
  prompt: string
  projectName: string
  files: GeneratedFile[]
  activeFile?: GeneratedFile | null
  promptLanguage: PromptLanguage
}) {
  const fileTree = buildFileTreeListing(input.files)
  const relevantFiles = selectRelevantProjectFiles(input)

  if (!fileTree && relevantFiles.length === 0) {
    return ""
  }

  const fileContext = relevantFiles
    .map((file) => {
      const content = compactText(file.content, PROJECT_STRUCTURE_RELEVANT_FILE_CHAR_LIMIT)
      return [
        `FILE: ${file.path}`,
        content || "[empty file]",
      ].join("\n")
    })
    .join("\n\n---\n\n")

  const context = [
    "### ROLE",
    "You are the Swift AI Full-Stack Engine. Your goal is to modify an existing web project based on user requests with surgical precision.",
    "",
    "### CONTEXT",
    `- Project Name: ${input.projectName}`,
    "- Current Project Files:",
    fileTree || "[no files available]",
    "",
    "### RULES FOR RESPONSE (STRICT)",
    "1. **Incremental Update Only**: ONLY return files that are newly created or modified.",
    '2. **Full File Content**: For any modified file, provide the COMPLETE updated code. Do NOT use comments like "// ... rest of code".',
    "3. **No Unchanged Files**: If a file does not need changes, DO NOT include it in your output.",
    "4. **JSON Structure**: You must output a valid JSON object with this exact key:",
    "{",
    '  "files": [',
    '    { "path": "string", "content": "string" }',
    "  ]",
    "}",
    "",
    "### PERFORMANCE GUIDELINES",
    "- Avoid unnecessary chat/explanation.",
    '- If the request is small (e.g., "change button color"), only return the file containing that button.',
    "- Ensure all imports in new files are correctly mapped to the existing project structure.",
    "",
    "### CURRENT FILE CONTENT FOR REFERENCE",
    fileContext || "[no relevant file context available]",
  ]
    .filter(Boolean)
    .join("\n")

  return compactText(context, PROJECT_STRUCTURE_CONTEXT_CHAR_LIMIT)
}

function buildFileTreeListing(files: GeneratedFile[]) {
  const paths = files
    .map((file) => normalizePath(file.path))
    .filter(Boolean)
    .sort((left, right) => left.localeCompare(right))

  const visiblePaths = paths.slice(0, PROJECT_STRUCTURE_TREE_MAX_FILES)
  const lines = visiblePaths.map((path) => `- ${path}`)

  if (paths.length > visiblePaths.length) {
    lines.push(`- ... ${paths.length - visiblePaths.length} more files omitted`)
  }

  return lines.join("\n")
}

function selectRelevantProjectFiles(input: {
  prompt: string
  files: GeneratedFile[]
  activeFile?: GeneratedFile | null
}) {
  const promptTerms = extractProjectContextTerms(input.prompt)
  const activePath = input.activeFile ? normalizePath(input.activeFile.path) : null

  return input.files
    .map((file) => ({
      file,
      score: scoreProjectFileForPrompt(file, {
        promptTerms,
        activePath,
      }),
    }))
    .filter((entry) => entry.score > 0)
    .sort((left, right) => {
      if (left.score !== right.score) {
        return right.score - left.score
      }

      return left.file.path.localeCompare(right.file.path)
    })
    .slice(0, PROJECT_STRUCTURE_RELEVANT_FILE_LIMIT)
    .map((entry) => entry.file)
}

function scoreProjectFileForPrompt(
  file: GeneratedFile,
  input: {
    promptTerms: string[]
    activePath: string | null
  }
) {
  const normalizedPath = normalizePath(file.path).toLowerCase()
  const searchable = `${normalizedPath}\n${String(file.content || "").toLowerCase().slice(0, 12000)}`
  let score = 0

  if (input.activePath && normalizedPath === input.activePath) score += 80
  if (/^app\/layout\.(tsx|ts)$/i.test(normalizedPath)) score += 65
  if (/^app\/page\.(tsx|ts)$/i.test(normalizedPath)) score += 55
  if (/^app\/.+\/page\.(tsx|ts)$/i.test(normalizedPath)) score += 42
  if (/^components\/(editor|dashboard|landing)\//i.test(normalizedPath)) score += 36
  if (/^components\//i.test(normalizedPath)) score += 28
  if (/^lib\/(services|ai|auth|billing|templates)\//i.test(normalizedPath)) score += 22
  if (/^app\/api\//i.test(normalizedPath)) score += 18
  if (/^(package|tsconfig|next\.config|components)\.json$/i.test(normalizedPath)) score += 12
  if (/^app\/globals\.css$/i.test(normalizedPath)) score += 10

  for (const term of input.promptTerms) {
    if (normalizedPath.includes(term)) {
      score += 45
      continue
    }

    if (searchable.includes(term)) {
      score += 18
    }
  }

  return score
}

function extractProjectContextTerms(prompt: string) {
  const normalized = prompt
    .toLowerCase()
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/[^a-z0-9\s/_-]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
  const stopWords = new Set([
    "buat",
    "bikin",
    "create",
    "build",
    "generate",
    "tambah",
    "add",
    "fitur",
    "feature",
    "page",
    "halaman",
    "app",
    "web",
    "website",
    "yang",
    "untuk",
    "dengan",
    "dan",
    "atau",
    "the",
    "and",
    "with",
    "for",
    "new",
    "baru",
  ])

  const words = normalized
    .split(" ")
    .map((word) => word.trim())
    .filter((word) => word.length >= 3 && !stopWords.has(word))

  return Array.from(new Set(words)).slice(0, 18)
}

function buildCompactContextualPrompt(input: {
  prompt: string
  projectName?: string | null
  activeFile?: GeneratedFile | null
  files: GeneratedFile[]
  previewError?: string | null
  promptLanguage: PromptLanguage
}) {
  const fileList = input.files.slice(0, CONTEXT_MAX_FILE_COUNT).map((file) => ({
    path: file.path,
    language: file.language,
    size: String(file.content || "").length,
  }))

  const activeFile = input.activeFile
    ? {
        path: input.activeFile.path,
        language: input.activeFile.language,
        contentPreview: compactText(input.activeFile.content, CONTEXT_FILE_CHAR_LIMIT),
      }
    : null

  const label =
    input.promptLanguage === "id"
      ? "KONTEKS_EDITOR_RINGKAS"
      : "COMPACT_EDITOR_CONTEXT"

  return [
    input.prompt,
    "",
    `${label}:`,
    JSON.stringify(
      {
        projectName: input.projectName || null,
        fileCount: input.files.length,
        files: fileList,
        activeFile,
        previewError: input.previewError || null,
        notes: [
          input.promptLanguage === "id"
            ? "Konteks penuh terlalu besar, jadi backend mengirim ringkasan agar generate tetap berjalan."
            : "Full context was too large, so the backend sent a compact summary to keep generation running.",
          input.promptLanguage === "id"
            ? "Gunakan daftar file dan activeFile sebagai source of truth. Jangan mengarang state yang tidak ada."
            : "Use the file list and activeFile as source of truth. Do not invent missing state.",
        ],
      },
      null,
      2
    ),
  ].join("\n")
}

function applyCollaborationModeToIntent(
  intent: ReturnType<typeof analyzePromptIntent>,
  collaborationMode: CollaborationMode,
  promptLanguage: PromptLanguage
) {
  if (collaborationMode === "ask") {
    return {
      ...intent,
      mode: "chat" as const,
      needsClarification: false,
      confidence: "high" as const,
    }
  }

  if (collaborationMode === "review") {
    return {
      ...intent,
      mode: "inspect" as const,
      needsClarification: false,
      confidence: "high" as const,
    }
  }

  if (collaborationMode === "build" || collaborationMode === "edit" || collaborationMode === "fix") {
    return {
      ...intent,
      mode: "build" as const,
      needsClarification: false,
      confidence: "high" as const,
      label:
        promptLanguage === "id"
          ? collaborationMode === "fix"
            ? "Siap memperbaiki project"
            : "Siap generate project"
          : collaborationMode === "fix"
            ? "Ready to fix project"
            : "Ready to generate project",
      summary:
        promptLanguage === "id"
          ? "Mode kolaborasi memaksa request ini dieksekusi sebagai perubahan file, bukan diagnosis teks."
          : "Collaboration mode forces this request to run as file changes, not a text-only diagnosis.",
      nextStep:
        promptLanguage === "id"
          ? "AI akan memakai konteks editor dan menyimpan hasil ke Explorer."
          : "AI will use editor context and save the result to Explorer.",
      example: intent.example,
    }
  }

  return intent
}

function getFriendlyProviderErrorMessage(errorMessage: string) {
  const normalized = errorMessage.toLowerCase()

  if (normalized.includes("ai_output_has_no_files")) {
    return "Swift berhasil menerima respons AI, tetapi output belum berisi file valid. Credit kamu otomatis dikembalikan dan file project tidak diubah."
  }

  return USER_FRIENDLY_AI_ENGINE_ERROR
}

function createGenerationGuard(input: {
  userId: string
  projectId: string
  selectedModel: string
  prompt: string
  idempotencyKey?: string
}) {
  const activeCount = activeGenerationsByUser.get(input.userId) || 0
  if (activeCount >= MAX_CONCURRENT_GENERATIONS_PER_USER) {
    return {
      error: NextResponse.json(
        {
          error: "Swift masih memproses generate sebelumnya. Tunggu proses selesai sebelum mengirim request baru.",
          code: "GENERATION_CONCURRENCY_LIMIT",
        },
        { status: 429 }
      ),
    }
  }

  const requestKey = input.idempotencyKey
    ? `idem:${input.projectId}:${input.idempotencyKey}`
    : `live:${input.userId}:${input.projectId}:${input.selectedModel}:${input.prompt.trim().toLowerCase().slice(0, 500)}`

  if (inFlightGenerationKeys.has(requestKey)) {
    return {
      error: NextResponse.json(
        {
          error: "Request yang sama sedang diproses. Swift membatalkan duplikasi agar credit tidak terpakai dua kali.",
          code: "DUPLICATE_GENERATION_IN_FLIGHT",
        },
        { status: 409 }
      ),
    }
  }

  activeGenerationsByUser.set(input.userId, activeCount + 1)
  inFlightGenerationKeys.add(requestKey)

  return {
    release() {
      const nextCount = Math.max(0, (activeGenerationsByUser.get(input.userId) || 1) - 1)
      if (nextCount === 0) {
        activeGenerationsByUser.delete(input.userId)
      } else {
        activeGenerationsByUser.set(input.userId, nextCount)
      }
      inFlightGenerationKeys.delete(requestKey)
    },
  }
}

function inferFinalPromptMode(input: {
  collaborationMode: CollaborationMode
  prompt: string
  errorLogs?: string | null
  existingFileCount: number
}) {
  const normalized = `${input.prompt}\n${input.errorLogs || ""}`.toLowerCase()

  if (
    /\b(env|environment|dependency|dependencies|package\.json|npm install|module not found|cannot find module|missing required environment|build failed|dev server|run app|jalankan|dependency|dependensi)\b/.test(normalized)
  ) {
    return "sandbox" as const
  }

  if (input.collaborationMode === "fix") {
    const looksSmall =
      /\b(import|syntax|typo|rename|className|small|kecil|ui bug)\b/.test(normalized) &&
      !/\b(api|database|prisma|auth|login|runtime|server|fullstack|backend)\b/.test(normalized)

    return looksSmall ? "fix-simple" as const : "fix-complex" as const
  }

  if (input.existingFileCount > 0 && /\b(fix|perbaiki|error|bug|crash|gagal)\b/.test(normalized)) {
    return "fix-complex" as const
  }

  return "generator" as const
}

function formatPreviewErrorLogs(previewContext: ReturnType<typeof normalizePreviewContext>) {
  const previewError = previewContext?.previewError
  if (!previewError) {
    return ""
  }

  return [
    previewError.message ? `message: ${previewError.message}` : "",
    previewError.filename ? `file: ${previewError.filename}` : "",
    typeof previewError.lineno === "number" ? `line: ${previewError.lineno}` : "",
    typeof previewError.colno === "number" ? `column: ${previewError.colno}` : "",
    previewError.stack ? `stack:\n${compactText(previewError.stack, 4000)}` : "",
  ].filter(Boolean).join("\n")
}

async function recordGenerationRequestLog(input: {
  projectId: string
  taskType: string
  modelConfigId?: string | null
  modelUsed: string
  provider?: string | null
  latencyMs: number
  tokens?: number
  success: boolean
  errorMessage?: string | null
  context?: Record<string, unknown>
}) {
  try {
    const contextJson = input.context
      ? JSON.stringify(input.context).slice(0, 8000)
      : undefined

    await prisma.requestLog.create({
      data: {
        projectId: input.projectId,
        taskType: input.taskType,
        modelConfigId: input.modelConfigId || undefined,
        modelUsed: input.modelUsed,
        provider: input.provider || undefined,
        latencyMs: Math.max(0, Math.round(input.latencyMs)),
        tokens: input.tokens || 0,
        success: input.success,
        errorMessage: input.errorMessage ? input.errorMessage.slice(0, 1000) : undefined,
        contextJson,
      },
    })
  } catch (error) {
    log("warn", "Failed to record generation request log", {
      projectId: input.projectId,
      taskType: input.taskType,
      error: error instanceof Error ? error.message : String(error),
    })
  }
}

function buildRecoveryRetryPrompt(userPrompt: string, contextualPrompt: string) {
  return [
    "Your previous response was invalid or contained no files.",
    `User Request: ${userPrompt}`,
    "",
    "Return ONLY a valid JSON object with this exact shape:",
    '{"files":[{"path":"...","content":"..."}]}',
    "",
    "Zero talk. Zero markdown formatting.",
    "Only include newly created or modified files.",
    "Use complete file content for every returned file.",
    "",
    "Use this existing project context to make a surgical incremental update:",
    contextualPrompt,
  ].join("\n")
}

function buildProviderExecutionContext(input: {
  promptWithAttachments: string
  promptWithPreviewContext: string
  promptLanguage: PromptLanguage
  collaborationMode: CollaborationMode
  promptIntent: ReturnType<typeof applyCollaborationModeToIntent>
}) {
  const contextualPrompt = input.promptWithPreviewContext.trim()
  const plainPrompt = input.promptWithAttachments.trim()
  if (!contextualPrompt || contextualPrompt === plainPrompt) {
    return ""
  }

  const title =
    input.promptLanguage === "id"
      ? "KONTEKS_EKSEKUSI_SWIFT"
      : "SWIFT_EXECUTION_CONTEXT"

  return [
    `${title} (source of truth for this generation):`,
    `- Collaboration mode: ${input.collaborationMode}`,
    `- Intent mode: ${input.promptIntent.mode}`,
    "- Use this context to follow the user's requested flow, active file, current files, project memory, and preview errors.",
    "- If any inferred planning text conflicts with this context or the latest user prompt, follow the latest user prompt and this context.",
    "",
    contextualPrompt,
  ].join("\n")
}

function buildFinalPrompt({
  mode,
  userPrompt,
  executionContext,
  errorLogs,
}: {
  mode: FinalPromptMode
  userPrompt: string
  executionContext?: string
  errorLogs?: string | null
}) {
  const contextPriority = [
    "CONTEXT PRIORITY:",
    "1. RUNTIME ERRORS",
    "2. USER REQUEST",
    "3. CURRENT FILE",
    "4. PROJECT MEMORY",
    "Ignore lower priority context if it conflicts with higher priority context.",
  ].join("\n")

  const generator = [
    "You are a production-grade full-stack AI builder.",
    "",
    "GOAL:",
    "Generate a COMPLETE and RUNNABLE Next.js full-stack app or patch.",
    "",
    "RULES:",
    "- Return ONLY JSON.",
    "- No markdown, no explanation, no TODO, no pseudo code.",
    "- All imports must resolve.",
    "- All code must run.",
    "- Return complete file contents for every changed file.",
    "",
    "FULLSTACK:",
    "- Use Next.js App Router.",
    "- API routes must be used by frontend.",
    "- Prisma must be used for persistent data when the user asks for data, auth, CRUD, dashboard, orders, billing, or admin flows.",
    "- Data must persist; do not make local React state the source of truth for persisted resources.",
    "",
    "INTEGRATION:",
    "- Frontend MUST call API for server data.",
    "- API MUST use database/service layer for persisted data.",
    "- No dead code.",
    "",
    "OUTPUT:",
    '{ "message": "short summary", "files": [{ "path": "string", "language": "tsx|ts|css|json|html|prisma|md|env", "content": "complete file content" }], "dependencies": [], "env": {} }',
  ].join("\n")

  const fixer = [
    "You are fixing a broken full-stack app.",
    "",
    "RULES:",
    "- Return ONLY JSON.",
    "- DO NOT rewrite the entire project.",
    "- ONLY modify broken or directly related files.",
    "- Keep all existing features.",
    "",
    "PRIORITY:",
    "1. Fix runtime/build errors.",
    "2. Restore API <-> frontend <-> DB connection.",
    "3. Ensure app runs.",
  ].join("\n")

  const simpleFix = [
    "Fix only small issues:",
    "- import error",
    "- syntax error",
    "- small UI bug",
    "",
    "Return ONLY JSON.",
    "DO NOT modify unrelated files.",
  ].join("\n")

  const sandbox = [
    "Fix project so it can run.",
    "",
    "Focus:",
    "- dependency issues",
    "- env issues",
    "- runtime crash",
    "",
    "Return ONLY JSON.",
    "Do NOT add new features.",
  ].join("\n")

  const systemPrompt =
    mode === "fix-complex"
      ? fixer
      : mode === "fix-simple"
        ? simpleFix
        : mode === "sandbox"
          ? sandbox
          : generator

  return [
    contextPriority,
    "",
    systemPrompt,
    "",
    "USER REQUEST:",
    userPrompt,
    "",
    errorLogs ? `ERROR LOGS:\n${errorLogs}` : "",
    "",
    "EXECUTION CONTEXT:",
    executionContext || "none",
  ].filter(Boolean).join("\n")
}

type GenerateRequestContext = {
  prompt: string
  selectedModel: string
  promptLanguage: PromptLanguage
  collaborationMode: CollaborationMode
  projectId: string
  idempotencyKey?: string
  previewContextFromClient: ReturnType<typeof normalizePreviewContext>
  attachments: PromptAttachment[]
  promptWithAttachments: string
}

async function parseGenerateRequest(request: NextRequest): Promise<GenerateRequestContext | NextResponse> {
  const raw = await request.json()
  const body = await GenerateSchema.parseAsync(raw)
  const prompt = body.prompt.trim()
  const selectedModel = body.selectedModel.trim()
  const promptLanguage = body.promptLanguage as PromptLanguage
  const collaborationMode = body.collaborationMode as CollaborationMode
  const projectId = body.projectId.trim()
  const idempotencyKey = body.idempotencyKey?.trim()
  const previewContextFromClient = normalizePreviewContext(body.previewContext)
  const attachments = normalizeAttachments(body.attachments)
  const promptWithAttachments = appendAttachmentsToPrompt(prompt, attachments)

  if (!prompt) {
    return NextResponse.json({ error: "Prompt is required", code: "PROMPT_REQUIRED" }, { status: 400 })
  }

  if (promptWithAttachments.length > MAX_PROMPT_LENGTH) {
    return NextResponse.json(
      {
        error: `Prompt exceeds maximum length of ${MAX_PROMPT_LENGTH} characters.`,
        code: "PROMPT_TOO_LONG",
        maxLength: MAX_PROMPT_LENGTH,
        currentLength: promptWithAttachments.length,
      },
      { status: 400 }
    )
  }

  if (!selectedModel) {
    return NextResponse.json({ error: "Model selection is required", code: "MODEL_REQUIRED" }, { status: 400 })
  }

  if (!isSupportedSwiftModelKey(selectedModel)) {
    return NextResponse.json({ error: "Selected model is not available. Use a Swift model tier.", code: "MODEL_NOT_AVAILABLE" }, { status: 403 })
  }

  if (!projectId) {
    return NextResponse.json({ error: "Project id is required", code: "PROJECT_REQUIRED" }, { status: 400 })
  }

  return {
    prompt,
    selectedModel,
    promptLanguage,
    collaborationMode,
    projectId,
    idempotencyKey,
    previewContextFromClient,
    attachments,
    promptWithAttachments,
  }
}

async function loadGenerationSubject(email: string, projectId: string) {
  const user = await prisma.user.findUnique({
    where: { email },
    select: {
      id: true,
      email: true,
      balance: true,
    },
  })

  if (!user) {
    return {
      error: NextResponse.json({ error: "Authenticated user not found" }, { status: 404 }),
    }
  }

  const project = await prisma.project.findFirst({
    where: {
      id: projectId,
      workspace: {
        members: {
          some: {
            userId: user.id,
          },
        },
      },
    },
    include: {
      files: {
        orderBy: {
          path: "asc",
        },
      },
      history: {
        orderBy: { createdAt: "desc" },
        take: 1,
      },
    },
  })

  if (!project) {
    return {
      error: NextResponse.json({ error: "Project not found" }, { status: 404 }),
    }
  }

  return { user, project }
}

async function resolveGenerationModel(selectedModel: string) {
  const modelConfig = await ModelConfigService.getActiveModelByKey(selectedModel)

  if (!modelConfig) {
    return {
      error: NextResponse.json({ error: "Selected model is not available" }, { status: 403 }),
    }
  }

  return { modelConfig, provider: "swift" as const }
}

function buildPromptExecutionContext(input: {
  prompt: string
  promptWithAttachments: string
  promptLanguage: PromptLanguage
  collaborationMode: CollaborationMode
  project: {
    id: string
    name: string
    templateId?: string | null
    memoryJson?: string | null
    history: unknown[]
    files: Array<{ path: string; content: string; language: string | null }>
  }
  previewContextFromClient: ReturnType<typeof normalizePreviewContext>
}): GeneratePromptExecutionContext | NextResponse {
  const existingFiles = toGeneratedFiles(input.project.files || [])
  const promptIntent = applyCollaborationModeToIntent(
    analyzePromptIntent(input.prompt, input.promptLanguage),
    input.collaborationMode,
    input.promptLanguage
  )
  const previewContext =
    input.previewContextFromClient ||
    (promptIntent.mode === "inspect"
      ? buildPreviewContextPacket({
          source: "api",
          projectId: input.project.id,
          projectName: input.project.name,
          templateId: input.project.templateId || null,
          activeTab: "preview",
          viewport: "desktop",
          currentVersion: input.project.history.length || null,
          activeFile: existingFiles[0] || null,
          files: existingFiles,
          previewFiles: existingFiles,
          previewError: null,
          notes: ["Preview context was reconstructed by the API because the client did not send one."],
        })
      : null)
  const activeFileForContext = previewContext?.activeFilePath
    ? existingFiles.find((file) => file.path === previewContext.activeFilePath) || null
    : existingFiles[0] || null
  const aiContext = buildAIContextSnapshot({
    projectId: input.project.id,
    projectName: input.project.name,
    activeFile: activeFileForContext,
    files: existingFiles,
    projectMemory: input.project.memoryJson || null,
    selectedText: null,
    diagnostics: previewContext?.previewError
      ? [
          {
            source: "preview",
            message: previewContext.previewError.message,
            filePath: previewContext.previewError.filename || previewContext.activeFilePath || null,
            line: previewContext.previewError.lineno ?? null,
            column: previewContext.previewError.colno ?? null,
            severity: "error",
            code: null,
          },
        ]
      : [],
    gitDiff: null,
    terminalOutput: null,
  })
  const shouldIncludeAIContext = promptIntent.mode === "inspect" || promptIntent.mode === "build"
  const shouldIncludePreviewContext = promptIntent.mode === "inspect" || promptIntent.mode === "build"
  const promptWithProjectStructure = shouldIncludeAIContext
    ? appendProjectStructureContextToPrompt(input.promptWithAttachments, {
        prompt: input.prompt,
        projectName: input.project.name,
        files: existingFiles,
        activeFile: activeFileForContext,
        promptLanguage: input.promptLanguage,
      })
    : input.promptWithAttachments
  const promptWithAIContext = shouldIncludeAIContext
    ? appendAIContextToPrompt(promptWithProjectStructure, aiContext)
    : promptWithProjectStructure
  let promptWithPreviewContext =
    shouldIncludePreviewContext && previewContext && promptIntent.mode === "inspect"
      ? buildPreviewInspectionPrompt(promptWithAIContext, previewContext)
      : shouldIncludePreviewContext && previewContext
        ? appendPreviewContextToPrompt(promptWithAIContext, previewContext)
        : promptWithAIContext

  if (promptWithPreviewContext.length > MAX_CONTEXTUAL_PROMPT_LENGTH) {
    promptWithPreviewContext = buildCompactContextualPrompt({
      prompt: input.promptWithAttachments,
      projectName: input.project.name,
      activeFile: activeFileForContext,
      files: existingFiles,
      previewError: previewContext?.previewError?.message || null,
      promptLanguage: input.promptLanguage,
    })
  }

  if (promptWithPreviewContext.length > MAX_CONTEXTUAL_PROMPT_LENGTH) {
    return NextResponse.json(
      {
        error: `Prompt exceeds maximum contextual length of ${MAX_CONTEXTUAL_PROMPT_LENGTH} characters after editor context was compacted.`,
        code: "PROMPT_TOO_LONG",
        maxLength: MAX_CONTEXTUAL_PROMPT_LENGTH,
        currentLength: promptWithPreviewContext.length,
      },
      { status: 400 }
    )
  }

  return {
    existingFiles,
    promptIntent,
    promptWithPreviewContext,
  }
}

type GeneratePromptExecutionContext = {
  existingFiles: GeneratedFile[]
  promptIntent: ReturnType<typeof applyCollaborationModeToIntent>
  promptWithPreviewContext: string
}

export async function POST(request: NextRequest) {
  const session = await auth()
  const email = session?.user?.email
  let releaseGeneration: (() => void) | null = null

  if (!email) {
    return NextResponse.json({ error: "Authentication required" }, { status: 401 })
  }

  try {
    const parsedRequest = await parseGenerateRequest(request)
    if (parsedRequest instanceof NextResponse) {
      return parsedRequest
    }

    const {
      prompt,
      selectedModel,
      promptLanguage,
      collaborationMode,
      projectId,
      idempotencyKey,
      previewContextFromClient,
      promptWithAttachments,
    } = parsedRequest

    const subject = await loadGenerationSubject(email, projectId)
    if ("error" in subject) {
      return subject.error
    }

    const { user, project } = subject

    const executionContext = buildPromptExecutionContext({
      prompt,
      promptWithAttachments,
      promptLanguage,
      collaborationMode,
      project,
      previewContextFromClient,
    })
    if (executionContext instanceof NextResponse) {
      return executionContext
    }

    const { existingFiles, promptIntent, promptWithPreviewContext } = executionContext

    await enforceAiUsageRateLimit(user.id)

    const generationModel = await resolveGenerationModel(selectedModel)
    if ("error" in generationModel) {
      return generationModel.error
    }

    const { modelConfig, provider } = generationModel
    const requestPricing = calculateModelRequestPrice({
      modelKey: modelConfig.key,
      modelName: modelConfig.modelName,
      prompt: promptWithPreviewContext,
    })
    const requestCost = requestPricing.estimatedCost

    // Idempotency check: if client provided an idempotencyKey, return previous result
    if (idempotencyKey) {
      const existing = await prisma.generationHistory.findFirst({
        where: {
          projectId,
          idempotencyKey,
        },
      })

      if (existing) {
        try {
          const files = JSON.parse(existing.result) as GeneratedFile[]
          return NextResponse.json({
            message: 'Idempotent response: returning previous generation result',
            files,
            code: files[0]?.content || '',
            historyId: existing.id,
            moduleStatus: buildModuleStatusReport({
              projectName: project.name,
              prompt,
              previewStatus: "success",
            }),
            usage: {
              cost: Number(existing.cost || 0),
              remainingBalance: user.balance,
            },
          })
        } catch (err) {
          // If parsing fails, continue to regenerate
          log('warn', 'Failed to parse existing generation result, regenerating', { historyId: existing.id })
        }
      }
    }

    if (user.balance < requestCost) {
      return NextResponse.json({ error: "Insufficient balance" }, { status: 402 })
    }

    const generationGuard = createGenerationGuard({
      userId: user.id,
      projectId,
      selectedModel: modelConfig.key,
      prompt,
      idempotencyKey,
    })
    if ("error" in generationGuard) {
      return generationGuard.error
    }
    releaseGeneration = generationGuard.release

    const usageLog = await BillingService.reserveBalance(
      user.id,
      modelConfig.id,
      SWIFT_AI_DISPLAY_NAME,
      SWIFT_AI_DISPLAY_NAME,
      promptWithPreviewContext,
      requestCost
    )
    const requestStartedAt = Date.now()
    const estimatedTokens = requestPricing.estimatedTokens
    let providerMessagePreview: string | null = null
    let providerParseMode: string | null = null
    let recoveryRetryUsed = false
    let recoveryRetrySucceeded = false

    let promptEnhancement: Awaited<ReturnType<typeof enhancePromptWithAgentRouter>> | null = null

    try {
      if (promptIntent.mode === "chat" || promptIntent.mode === "inspect") {
        const chatResult = await ProviderRouter.generate({
          provider,
          modelName: modelConfig.modelName,
          prompt: promptIntent.mode === "inspect" ? promptWithPreviewContext : promptWithAttachments,
          mode: promptIntent.mode === "inspect" ? "inspect" : "chat",
          promptLanguage,
        })

        await BillingService.markCompleted(usageLog.id, {
          provider: SWIFT_AI_DISPLAY_NAME,
          model: SWIFT_AI_DISPLAY_NAME,
          errorMessage: null,
        })

        await recordGenerationRequestLog({
          projectId: project.id,
          taskType: promptIntent.mode === "inspect" ? "inspect" : "chat",
          modelConfigId: modelConfig.id,
          modelUsed: SWIFT_AI_DISPLAY_NAME,
          provider: SWIFT_AI_DISPLAY_NAME,
          latencyMs: Date.now() - requestStartedAt,
          tokens: estimatedTokens,
          success: true,
          context: {
            usageLogId: usageLog.id,
            userId: user.id,
            selectedTier: modelConfig.key,
            providerUsed: chatResult.providerUsed,
            providerModelUsed: chatResult.modelUsed,
            creditStatus: "captured",
            collaborationMode,
            promptLength: promptWithAttachments.length,
            contextualPromptLength: promptWithPreviewContext.length,
          },
        })

        return NextResponse.json({
          mode: promptIntent.mode === "inspect" ? "inspect" : "chat",
          message: chatResult.message,
          files: [],
          previewFiles: null,
          code: "",
          usage: {
            model: SWIFT_AI_DISPLAY_NAME,
            provider: SWIFT_AI_DISPLAY_NAME,
            billedModel: SWIFT_AI_DISPLAY_NAME,
            billedProvider: SWIFT_AI_DISPLAY_NAME,
            cost: requestCost,
            remainingBalance: user.balance - requestCost,
          },
        })
      }

      if (promptIntent.needsClarification) {
        const clarificationResult = await ProviderRouter.generate({
          provider,
          modelName: modelConfig.modelName,
          prompt: buildClarifyingPrompt(promptWithAttachments, promptLanguage),
          mode: "chat",
          promptLanguage,
        })

        await BillingService.markCompleted(usageLog.id, {
          provider: SWIFT_AI_DISPLAY_NAME,
          model: SWIFT_AI_DISPLAY_NAME,
          errorMessage: null,
        })

        await recordGenerationRequestLog({
          projectId: project.id,
          taskType: "clarify",
          modelConfigId: modelConfig.id,
          modelUsed: SWIFT_AI_DISPLAY_NAME,
          provider: SWIFT_AI_DISPLAY_NAME,
          latencyMs: Date.now() - requestStartedAt,
          tokens: estimatedTokens,
          success: true,
          context: {
            usageLogId: usageLog.id,
            userId: user.id,
            selectedTier: modelConfig.key,
            providerUsed: clarificationResult.providerUsed,
            providerModelUsed: clarificationResult.modelUsed,
            creditStatus: "captured",
            collaborationMode,
            promptLength: promptWithAttachments.length,
            contextualPromptLength: promptWithPreviewContext.length,
          },
        })

        return NextResponse.json({
          mode: "clarify",
          needsClarification: true,
          message: clarificationResult.message,
          files: [],
          previewFiles: null,
          code: "",
          usage: {
            model: SWIFT_AI_DISPLAY_NAME,
            provider: SWIFT_AI_DISPLAY_NAME,
            billedModel: SWIFT_AI_DISPLAY_NAME,
            billedProvider: SWIFT_AI_DISPLAY_NAME,
            cost: requestCost,
            remainingBalance: user.balance - requestCost,
          },
        })
      }

      const promptMode = inferPromptMode(prompt)

      promptEnhancement = await enhancePromptWithAgentRouter({
        prompt: promptWithAttachments,
        modelName: modelConfig.modelName,
      })
      const providerExecutionContext = buildProviderExecutionContext({
        promptWithAttachments,
        promptWithPreviewContext,
        promptLanguage,
        collaborationMode,
        promptIntent,
      })
      const projectMemoryJson = mergeProjectMemoryJson(
        promptMode === "rebuild" ? null : project.memoryJson || null,
        promptEnhancement.projectMemory
      )

      const previewErrorLogs = formatPreviewErrorLogs(previewContextFromClient)
      const finalPromptMode = inferFinalPromptMode({
        collaborationMode,
        prompt,
        errorLogs: previewErrorLogs,
        existingFileCount: existingFiles.length,
      })
      const basePrompt = promptEnhancement.prompt
      const effectivePrompt =
        existingFiles.length > 0
          ? buildContinuationPrompt({
              latestUserPrompt: prompt,
              basePrompt,
              existingFiles,
            })
          : basePrompt
      const fullStackPrompt = compactProviderPrompt(
        buildFinalPrompt({
          mode: finalPromptMode,
          userPrompt: enforceFullStackRequirement(effectivePrompt),
          executionContext: providerExecutionContext,
          errorLogs: previewErrorLogs,
        })
      )

      // Use orchestrator which checks idempotency and delegates to ProviderRouter
      const orchestration = await orchestrateGeneration({
        projectId: project.id,
        prompt: fullStackPrompt,
        provider,
        modelName: modelConfig.modelName,
        idempotencyKey,
      })

      if (orchestration.alreadyExists) {
        await BillingService.refundReservation(
          usageLog.id,
          user.id,
          requestCost,
          "Idempotent request reused existing generation."
        )

        await recordGenerationRequestLog({
          projectId: project.id,
          taskType: "idempotent-build",
          modelConfigId: modelConfig.id,
          modelUsed: SWIFT_AI_DISPLAY_NAME,
          provider: SWIFT_AI_DISPLAY_NAME,
          latencyMs: Date.now() - requestStartedAt,
          tokens: estimatedTokens,
          success: true,
          context: {
            usageLogId: usageLog.id,
            userId: user.id,
            selectedTier: modelConfig.key,
            creditStatus: "refunded",
            idempotencyKey,
            collaborationMode,
            reusedHistoryId: orchestration.historyId,
          },
        })

        return NextResponse.json({
          message: 'Idempotent response: returning previous generation result',
          files: orchestration.files,
          code: orchestration.files?.[0]?.content || '',
          historyId: orchestration.historyId,
          moduleStatus: buildModuleStatusReport({
            projectName: project.name,
            prompt,
            previewStatus: "success",
          }),
          usage: {
            cost: 0,
            remainingBalance: user.balance,
          },
          refunded: true,
        })
      }

      let result = orchestration.providerResult
      let providerParsed = extractGeneratedFilesFromProviderMessage(result.message)

      if (providerParsed.files.length === 0) {
        recoveryRetryUsed = true
        log("warn", "Parser failed to detect files, running aggressive recovery retry", {
          projectId: project.id,
          selectedModel: modelConfig.key,
          providerUsed: result.providerUsed,
          modelUsed: result.modelUsed,
        })

        const recoveryResult = await ProviderRouter.generate({
          provider,
          modelName: modelConfig.modelName,
          prompt: buildRecoveryRetryPrompt(prompt, fullStackPrompt),
          mode: "files",
          promptLanguage,
          temperatureOverride: 0,
        })

        const recoveredFiles = extractGeneratedFilesFromProviderMessage(recoveryResult.message)
        if (recoveredFiles.files.length > 0) {
          result = recoveryResult
          providerParsed = recoveredFiles
          recoveryRetrySucceeded = true
        }
      }

      providerMessagePreview = result.message.slice(0, 1200)
      providerParseMode = providerParsed.parseMode
      const scaffold = buildProjectFiles({
        prompt: fullStackPrompt,
        originalPrompt: promptWithAttachments,
        projectName: project.name,
        providerMessage: result.message,
        promptSummary: promptEnhancement.summary,
      })

      let generatedFiles: GeneratedFile[] = []
      let providerAssemblyMessage = ""
      const providerUpdatedEntry = hasPrimaryEntryUpdate(providerParsed.files)
      const shouldRebaseFromScaffold =
        existingFiles.length > 0 &&
        promptMode === "rebuild" &&
        (!providerUpdatedEntry || providerParsed.files.length <= 3)

      if (providerParsed.files.length > 0) {
        if (existingFiles.length > 0) {
          const mergeBase =
            promptMode === "rebuild"
              ? shouldRebaseFromScaffold
                ? scaffold.files
                : []
              : existingFiles
          generatedFiles = mergeGeneratedFiles(mergeBase, providerParsed.files)
          providerAssemblyMessage = shouldRebaseFromScaffold
            ? `Provider menghasilkan ${providerParsed.files.length} file valid (${providerParsed.parseMode}). Karena prompt terdeteksi sebagai rebuild namun update halaman utama minim, sistem melakukan rebase dari scaffold terbaru lalu menerapkan output provider menjadi ${generatedFiles.length} file.`
            : promptMode === "rebuild"
              ? `Provider menghasilkan ${providerParsed.files.length} file valid (${providerParsed.parseMode}). Karena prompt terdeteksi sebagai rebuild, sistem mengganti arah project lama dan menerapkan output provider menjadi ${generatedFiles.length} file.`
            : `Provider menghasilkan ${providerParsed.files.length} file valid (${providerParsed.parseMode}) dan sistem menggabungkannya ke project existing (${existingFiles.length} file) menjadi ${generatedFiles.length} file.`
        } else {
          generatedFiles = providerParsed.files
          providerAssemblyMessage = `Provider menghasilkan ${providerParsed.files.length} file valid (${providerParsed.parseMode}) dan sistem menerapkannya sebagai file project baru.`
        }
      } else if (existingFiles.length > 0) {
        throw new Error("AI_OUTPUT_HAS_NO_FILES")
      } else {
        throw new Error("AI_OUTPUT_HAS_NO_FILES")
      }

      const validationBeforeRepair = validateFullStackFiles(generatedFiles)
      const repairResult = autoRepairFullStackFiles(generatedFiles, scaffold.files)
      generatedFiles = repairResult.files

      const validationAfterRepair = validateFullStackFiles(generatedFiles)
      const repairedCategoryText =
        repairResult.missingBeforeRepair.length > 0
          ? repairResult.missingBeforeRepair.join(", ")
          : ""

      if (repairResult.repaired) {
        providerAssemblyMessage += `\n\nAuto-repair full-stack diterapkan: kategori [${repairedCategoryText}] dilengkapi dengan ${repairResult.addedFiles.length} file fallback.`
      } else if (validationBeforeRepair.missingCategories.length > 0) {
        providerAssemblyMessage += `\n\nValidasi full-stack mendeteksi kekurangan [${repairedCategoryText}], namun tidak ada fallback file tambahan yang bisa diterapkan otomatis.`
      }

      if (validationAfterRepair.missingCategories.length > 0) {
        throw new StrictFullStackValidationError({
          missingBeforeRepair: validationBeforeRepair.missingCategories,
          missingAfterRepair: validationAfterRepair.missingCategories,
          addedFiles: repairResult.addedFiles.map((file) => file.path),
          parseMode: providerParsed.parseMode,
          providerFileCount: providerParsed.files.length,
          finalFileCount: generatedFiles.length,
        })
      }

      const relevanceReport = evaluateOutputRelevance(prompt, generatedFiles)
      if (shouldFailRelevanceGate(relevanceReport, providerParsed.files.length, promptMode === "rebuild" ? 0 : existingFiles.length)) {
        throw new RelevanceValidationError(relevanceReport)
      }

      log("info", "Generation output assembled", {
        projectId: project.id,
        selectedModel: modelConfig.key,
        providerUsed: result.providerUsed,
        providerModelUsed: result.modelUsed,
        existingFileCount: existingFiles.length,
        parseMode: providerParsed.parseMode,
        providerFileCount: providerParsed.files.length,
        missingBeforeRepair: validationBeforeRepair.missingCategories,
        missingAfterRepair: validationAfterRepair.missingCategories,
        autoRepairAddedFiles: repairResult.addedFiles.map((file) => file.path),
        shouldRebaseFromScaffold,
        providerUpdatedEntry,
        promptMode,
        relevanceScore: relevanceReport.score,
        relevanceMatchedTerms: relevanceReport.matchedTerms,
        relevanceMissingTerms: relevanceReport.missingTerms,
        finalFileCount: generatedFiles.length,
      })

      const sourceList = promptEnhancement.sourcesUsed
        .map((source) => source.split("@")[0])
        .join(" + ")
      const baseResponseMessage = promptEnhancement.usedEnhancement
        ? `${providerAssemblyMessage}\n\nPrompt user sudah diperjelas lebih dulu dengan ${sourceList}. Ringkasan brief: ${promptEnhancement.summary}`
        : providerAssemblyMessage
      const fallbackNote = result.usedFallback
        ? `\n\nCatatan: layanan utama ${SWIFT_AI_DISPLAY_NAME} sempat gagal merespons, jadi request otomatis dialihkan ke jalur cadangan ${SWIFT_AI_DISPLAY_NAME}.`
        : ""
      const responseMessage = `${baseResponseMessage}${fallbackNote}`

      // Create a preview-safe copy of files: replace frontend files that contain
      // async/top-level await or Promise usage with a lightweight preview fallback
      // so the in-browser sandbox preview won't try to render server-only code.
      const previewFiles = sanitizeFilesForPreview(generatedFiles)

      const savedGeneration = await ProjectFilePersistenceService.saveGenerationSnapshot(project.id, promptWithPreviewContext, generatedFiles, {
        idempotencyKey,
        cost: requestCost,
        projectMemoryJson,
      })
      const historyId = savedGeneration.historyId
      generatedFiles = savedGeneration.files

      await BillingService.markCompleted(usageLog.id, {
        provider: SWIFT_AI_DISPLAY_NAME,
        model: SWIFT_AI_DISPLAY_NAME,
        errorMessage: result.usedFallback && result.primaryError
          ? `Primary provider failed: ${result.primaryError}`
          : null,
      })

      await recordGenerationRequestLog({
        projectId: project.id,
        taskType: "build",
        modelConfigId: modelConfig.id,
        modelUsed: SWIFT_AI_DISPLAY_NAME,
        provider: SWIFT_AI_DISPLAY_NAME,
        latencyMs: Date.now() - requestStartedAt,
        tokens: estimatedTokens,
        success: true,
        context: {
          usageLogId: usageLog.id,
          userId: user.id,
          selectedTier: modelConfig.key,
          providerUsed: result.providerUsed,
          providerModelUsed: result.modelUsed,
          creditStatus: "captured",
          historyId,
          collaborationMode,
          idempotencyKey,
          usedFallback: result.usedFallback,
          promptLength: promptWithAttachments.length,
          contextualPromptLength: promptWithPreviewContext.length,
          finalFileCount: generatedFiles.length,
          providerFileCount: providerParsed.files.length,
          fileDiff: savedGeneration.fileDiff,
          parseMode: providerParsed.parseMode,
          relevanceScore: relevanceReport.score,
          recoveryRetryUsed,
          recoveryRetrySucceeded,
          finalPromptMode,
        },
      })

      return NextResponse.json({
        mode: "build",
        message: responseMessage,
        files: generatedFiles,
        previewFiles,
        plan: promptEnhancement.plan,
        moduleStatus: scaffold.moduleStatus,
        fileDiff: savedGeneration.fileDiff,
        code: generatedFiles[0]?.content || "",
        historyId,
        usage: {
          model: SWIFT_AI_DISPLAY_NAME,
          provider: SWIFT_AI_DISPLAY_NAME,
          billedModel: SWIFT_AI_DISPLAY_NAME,
          billedProvider: SWIFT_AI_DISPLAY_NAME,
          cost: requestCost,
          remainingBalance: user.balance - requestCost,
        },
      })
    } catch (error) {
      const isStrictFullStackError = error instanceof StrictFullStackValidationError
      const isRelevanceError = error instanceof RelevanceValidationError
      const errorMessage = error instanceof Error ? error.message : "AI request failed"
      const providerFailure = error instanceof SwiftProviderFailureError ? error : null
      const lastFailedAttempt = providerFailure
        ? [...providerFailure.attempts].reverse().find((attempt) => attempt.status === "failed")
        : null
      const moduleStatus = buildModuleStatusReport({
        projectName: project.name,
        prompt: promptWithPreviewContext,
        previewStatus: "error",
        errorMessage,
      })
      const preservedFiles = existingFiles
      const friendlyMessage = isStrictFullStackError
        ? buildStrictFailSafeMessage((error as StrictFullStackValidationError).details)
        : isRelevanceError
          ? buildRelevanceFailSafeMessage((error as RelevanceValidationError).details)
        : providerFailure
          ? providerFailure.userMessage
        : getFriendlyProviderErrorMessage(errorMessage)

      await BillingService.refundReservation(
        usageLog.id,
        user.id,
        requestCost,
        errorMessage
      )

      await recordGenerationRequestLog({
        projectId: project.id,
        taskType: promptIntent.mode === "chat" || promptIntent.mode === "inspect" ? promptIntent.mode : "build",
        modelConfigId: modelConfig.id,
        modelUsed: SWIFT_AI_DISPLAY_NAME,
        provider: SWIFT_AI_DISPLAY_NAME,
        latencyMs: Date.now() - requestStartedAt,
        tokens: estimatedTokens,
        success: false,
        errorMessage,
        context: {
          usageLogId: usageLog.id,
          userId: user.id,
          selectedTier: modelConfig.key,
          providerUsed: lastFailedAttempt?.provider || null,
          failureReason: lastFailedAttempt?.failureReason || null,
          creditStatus: "refunded",
          collaborationMode,
          idempotencyKey,
          refunded: true,
          failSafe: isStrictFullStackError
            ? "strict-fullstack"
            : isRelevanceError
              ? "relevance"
              : null,
          promptLength: promptWithAttachments.length,
          contextualPromptLength: promptWithPreviewContext.length,
          preservedFileCount: preservedFiles.length,
          providerParseMode,
          providerMessagePreview,
          recoveryRetryUsed,
          recoveryRetrySucceeded,
        },
      })

      return NextResponse.json({
        mode: "build",
        message:
          existingFiles.length > 0
            ? `${friendlyMessage}\n\nPerubahan belum diterapkan. File project terakhir dipertahankan supaya kamu bisa lanjut dari versi sebelumnya.`
            : friendlyMessage,
        files: preservedFiles,
        previewFiles: null,
        plan: promptEnhancement?.plan ?? null,
        moduleStatus,
        code: "",
        historyId: null,
        preserveFiles: true,
        usage: {
          model: SWIFT_AI_DISPLAY_NAME,
          provider: SWIFT_AI_DISPLAY_NAME,
          cost: 0,
          remainingBalance: user.balance,
        },
        refunded: true,
        warning: friendlyMessage,
        ...(isStrictFullStackError
          ? {
              failSafe: {
                type: "strict-fullstack",
                details: (error as StrictFullStackValidationError).details,
              },
              failSafeCode: "STRICT_FULLSTACK_FAILSAFE",
            }
          : isRelevanceError
            ? {
                failSafe: {
                  type: "relevance",
                  details: (error as RelevanceValidationError).details,
                },
                failSafeCode: "RELEVANCE_FAILSAFE",
              }
          : {}),
      })
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to process request"
    const status = message.toLowerCase().includes("rate limit") ? 429 : 500

    return NextResponse.json(
      {
        error: message,
      },
      { status }
    )
  } finally {
    releaseGeneration?.()
  }
}

// Sanitize generated files for browser preview: replace frontend files that
// contain async/server-only constructs with a simple client-safe placeholder.
function sanitizeFilesForPreview(files: GeneratedFile[]): GeneratedFile[] {
  const findPreviewVariant = (path: string) => {
    const candidates = [
      path.replace(/(\.[^/.]+)$/, ".preview$1"),
      `preview/${path}`,
      path.replace(/^app\//, "preview/app/"),
    ]

    for (const candidate of candidates) {
      const found = files.find((item) => item.path === candidate)
      if (found) return found
    }

    return null
  }

  return files.map((file) => {
    try {
      const previewVariant = findPreviewVariant(file.path)
      const sourceContent = String(previewVariant?.content ?? file.content ?? "")

      if (isPreviewJsonFile(file.path)) {
        return {
          ...file,
          content: buildPreviewJsonModule(sourceContent),
        }
      }

      if (isPreviewAssetFile(file.path)) {
        return {
          ...file,
          content: buildPreviewAssetModule(),
        }
      }

      if (!isPreviewExecutableFile(file.path)) {
        return file
      }

      const candidates = buildPreviewExecutableCandidates(sourceContent, file.path)

      for (const candidate of candidates) {
        const diagnostics = getPreviewSyntaxDiagnostics(candidate, file.path)
        if (diagnostics.length === 0) {
          return {
            ...file,
            content: candidate,
          }
        }
      }

      const diagnostics = getPreviewSyntaxDiagnostics(candidates[0] ?? sourceContent, file.path)
      const detail = diagnostics.length > 0
        ? diagnostics.slice(0, 2).map(formatPreviewDiagnostic).join(" | ")
        : `Unable to normalize preview file ${file.path}`

      return {
        ...file,
        content: buildPreviewFallbackModule(file.path, detail),
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : `Unable to normalize preview file ${file.path}`
      return {
        ...file,
        content: buildPreviewFallbackModule(file.path, detail),
      }
    }
  })
}

// Heuristic repairs for common malformed object/array entries produced by
// model generations: e.g. "value,481" -> "value: \"481\"", or
// "trend,+8.1%" -> "trend: \"+8.1%\"". These are conservative
// regex-based fixes applied as a best-effort before falling back to the
// preview placeholder.
function repairCommonObjectLiteralMistakes(input: string) {
  let out = String(input)

  // Focused key-based fixes first (common stat keys)
  const keys = ['value', 'trend', 'label', 'title', 'orders', 'revenue', 'count', 'amount', 'total', 'percent', 'change']
  const keyPattern = keys.join('|')

  // key, "string"  -> key: "string"
  out = out.replace(new RegExp(`\\b(${keyPattern})\\s*,\\s*["']([^"']+)["']`, 'gi'), '$1: "$2"')

  // key, 2,481  -> key: "2,481"
  out = out.replace(new RegExp(`\\b(${keyPattern})\\s*,\\s*([+\\-]?\\d{1,3}(?:,\\d{3})*(?:\\.\\d+)?%?)`, 'gi'), '$1: "$2"')

  // Generic quoted string fix: id, 'str' -> id: "str"
  out = out.replace(/(\b[A-Za-z_$][\w$]*)\s*,\s*'([^']*)'/g, '$1: "$2"')
  out = out.replace(/(\b[A-Za-z_$][\w$]*)\s*,\s*"([^"]*)"/g, '$1: "$2"')

  // Generic numeric fix for identifier,number -> id: "number"
  out = out.replace(/(\b[A-Za-z_$][\w$]*)\s*,\s*([+\-]?\d{1,3}(?:,\d{3})*(?:\.\d+)?%?)/g, '$1: "$2"')

  // Tidy up obvious stray patterns like value,481' (missing quote closing)
  out = out.replace(new RegExp(`\\b(${keyPattern})\\s*,\\s*([0-9,]+)'`, 'gi'), '$1: "$2"')

  return out
}

function repairCommonJsxAttributeStrings(input: string) {
  let out = String(input)

  out = out.replace(
    /([A-Za-z_$][\w:-]*)=\{\s*'([\s\S]*?\$\{[\s\S]*?\}[\s\S]*?)'\s*\}/g,
    (_full, attributeName: string, attributeValue: string) => {
      const normalizedValue = attributeValue.replace(/\\\$\{/g, "${")
      return `${attributeName}={\`${normalizedValue}\`}`
    }
  )

  return out
}

// Replace inline array data blocks that are clearly malformed with a safe
// preview-friendly version. For example, if a model generated a `const stats = [ ... ]`
// block with broken punctuation, this will extract any `label` values and
// produce a sanitized array of objects: [{ label: "...", value: "0", trend: "0%" }, ...]
function sanitizeInlineArrays(input: string) {
  const src = String(input)
  let out = src

  const numericKeys = ['value', 'orders', 'revenue', 'count', 'amount', 'total']
  const percentKeys = ['trend', 'percent', 'change']
  const textKeys = ['label', 'title', 'name', 'subtitle', 'description', 'text', 'time']
  const keyPattern = [...numericKeys, ...percentKeys, ...textKeys].join('|')

  // Key-based fixes first (common stat keys)
  out = out.replace(new RegExp(`\\b(${numericKeys.join('|')})\\s*,\\s*([+\\-]?\\d{1,3}(?:,\\d{3})*(?:\\.\\d+)?%?)["']?`, 'gi'), '$1: "$2"')
  out = out.replace(new RegExp(`\\b(${percentKeys.join('|')})\\s*,\\s*([+\\-]?\\d{1,3}(?:,\\d{3})*(?:\\.\\d+)?%?)["']?`, 'gi'), '$1: "$2"')

  // Fill in obviously missing values for common keys
  out = out.replace(new RegExp(`\\b(${numericKeys.join('|')})\\s*,(?=\\s*[,}\\]])`, 'gi'), '$1: "0"')
  out = out.replace(new RegExp(`\\b(${percentKeys.join('|')})\\s*,(?=\\s*[,}\\]])`, 'gi'), '$1: "0%"')
  out = out.replace(new RegExp(`\\b(${textKeys.join('|')})\\s*,(?=\\s*[,}\\]])`, 'gi'), '$1: ""')

  return out
}

function isPreviewExecutableFile(path: string) {
  return PREVIEW_EXECUTABLE_FILE_PATTERN.test(path)
}

function isPreviewJsonFile(path: string) {
  return PREVIEW_JSON_FILE_PATTERN.test(path)
}

function isPreviewAssetFile(path: string) {
  return PREVIEW_ASSET_FILE_PATTERN.test(path)
}

function buildPreviewJsonModule(content: string) {
  try {
    const parsed = JSON.parse(String(content || ""))
    return `const __default_export = ${JSON.stringify(parsed, null, 2)}\n`
  } catch (error) {
    return `const __default_export = {}\n`
  }
}

function buildPreviewAssetModule() {
  return `const __default_export = {}\n`
}

function getPreviewSyntaxDiagnostics(content: string, filePath: string) {
  const result = ts.transpileModule(String(content || ""), {
    compilerOptions: {
      allowJs: true,
      allowSyntheticDefaultImports: true,
      esModuleInterop: true,
      jsx: ts.JsxEmit.ReactJSX,
      module: ts.ModuleKind.ESNext,
      skipLibCheck: true,
      target: ts.ScriptTarget.ES2020,
    },
    fileName: filePath,
    reportDiagnostics: true,
  })

  return (result.diagnostics || []).filter((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error)
}

function formatPreviewDiagnostic(diagnostic: ts.Diagnostic) {
  const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, " ")

  if (!diagnostic.file || typeof diagnostic.start !== "number") {
    return message
  }

  const position = diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start)
  return `${diagnostic.file.fileName}:${position.line + 1}:${position.character + 1} ${message}`
}

function hasClientSafeRewriteMarkers(content: string) {
  return (
    /\bawait\b|export\s+default\s+async|async\s+function|new\s+Promise\b|Promise\.|\btop-level-await\b|\bimport\(/i.test(content) ||
    /next\/headers|next\/cookies|@\/lib\/db|@prisma\/client|prisma|node:fs|node:path|fs\b|path\b|process\.env/i.test(content)
  )
}

function buildPreviewFallbackModule(filePath: string, detail: string) {
  return `export default function PreviewFallback() {\n  return (\n    <div className="flex min-h-[240px] items-center justify-center rounded-xl border border-dashed border-border bg-background p-6 text-center">\n      <div className="max-w-xl space-y-2">\n        <h2 className="text-base font-semibold text-foreground">Preview disabled for ${JSON.stringify(filePath)}</h2>\n        <p className="text-sm text-muted-foreground">${JSON.stringify(detail)}</p>\n      </div>\n    </div>\n  )\n}\n`
}

function buildPreviewExecutableCandidates(content: string, filePath: string) {
  const original = String(content || "")
  const candidates = new Set<string>()

  const addCandidate = (value: string) => {
    const normalized = String(value || "")
    if (!normalized) return
    candidates.add(normalized)
  }

  const jsxRepaired = repairCommonJsxAttributeStrings(original)
  const repaired = repairCommonObjectLiteralMistakes(jsxRepaired)
  const arraySanitized = sanitizeInlineArrays(jsxRepaired)
  const repairedArraySanitized = repairCommonObjectLiteralMistakes(arraySanitized)
  const arrayRepaired = sanitizeInlineArrays(repaired)
  const clientSafe = hasClientSafeRewriteMarkers(jsxRepaired) ? makeClientSafeContent(jsxRepaired) : ""
  const clientSafeRepaired = clientSafe ? repairCommonObjectLiteralMistakes(clientSafe) : ""
  const clientSafeArraySanitized = clientSafe ? sanitizeInlineArrays(clientSafe) : ""
  const clientSafeArrayRepaired = clientSafeArraySanitized ? repairCommonObjectLiteralMistakes(clientSafeArraySanitized) : ""

  if (clientSafe) {
    addCandidate(clientSafe)
    addCandidate(clientSafeRepaired)
    addCandidate(clientSafeArraySanitized)
    addCandidate(clientSafeArrayRepaired)
  }

  addCandidate(original)
  addCandidate(repaired)
  addCandidate(arraySanitized)
  addCandidate(repairedArraySanitized)
  addCandidate(arrayRepaired)

  return [...candidates]
}

function makeClientSafeContent(content: string) {
  let s = repairCommonJsxAttributeStrings(String(content))
  const previewMockObject = `({
    id: "preview",
    name: "Preview item",
    title: "Preview item",
    slug: "preview-item",
    description: "Preview data generated for browser sandbox.",
    content: "Preview data",
    image: "/placeholder.svg",
    price: 0,
    amount: 0,
    value: 0,
    trend: "0%",
    features: [],
    items: [],
    ingredients: [],
    reviews: [],
    testimonials: [],
    gallery: [],
    beforeAfter: [],
    cta: { label: "Preview CTA", href: "#" },
  })`

  if (!/['"]use client['"]/.test(s)) {
    s = '"use client"\n\n' + s
  }

  try {
    const fetchGlob = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*await\s+fetch\(\s*([^)]*)\s*\)\s*;?/g
    let match: RegExpExecArray | null
    const replacements: Array<{ orig: string; name: string; args: string }> = []

    while ((match = fetchGlob.exec(s)) !== null) {
      replacements.push({ orig: match[0], name: match[1], args: match[2] })
    }

    for (const replacement of replacements) {
      const name = replacement.name
      const args = replacement.args
      const stateName = `__sw_preview_${name}`
      const setter = `set${name.charAt(0).toUpperCase()}${name.slice(1)}`
      const hookSnippet = `const [${stateName}, ${setter}] = React.useState(null);\nReact.useEffect(()=>{let mounted=true;(async ()=>{try{const __sw_res = await fetch(${args});const __sw_json = await __sw_res.json();if(mounted)${setter}(__sw_json);}catch(e){} })();return ()=>{mounted=false};},[]);\n`

      s = s.replace(replacement.orig, hookSnippet)

      try {
        const jsonAssignRegex = new RegExp('(?:const|let|var)\\s+([A-Za-z_$][\\w$]*)\\s*=\\s*await\\s+' + name + '\\.(?:json|text|blob)\\(\\)\\s*;?', 'g')
        let jsonMatch: RegExpExecArray | null
        const jsonVars: string[] = []

        while ((jsonMatch = jsonAssignRegex.exec(s)) !== null) {
          jsonVars.push(jsonMatch[1])
        }

        for (const jsonVar of jsonVars) {
          s = s.replace(new RegExp('(?:const|let|var)\\s+' + jsonVar + '\\s*=\\s*await\\s+' + name + '\\.(?:json|text|blob)\\(\\)\\s*;?\\s*', 'g'), '')
          s = s.replace(new RegExp('\\b' + jsonVar + '\\b', 'g'), stateName)
        }
      } catch (error) {
        // best-effort only
      }

      s = s.replace(new RegExp('\\b' + name + '\\b', 'g'), stateName)
    }
  } catch (error) {
    // best-effort only
  }

  s = s.replace(/import\s+[\s\S]*?from\s+['"][^'"]*fs[^'"]*['"];?\s*/gi, '')
  s = s.replace(/import\s+[\s\S]*?from\s+['"][^'"]*path[^'"]*['"];?\s*/gi, '')
  s = s.replace(/import\s+[\s\S]*?from\s+['"][^'"]*prisma[^'"]*['"];?\s*/gi, '')
  s = s.replace(/import\s+[\s\S]*?from\s+['"][^'"]*@prisma\/client[^'"]*['"];?\s*/gi, '')
  s = s.replace(/import\s+[\s\S]*?from\s+['"][^'"]*node:fs[^'"]*['"];?\s*/gi, '')
  s = s.replace(/import\s+[\s\S]*?from\s+['"][^'"]*node:path[^'"]*['"];?\s*/gi, '')
  s = s.replace(/import\s+[\s\S]*?from\s+['"][^'"]*next\/headers[^'"]*['"];?\s*/gi, '')
  s = s.replace(/import\s+[\s\S]*?from\s+['"][^'"]*next\/cookies[^'"]*['"];?\s*/gi, '')
  s = s.replace(/import\s+[\s\S]*?from\s+['"][^'"]*@\/lib\/db[^'"]*['"];?\s*/gi, '')

  s = s.replace(
    /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*await\s+prisma\.[A-Za-z0-9_$]+\.(findFirst|findUnique|findMany|count|aggregate)\([\s\S]*?\)\s*;?/g,
    (_full, bindingName: string, method: string) => {
      if (method === "findMany") {
        return `const ${bindingName} = [];`
      }

      if (method === "count") {
        return `const ${bindingName} = 0;`
      }

      return `const ${bindingName} = ${previewMockObject};`
    }
  )

  s = s.replace(/export\s+async\s+function\s+(getServerSideProps|getStaticProps|getInitialProps|generateStaticParams|generateMetadata)\s*\([\s\S]*?\)\s*\{[\s\S]*?\}\s*/gi, '')
  s = s.replace(/export\s+const\s+(dynamic|revalidate|runtime)\s*=\s*[^;\n]+;?\s*/gi, '')
  s = s.replace(/export\s+default\s+async\s+function/gi, 'export default function')
  s = s.replace(/export\s+default\s+async\s*\(/gi, 'export default (')
  s = s.replace(/\basync\s+(function\s+[A-Za-z0-9_$]+\s*\()/gi, '$1')
  s = s.replace(/\bawait\s+(\([^\)\n]+\)|[^\s;\n]+)/g, 'null')
  s = s.replace(/new\s+Promise\s*\([\s\S]*?\)/g, 'null')
  s = s.replace(/Promise\.[A-Za-z0-9_$]+\s*\(/g, '/*Promise*/ (function(){return Promise})(')
  s = s.replace(/\bprocess\.env\.[A-Za-z0-9_]+/g, 'undefined')

  try {
    s = sanitizeInlineArrays(s)
    s = repairCommonObjectLiteralMistakes(s)
  } catch (error) {
    // best-effort only
  }

  return s
}

function normalizeAttachments(attachments: PromptAttachment[] | undefined): PromptAttachment[] {
  if (!Array.isArray(attachments) || attachments.length === 0) {
    return []
  }

  const cleaned = attachments.slice(0, MAX_ATTACHMENTS).map((attachment) => ({
    ...attachment,
    name: attachment.name.trim().slice(0, 180),
    mimeType: (attachment.mimeType || "application/octet-stream").trim().slice(0, 120),
    content: attachment.content || "",
  }))

  for (const attachment of cleaned) {
    if (attachment.size > MAX_ATTACHMENT_SIZE_BYTES) {
      throw new Error(`Attachment "${attachment.name}" exceeds ${Math.floor(MAX_ATTACHMENT_SIZE_BYTES / (1024 * 1024))}MB limit.`)
    }

    if (attachment.kind === "image" && !attachment.content.startsWith("data:")) {
      throw new Error(`Attachment "${attachment.name}" has invalid image payload.`)
    }
  }

  return cleaned
}

function appendAttachmentsToPrompt(prompt: string, attachments: PromptAttachment[], modelName?: string) {
  if (attachments.length === 0) {
    return prompt
  }

  const modelSupportsVision = modelName ? isVisionCapableModel(modelName) : false

  let usedChars = 0
  const lines = attachments
    .map((attachment, index) => {
      if (usedChars >= MAX_ATTACHMENT_CONTEXT_CHARS) {
        return ""
      }

      const header = `Attachment ${index + 1}: ${attachment.name} (${attachment.mimeType}, ${attachment.size} bytes)`

      if (attachment.kind === "image") {
        if (!modelSupportsVision) {
          return `${header}\nKind: image\nNote: Image content was attached but the selected model does not support image input. Please infer or describe the image based on the filename "${attachment.name}".`
        }
        const preview = attachment.content.slice(0, 1400)
        usedChars += preview.length
        return `${header}\nKind: image\nDataURL preview:\n${preview}`
      }

      const textBody = truncateText(attachment.content, 5000)
      usedChars += textBody.length
      return `${header}\nKind: ${attachment.kind}\nContent:\n${textBody}`
    })
    .filter(Boolean)
    .join("\n\n")

  if (!lines) {
    return prompt
  }

  return `${prompt}\n\nAdditional user attachments (treat these as source context):\n${lines}`
}

function enforceFullStackRequirement(prompt: string) {
  return [
    prompt,
    "Core role: You are the core builder engine for this AI website platform.",
    "Convert short prompts into complete, premium, deployable web apps. Infer missing details with best-practice defaults.",
    "Auto-detect product intent and apply matching defaults: laundry = service order app with pickup form, admin order table, status tracking, and package pricing; dashboard = SaaS admin dashboard; ecommerce = online store with cart + checkout; landing page = marketing page; portfolio = personal brand site; booking = reservation system; crm = internal business tool.",
    "Domain priority: specific business domains such as laundry, clinic, restaurant, salon, rental, trading, ecommerce, or booking override generic words like dashboard, admin, table, content, and management. If the prompt says laundry with admin dashboard, build a laundry operations app, not a generic dashboard or content/news page.",
    "For trading, forex, crypto, saham, mata uang, exchange, or currency prompts: generate a financial trading dashboard with watchlist, price cards, chart/candlestick area, order ticket, open positions, portfolio balance, risk summary, and market/news widgets. Do not replace it with a generic content page, marketplace, or app-builder workspace.",
    "Never generate generic content/news preview copy such as Konten, Topik Populer, Headline, Populer, Rekomendasi, or Update unless the user explicitly asks for a blog, news, magazine, or content portal.",
    "Hard requirement: Generate FULL-STACK Next.js app output, not frontend-only.",
    "Always include meaningful frontend UI + backend API route(s) + data model/service layer when applicable.",
    "Default stack: Next.js + TypeScript + Tailwind + shadcn/ui (unless user explicitly asks otherwise).",
    "When creating/editing/deleting files, keep imports coherent across related files. If you add a package import, also update package.json dependencies.",
    "If the app needs Prisma, include prisma/schema.prisma, a singleton Prisma client module, and CRUD API routes that use the schema.",
    "For SQLite/Turso writes, avoid broad updateMany patterns. Prefer targeted writes, retries for SQLITE_BUSY, and short transactions.",
    "Separate generation work from repair work: first produce the requested app, then include only targeted repair files if build/runtime errors are known.",
    "Always include: responsive design, clean navigation, clear CTA, loading states, empty states, and usable mobile layout.",
    "Prioritize usefulness, polish, modern UI quality, conversion-focused UX, and production-ready structure over mockups.",
    "If this prompt is about an existing project, patch the existing files first, preserve working structure, and add new files only when needed.",
    "Keep changes coherent and iterative. Prefer the smallest useful edit set that moves the project forward.",
    "Continuity requirement: treat large products as phased builds. Do not only create empty folders. Each response must implement one visible, working module and preserve the previous project direction.",
    "Preview-first requirement: the preview must show useful information even when some modules are mock, partial, or planned. Include a visible build/status section listing ready modules, partial modules, planned modules, errors if any, and next recommended steps.",
    "If building a marketplace such as BelanjaKu/Shopee, start with buyer storefront + product listing + cart/checkout mock, then plan Seller Center, Admin CMS, search, notifications, moderation, and payment webhook as explicit next modules.",
    "Return ONLY valid JSON object with files array.",
    "IMPORTANT for preview: For any frontend/app files intended to run in the browser preview, do NOT use async React components, top-level await, or server-only APIs. Additionally, include a preview-safe variant for each frontend file under the 'preview/' path (for example 'preview/app/dashboard/page.tsx') or as a sibling file with '.preview' before the extension (e.g., 'app/dashboard/page.preview.tsx'). The preview variant must be a client component (include the 'use client' directive), must avoid server-only imports (fs, server-only libs), must avoid top-level await, and should perform data fetching via client-side patterns (useEffect) or call included API routes. Preview variants should be self-contained and renderable in a plain browser iframe using React UMD + Babel. If providing a preview variant is not possible, include clear instructions in a README file explaining how to make the file previewable.",
  ].join("\n\n")
}

function compactProviderPrompt(prompt: string) {
  const normalized = String(prompt || "").trim()
  if (normalized.length <= MAX_PROVIDER_PROMPT_LENGTH) {
    return normalized
  }

  return [
    compactText(normalized, MAX_PROVIDER_PROMPT_LENGTH),
    "",
    "FINAL_RESPONSE_CONTRACT:",
    'Return ONLY a valid JSON object with shape {"message":"short summary","files":[{"path":"...","language":"tsx|ts|css|json|html|prisma|md|env","content":"complete file content"}]}.',
    "Include only files that are created or modified, with complete file content.",
    "Preserve the latest user request, active editor context, and preview error context from the retained prompt sections.",
  ].join("\n")
}

function inferPromptMode(prompt: string): "rebuild" | "refine" {
  const normalized = prompt.toLowerCase()

  const refineSignals = [
    "fix ",
    "perbaiki",
    "debug",
    "refactor",
    "update ",
    "ubah",
    "edit ",
    "tweak",
    "adjust",
    "rename",
    "ganti",
  ]

  if (refineSignals.some((signal) => normalized.includes(signal))) {
    return "refine"
  }

  return "rebuild"
}

function hasPrimaryEntryUpdate(files: GeneratedFile[]) {
  return files.some((file) => {
    const path = file.path.replace(/\\/g, "/").toLowerCase()
    return (
      path === "app/page.tsx" ||
      path === "app/page.ts" ||
      path === "app/layout.tsx" ||
      /app\/.+\/page\.(tsx|ts)$/i.test(path)
    )
  })
}

function toGeneratedFiles(
  files: Array<{ path: string; content: string; language: string | null }>
): GeneratedFile[] {
  return files.map((file) => ({
    path: normalizePath(file.path),
    content: file.content,
    language: normalizeLanguage(file.language, file.path),
  }))
}

function normalizePath(path: string) {
  return path.replace(/\\/g, "/").replace(/^\.\//, "").trim()
}

function normalizeLanguage(language: string | null | undefined, path: string): GeneratedFile["language"] {
  const normalized = (language || "").toLowerCase().trim()

  if (normalized === "tsx") return "tsx"
  if (normalized === "ts" || normalized === "typescript" || normalized === "javascript" || normalized === "js") return "ts"
  if (normalized === "css") return "css"
  if (normalized === "json") return "json"
  if (normalized === "html") return "html"
  if (normalized === "prisma") return "prisma"
  if (normalized === "md" || normalized === "markdown") return "md"
  if (normalized === "env" || normalized === "dotenv") return "env"

  const lowerPath = path.toLowerCase()
  if (lowerPath.endsWith(".tsx")) return "tsx"
  if (lowerPath.endsWith(".ts")) return "ts"
  if (lowerPath.endsWith(".css")) return "css"
  if (lowerPath.endsWith(".json")) return "json"
  if (lowerPath.endsWith(".html")) return "html"
  if (lowerPath.endsWith(".prisma")) return "prisma"
  if (lowerPath.endsWith(".md")) return "md"
  if (lowerPath.endsWith(".env")) return "env"

  return "ts"
}

function buildContinuationPrompt({
  latestUserPrompt,
  basePrompt,
  existingFiles,
}: {
  latestUserPrompt: string
  basePrompt: string
  existingFiles: GeneratedFile[]
}) {
  const contextFiles = selectContextFiles(existingFiles)
  const fileTree = existingFiles
    .map((file) => `- ${file.path}`)
    .join("\n")

  const snippets = contextFiles
    .map((file) => {
      const content = truncateText(file.content, CONTEXT_FILE_CHAR_LIMIT)
      return `Path: ${file.path}\nLanguage: ${file.language}\n---\n${content}\n---`
    })
    .join("\n\n")

  return [
    `Latest user request:\n${latestUserPrompt}`,
    "Mode: Continue existing project. Do NOT restart from scaffold.",
    "Patch-first rule: edit existing files before adding new ones. Keep the current project structure stable unless a change is necessary.",
    "If a file already solves part of the request, refine that file instead of creating a duplicate version.",
    "When you can, return only the files you actually changed.",
    "Return ONLY valid JSON object using schema {\"message\":\"...\",\"files\":[{\"path\":\"...\",\"language\":\"...\",\"content\":\"...\"}]}.",
    "In files array, include only files you changed or created.",
    `Current project file tree (${existingFiles.length} files):\n${fileTree}`,
    `Current file content snippets (${contextFiles.length} files):\n${snippets}`,
    `Additional planning context:\n${basePrompt}`,
  ].join("\n\n")
}

function selectContextFiles(files: GeneratedFile[]) {
  const priorityRules = [
    /^app\/page\.tsx$/i,
    /^app\/layout\.tsx$/i,
    /^app\/.*\/page\.tsx$/i,
    /^app\/api\/.*\/route\.ts$/i,
    /^components\//i,
    /^lib\//i,
    /^prisma\/schema\.prisma$/i,
    /^app\/globals\.css$/i,
    /^styles\//i,
    /^package\.json$/i,
    /^tsconfig\.json$/i,
  ]

  const sorted = [...files].sort((left, right) => {
    const leftRank = getPathRank(left.path, priorityRules)
    const rightRank = getPathRank(right.path, priorityRules)

    if (leftRank !== rightRank) {
      return leftRank - rightRank
    }

    return left.path.localeCompare(right.path)
  })

  const selected: GeneratedFile[] = []
  let usedChars = 0

  for (const file of sorted) {
    if (selected.length >= CONTEXT_MAX_FILE_COUNT) {
      break
    }

    const estimated = Math.min(file.content.length, CONTEXT_FILE_CHAR_LIMIT)
    if (usedChars + estimated > CONTEXT_TOTAL_CHAR_LIMIT) {
      continue
    }

    selected.push(file)
    usedChars += estimated
  }

  return selected
}

function getPathRank(path: string, rules: RegExp[]) {
  for (let index = 0; index < rules.length; index += 1) {
    if (rules[index].test(path)) {
      return index
    }
  }

  return rules.length + 1
}

function truncateText(value: string, limit: number) {
  if (value.length <= limit) {
    return value
  }

  const headLength = Math.max(1, Math.floor(limit * 0.65))
  const tailLength = Math.max(1, limit - headLength)
  const head = value.slice(0, headLength).trimEnd()
  const tail = value.slice(-tailLength).trimStart()

  return `${head}\n/* ...truncated ${value.length - (headLength + tailLength)} chars for context... */\n${tail}`
}

function buildStrictFailSafeMessage(details: {
  missingBeforeRepair: string[]
  missingAfterRepair: string[]
  addedFiles: string[]
  parseMode: string
  providerFileCount: number
  finalFileCount: number
}) {
  const before = details.missingBeforeRepair.length > 0 ? details.missingBeforeRepair.join(", ") : "none"
  const after = details.missingAfterRepair.length > 0 ? details.missingAfterRepair.join(", ") : "none"
  const added = details.addedFiles.length > 0 ? details.addedFiles.join(", ") : "none"

  return [
    "Strict fail-safe aktif: hasil generate ditahan karena belum memenuhi standar full-stack setelah auto-repair.",
    "",
    "Diagnostik:",
    `- Missing sebelum repair: ${before}`,
    `- Missing setelah repair: ${after}`,
    `- File fallback yang ditambahkan: ${added}`,
    `- Parse mode provider: ${details.parseMode}`,
    `- Jumlah file valid dari provider: ${details.providerFileCount}`,
    `- Jumlah file akhir saat validasi: ${details.finalFileCount}`,
    "",
    "Saldo request ini sudah otomatis direfund. Coba prompt yang lebih spesifik atau ganti model.",
  ].join("\n")
}

function evaluateOutputRelevance(prompt: string, files: GeneratedFile[]): RelevanceReport {
  const promptTerms = extractRelevanceTerms(prompt)
  const searchableOutput = files
    .filter((file) => isRelevanceSearchablePath(file.path))
    .map((file) => `${file.path}\n${file.content}`)
    .join("\n")
    .toLowerCase()
    .slice(0, 60000)

  const matchedTerms = promptTerms.filter((term) => searchableOutput.includes(term))
  const missingTerms = promptTerms.filter((term) => !matchedTerms.includes(term))
  const score = promptTerms.length === 0 ? 1 : matchedTerms.length / promptTerms.length

  return {
    score: Number(score.toFixed(3)),
    totalTerms: promptTerms.length,
    matchedTerms,
    missingTerms,
    promptTerms,
  }
}

function shouldFailRelevanceGate(report: RelevanceReport, providerFileCount: number, existingFileCount: number) {
  if (providerFileCount === 0 || existingFileCount > 0) {
    return false
  }

  if (report.totalTerms < 2) {
    return false
  }

  return report.score < 0.35 && report.matchedTerms.length === 0
}

function extractRelevanceTerms(prompt: string) {
  const normalized = prompt
    .toLowerCase()
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/[^a-z0-9\s-]/g, " ")
    .replace(/\s+/g, " ")
    .trim()

  const phrases = [
    "toko online",
    "company profile",
    "landing page",
    "admin panel",
    "panel admin",
    "booking dokter",
    "janji temu",
    "rekam medis",
    "dry clean",
    "laundry",
    "cuci setrika",
    "order form",
    "tabel order",
    "table order",
    "status tracking",
    "file explorer",
    "live preview",
    "command bar",
  ].filter((phrase) => normalized.includes(phrase))

  const stopWords = new Set([
    "buat",
    "bikin",
    "create",
    "build",
    "generate",
    "tolong",
    "please",
    "web",
    "website",
    "app",
    "aplikasi",
    "project",
    "halaman",
    "page",
    "yang",
    "untuk",
    "dengan",
    "dan",
    "atau",
    "di",
    "ke",
    "dari",
    "ini",
    "itu",
    "saya",
    "aku",
    "kami",
    "kita",
    "user",
    "admin",
    "modern",
    "bagus",
    "keren",
    "simple",
    "sederhana",
    "responsive",
    "fitur",
    "data",
    "ui",
    "layout",
  ])

  const words = normalized
    .split(" ")
    .map((word) => word.trim())
    .filter((word) => word.length >= 4 && !stopWords.has(word))

  return Array.from(new Set([...phrases, ...words])).slice(0, 12)
}

function isRelevanceSearchablePath(path: string) {
  const normalized = path.replace(/\\/g, "/").toLowerCase()
  return (
    normalized === "app/page.tsx" ||
    normalized === "app/layout.tsx" ||
    normalized.includes("/page.") ||
    normalized.startsWith("components/") ||
    normalized.startsWith("app/api/") ||
    normalized.startsWith("lib/") ||
    normalized.endsWith(".json") ||
    normalized.endsWith(".prisma")
  )
}

function buildRelevanceFailSafeMessage(details: RelevanceReport) {
  const promptTerms = details.promptTerms.length > 0 ? details.promptTerms.join(", ") : "none"
  const missing = details.missingTerms.length > 0 ? details.missingTerms.join(", ") : "none"

  return [
    "Relevance fail-safe aktif: hasil generate ditahan karena tidak cukup cocok dengan prompt user.",
    "",
    "Diagnostik:",
    `- Skor relevansi: ${details.score}`,
    `- Keyword prompt: ${promptTerms}`,
    `- Keyword belum muncul di output: ${missing}`,
    "",
    "Saldo request ini sudah otomatis direfund. Coba ulang dengan domain, fitur wajib, dan gaya UI yang lebih spesifik.",
  ].join("\n")
}

function mergeProjectMemoryJson(existingValue: string | null | undefined, nextValue: ProjectMemoryData | null | undefined) {
  const existing = parseProjectMemoryJson(existingValue)
  if (!existing && !nextValue) {
    return null
  }

  const notes = Array.from(
    new Set([
      ...(existing?.notes || []),
      ...(nextValue?.notes || []),
    ].map((item) => item.trim()).filter(Boolean))
  )

  const merged: ProjectMemoryData = {
    framework: nextValue?.framework?.trim() || existing?.framework || null,
    uiStyle: nextValue?.uiStyle?.trim() || existing?.uiStyle || null,
    database: nextValue?.database?.trim() || existing?.database || null,
    auth: nextValue?.auth?.trim() || existing?.auth || null,
    folderRules: nextValue?.folderRules?.trim() || existing?.folderRules || null,
    naming: nextValue?.naming?.trim() || existing?.naming || null,
    notes: notes.length > 0 ? notes : undefined,
  }

  return JSON.stringify(merged)
}

function parseProjectMemoryJson(value: string | null | undefined): ProjectMemoryData | null {
  if (!value) {
    return null
  }

  try {
    const parsed = JSON.parse(value) as Partial<ProjectMemoryData> | null
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return null
    }

    return {
      framework: typeof parsed.framework === "string" ? parsed.framework : null,
      uiStyle: typeof parsed.uiStyle === "string" ? parsed.uiStyle : null,
      database: typeof parsed.database === "string" ? parsed.database : null,
      auth: typeof parsed.auth === "string" ? parsed.auth : null,
      folderRules: typeof parsed.folderRules === "string" ? parsed.folderRules : null,
      naming: typeof parsed.naming === "string" ? parsed.naming : null,
      notes: Array.isArray(parsed.notes) ? parsed.notes.filter((note): note is string => typeof note === "string" && note.trim().length > 0) : undefined,
    }
  } catch {
    return null
  }
}

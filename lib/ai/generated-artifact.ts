import { z } from "zod"
import type { GeneratedFile } from "@/lib/types"
import { extractGeneratedFilesFromProviderMessage } from "@/lib/ai/provider-output"
import { normalizeFileLanguage } from "@/lib/workspace-state"

const MAX_GENERATED_FILES = 100
const MAX_SINGLE_FILE_BYTES = 200 * 1024
const FORBIDDEN_PATH_SEGMENTS = /(^|\/)(node_modules|\.next|\.git|dist|build)(\/|$)/i
const FORBIDDEN_EXACT_FILES = new Set([
  ".env",
  ".env.local",
  ".env.production",
  ".env.development",
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
])
const PROTECTED_DELETE_FILES = new Set([
  "package.json",
  "app/layout.tsx",
  "app/page.tsx",
])
const ALLOWED_ROOTS = ["app/", "components/", "hooks/", "lib/", "prisma/", "public/", "services/"]
const ALLOWED_EXACT_FILES = new Set([
  ".swift/workspace-state.json",
  ".env.example",
  "auth.ts",
  "instrumentation.ts",
  "package.json",
  "components.json",
  "next.config.js",
  "next.config.mjs",
  "next.config.ts",
  "tsconfig.json",
  "postcss.config.js",
  "postcss.config.mjs",
  "tailwind.config.js",
  "tailwind.config.ts",
  "middleware.ts",
])

const normalizePath = (path: string) =>
  path.replace(/\\/g, "/").replace(/^\/+/, "").replace(/^\.\//, "").trim()

function isSafeGeneratedPath(path: string) {
  const normalized = normalizePath(path)
  if (!normalized || normalized.includes("\0") || /[\u0000-\u001f\u007f]/.test(normalized)) {
    return false
  }

  const segments = normalized.split("/")
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) {
    return false
  }

  const lower = normalized.toLowerCase()
  if (FORBIDDEN_PATH_SEGMENTS.test(lower) || FORBIDDEN_EXACT_FILES.has(lower)) {
    return false
  }

  return ALLOWED_EXACT_FILES.has(lower) || ALLOWED_ROOTS.some((root) => lower.startsWith(root))
}

const generatedFileSchema = z.object({
  path: z.string().trim().min(1).refine(isSafeGeneratedPath, "unsafe generated file path"),
  content: z.string().refine(
    (content) => Buffer.byteLength(content, "utf8") <= MAX_SINGLE_FILE_BYTES,
    "generated file exceeds single-file size limit"
  ),
  language: z.string().trim().optional(),
})

const taskGraphOperationSchema = z.object({
  id: z.string().trim().min(1).optional(),
  action: z.enum(["create", "modify", "delete"]),
  path: z.string().trim().min(1).refine(isSafeGeneratedPath, "unsafe generated file path"),
  content: z.string().optional(),
  language: z.string().trim().optional(),
  reason: z.string().optional(),
}).superRefine((operation, ctx) => {
  const path = normalizePath(operation.path)

  if ((operation.action === "create" || operation.action === "modify") && typeof operation.content !== "string") {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "create/modify operation requires full content",
      path: ["content"],
    })
  }

  if (operation.action === "delete" && PROTECTED_DELETE_FILES.has(path)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `protected file cannot be deleted: ${path}`,
      path: ["path"],
    })
  }
})

const taskGraphSchema = z.object({
  intent: z.string().optional(),
  summary: z.string().optional(),
  dependencies: z.array(z.string().trim().min(1)).optional().default([]),
  operations: z.array(taskGraphOperationSchema).min(1).max(MAX_GENERATED_FILES),
})

const generatedArtifactSchema = z.object({
  files: z.array(generatedFileSchema).min(1).max(MAX_GENERATED_FILES),
  dependencies: z.array(z.string().trim().min(1)).optional().default([]),
  diagnostics: z.array(z.string()).optional().default([]),
  metadata: z.record(z.unknown()).optional().default({}),
  repairs: z.array(generatedFileSchema).max(MAX_GENERATED_FILES).optional().default([]),
  taskGraph: taskGraphSchema.optional(),
})

export type GeneratedArtifact = {
  files: GeneratedFile[]
  dependencies: string[]
  diagnostics: string[]
  metadata: Record<string, unknown>
  repairs: GeneratedFile[]
  taskGraph?: GeneratedTaskGraph
}

export type GeneratedTaskGraph = {
  intent?: string
  summary?: string
  dependencies: string[]
  operations: GeneratedTaskOperation[]
}

export type GeneratedTaskOperation = {
  id?: string
  action: "create" | "modify" | "delete"
  path: string
  content?: string
  language?: GeneratedFile["language"]
  reason?: string
}

export function parseGeneratedArtifact(providerMessage: string): GeneratedArtifact {
  const parsedJson = tryParseJson(providerMessage)
  if (parsedJson && typeof parsedJson === "object" && !Array.isArray(parsedJson)) {
    const strict = generatedArtifactSchema.safeParse(parsedJson)
    if (strict.success) {
      return {
        files: strict.data.files.map(toGeneratedFile),
        dependencies: strict.data.dependencies,
        diagnostics: strict.data.diagnostics,
        metadata: strict.data.metadata,
        repairs: strict.data.repairs.map(toGeneratedFile),
        taskGraph: strict.data.taskGraph ? toGeneratedTaskGraph(strict.data.taskGraph) : undefined,
      }
    }

    const taskGraphOnly = z.object({
      taskGraph: taskGraphSchema,
      dependencies: z.array(z.string().trim().min(1)).optional().default([]),
      diagnostics: z.array(z.string()).optional().default([]),
      metadata: z.record(z.unknown()).optional().default({}),
    }).safeParse(parsedJson)

    if (taskGraphOnly.success) {
      const taskGraph = toGeneratedTaskGraph(taskGraphOnly.data.taskGraph)
      return {
        files: taskGraph.operations
          .filter((operation) => operation.action !== "delete" && typeof operation.content === "string")
          .map((operation) => ({
            path: operation.path,
            content: operation.content || "",
            language: operation.language || normalizeFileLanguage(undefined),
          })),
        dependencies: [...taskGraphOnly.data.dependencies, ...taskGraph.dependencies],
        diagnostics: taskGraphOnly.data.diagnostics,
        metadata: taskGraphOnly.data.metadata,
        repairs: [],
        taskGraph,
      }
    }
  }

  const legacy = extractGeneratedFilesFromProviderMessage(providerMessage)
  if (legacy.files.length === 0) {
    throw new Error("MALFORMED_GENERATED_ARTIFACT")
  }

  const legacyFiles = validateGeneratedFiles(legacy.files, "legacy")

  return {
    files: legacyFiles,
    dependencies: [],
    diagnostics: [`providerParseMode:${legacy.parseMode}`],
    metadata: {},
    repairs: [],
  }
}

function toGeneratedFile(file: z.infer<typeof generatedFileSchema>): GeneratedFile {
  return {
    path: normalizePath(file.path),
    content: file.content,
    language: normalizeFileLanguage(file.language),
  }
}

function toGeneratedTaskGraph(graph: z.infer<typeof taskGraphSchema>): GeneratedTaskGraph {
  return {
    intent: graph.intent,
    summary: graph.summary,
    dependencies: graph.dependencies,
    operations: graph.operations.map((operation) => ({
      id: operation.id,
      action: operation.action,
      path: normalizePath(operation.path),
      content: operation.content,
      language: operation.language ? normalizeFileLanguage(operation.language) : undefined,
      reason: operation.reason,
    })),
  }
}

function validateGeneratedFiles(files: GeneratedFile[], source: string) {
  const parsed = z.array(generatedFileSchema).min(1).max(MAX_GENERATED_FILES).safeParse(files)
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "files"}: ${issue.message}`)
      .join("; ")
    throw new Error(`MALFORMED_GENERATED_ARTIFACT:${source}:${detail}`)
  }

  return parsed.data.map(toGeneratedFile)
}

function tryParseJson(value: string) {
  const raw = String(value || "").trim()

  try {
    return JSON.parse(raw)
  } catch {
    // Continue with fragment extraction below.
  }

  for (const fragment of extractJsonFragments(raw)) {
    try {
      return JSON.parse(fragment)
    } catch {
      // Try the next candidate.
    }
  }

  return null
}

function extractJsonFragments(value: string) {
  const fragments: string[] = []
  const fencedJson = /```(?:json)?\s*([\s\S]*?)```/gi
  for (const match of value.matchAll(fencedJson)) {
    if (match[1]?.trim()) {
      fragments.push(match[1].trim())
    }
  }

  const firstObject = value.indexOf("{")
  const lastObject = value.lastIndexOf("}")
  if (firstObject >= 0 && lastObject > firstObject) {
    fragments.push(value.slice(firstObject, lastObject + 1))
  }

  const firstArray = value.indexOf("[")
  const lastArray = value.lastIndexOf("]")
  if (firstArray >= 0 && lastArray > firstArray) {
    fragments.push(value.slice(firstArray, lastArray + 1))
  }

  return fragments
}

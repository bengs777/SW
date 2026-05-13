import { z } from "zod"
import type { GeneratedFile } from "@/lib/types"
import { extractGeneratedFilesFromProviderMessage } from "@/lib/ai/provider-output"
import { normalizeFileLanguage } from "@/lib/workspace-state"

const MAX_GENERATED_FILES = 240
const MAX_SINGLE_FILE_BYTES = 512 * 1024
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
  return !FORBIDDEN_PATH_SEGMENTS.test(lower) && !FORBIDDEN_EXACT_FILES.has(lower)
}

const generatedFileSchema = z.object({
  path: z.string().trim().min(1).refine(isSafeGeneratedPath, "unsafe generated file path"),
  content: z.string().refine(
    (content) => Buffer.byteLength(content, "utf8") <= MAX_SINGLE_FILE_BYTES,
    "generated file exceeds single-file size limit"
  ),
  language: z.string().trim().optional(),
})

const generatedArtifactSchema = z.object({
  files: z.array(generatedFileSchema).min(1).max(MAX_GENERATED_FILES),
  dependencies: z.array(z.string().trim().min(1)).optional().default([]),
  diagnostics: z.array(z.string()).optional().default([]),
  metadata: z.record(z.unknown()).optional().default({}),
  repairs: z.array(generatedFileSchema).max(MAX_GENERATED_FILES).optional().default([]),
})

export type GeneratedArtifact = {
  files: GeneratedFile[]
  dependencies: string[]
  diagnostics: string[]
  metadata: Record<string, unknown>
  repairs: GeneratedFile[]
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
  try {
    return JSON.parse(String(value || "").trim())
  } catch {
    return null
  }
}

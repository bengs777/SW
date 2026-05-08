import path from "node:path"
import type {
  AIContextSnapshot,
  DiagnosticEntry,
  EditorSelectionContext,
  GeneratedFile,
  GitDiffSnapshot,
  ProjectMemoryData,
  TerminalOutputSnapshot,
} from "@/lib/types"

const CONTEXT_FILE_LIMIT = 12
const CONTEXT_EXCERPT_LIMIT = 1200

type BuildAIContextInput = {
  projectId: string
  projectName?: string | null
  activeFile?: GeneratedFile | null
  files?: GeneratedFile[]
  selectedText?: EditorSelectionContext | null
  diagnostics?: DiagnosticEntry[]
  gitDiff?: GitDiffSnapshot | null
  terminalOutput?: TerminalOutputSnapshot | null
  projectMemory?: ProjectMemoryData | string | null
}

type ContextFileSnapshot = {
  path: string
  language: GeneratedFile["language"]
  size: number
  isActive?: boolean
  contentPreview?: string | null
}

export function buildAIContextSnapshot(input: BuildAIContextInput): AIContextSnapshot {
  const files = Array.isArray(input.files) ? input.files.slice() : []
  const activeFile = resolveActiveFile(input.activeFile || null, files)
  const packageJson = pickFileByName(files, "package.json")
  const tsconfig = pickTsconfigFile(files)
  const projectMemory = normalizeProjectMemory(input.projectMemory)

  return {
    projectId: input.projectId,
    projectName: input.projectName?.trim() || null,
    activeFile,
    selectedText: input.selectedText || null,
    importedFiles: collectImportedFiles(activeFile, files),
    nearbyFiles: collectNearbyFiles(activeFile, files),
    packageJson,
    tsconfig,
    diagnostics: Array.isArray(input.diagnostics) ? input.diagnostics : [],
    gitDiff: input.gitDiff || null,
    terminalOutput: input.terminalOutput || null,
    projectMemory,
  }
}

export function formatAIContextForPrompt(context: AIContextSnapshot) {
  return [
    "AI_CONTEXT_JSON (source of truth for repo state, do not invent missing facts):",
    JSON.stringify(serializeAIContext(context), null, 2),
  ].join("\n")
}

export function appendAIContextToPrompt(prompt: string, context: AIContextSnapshot | null | undefined) {
  if (!context) {
    return prompt
  }

  return `${prompt}\n\n${formatAIContextForPrompt(context)}`
}

function serializeAIContext(context: AIContextSnapshot) {
  return {
    projectId: context.projectId,
    projectName: context.projectName || null,
    activeFile: context.activeFile ? snapshotFile(context.activeFile, true) : null,
    selectedText: context.selectedText || null,
    importedFiles: snapshotFiles(context.importedFiles || []),
    nearbyFiles: snapshotFiles(context.nearbyFiles || []),
    packageJson: context.packageJson ? snapshotFile(context.packageJson) : null,
    tsconfig: context.tsconfig ? snapshotFile(context.tsconfig) : null,
    diagnostics: context.diagnostics || [],
    gitDiff: context.gitDiff || null,
    terminalOutput: context.terminalOutput || null,
    projectMemory: context.projectMemory || null,
  }
}

function snapshotFiles(files: GeneratedFile[]): ContextFileSnapshot[] {
  return files.slice(0, CONTEXT_FILE_LIMIT).map((file) => snapshotFile(file, false))
}

function snapshotFile(file: GeneratedFile, isActive = false): ContextFileSnapshot {
  return {
    path: file.path,
    language: file.language,
    size: String(file.content || "").length,
    isActive: isActive || undefined,
    contentPreview: excerptText(file.content, CONTEXT_EXCERPT_LIMIT),
  }
}

function resolveActiveFile(activeFile: GeneratedFile | null, files: GeneratedFile[]) {
  if (!activeFile) {
    return null
  }

  const normalizedPath = normalizePath(activeFile.path)
  const matched = files.find((file) => normalizePath(file.path) === normalizedPath)
  return matched || activeFile
}

function collectImportedFiles(activeFile: GeneratedFile | null, files: GeneratedFile[]) {
  if (!activeFile) {
    return []
  }

  const fileMap = buildFileMap(files)
  const specifiers = extractImportSpecifiers(activeFile.content)
  const imported = new Map<string, GeneratedFile>()

  for (const specifier of specifiers) {
    for (const candidatePath of resolveImportCandidates(activeFile.path, specifier)) {
      const matched = fileMap.get(normalizePath(candidatePath))
      if (matched) {
        imported.set(normalizePath(matched.path), matched)
      }
    }
  }

  return Array.from(imported.values()).slice(0, CONTEXT_FILE_LIMIT)
}

function collectNearbyFiles(activeFile: GeneratedFile | null, files: GeneratedFile[]) {
  const fileMap = buildFileMap(files)
  const nearby = new Map<string, GeneratedFile>()

  if (activeFile) {
    nearby.set(normalizePath(activeFile.path), resolveActiveFile(activeFile, files) || activeFile)

    const activeDir = path.posix.dirname(normalizePath(activeFile.path))
    const sameDirPrefix = activeDir === "." ? "" : `${activeDir}/`

    for (const file of files) {
      const normalized = normalizePath(file.path)
      if (normalized === normalizePath(activeFile.path)) {
        continue
      }

      const fileDir = path.posix.dirname(normalized)
      if (fileDir === activeDir || (sameDirPrefix && normalized.startsWith(sameDirPrefix))) {
        nearby.set(normalized, file)
      }
    }
  }

  for (const configName of ["package.json", "tsconfig.json", "tsconfig.app.json", "tsconfig.node.json"]) {
    const matched = pickFileByName(files, configName)
    if (matched) {
      nearby.set(normalizePath(matched.path), matched)
    }
  }

  return Array.from(nearby.values()).slice(0, CONTEXT_FILE_LIMIT)
}

function pickFileByName(files: GeneratedFile[], fileName: string) {
  const normalizedName = fileName.toLowerCase()
  return files.find((file) => normalizePath(file.path).endsWith(`/${normalizedName}`) || normalizePath(file.path) === normalizedName) || null
}

function pickTsconfigFile(files: GeneratedFile[]) {
  return (
    files.find((file) => /(^|\/)tsconfig(\.[^/]+)?\.json$/i.test(normalizePath(file.path))) ||
    null
  )
}

function buildFileMap(files: GeneratedFile[]) {
  const fileMap = new Map<string, GeneratedFile>()
  for (const file of files) {
    fileMap.set(normalizePath(file.path), file)
  }
  return fileMap
}

function extractImportSpecifiers(content: string) {
  const specifiers = new Set<string>()
  const patterns = [
    /from\s+['"]([^'"]+)['"]/g,
    /import\s+['"]([^'"]+)['"]/g,
  ]

  for (const pattern of patterns) {
    for (const match of String(content || "").matchAll(pattern)) {
      const specifier = match[1]?.trim()
      if (specifier) {
        specifiers.add(specifier)
      }
    }
  }

  return Array.from(specifiers)
}

function resolveImportCandidates(fromPath: string, specifier: string) {
  const normalizedSpecifier = specifier.replace(/\\/g, "/")
  const candidates = new Set<string>()

  if (!normalizedSpecifier.startsWith(".") && !normalizedSpecifier.startsWith("@/")) {
    return []
  }

  const aliaslessSpecifier = normalizedSpecifier.startsWith("@/")
    ? normalizedSpecifier.slice(2)
    : normalizedSpecifier
  const baseDir = path.posix.dirname(normalizePath(fromPath))
  const resolved = normalizedSpecifier.startsWith("@/")
    ? aliaslessSpecifier
    : path.posix.normalize(path.posix.join(baseDir, aliaslessSpecifier))

  for (const candidate of buildPathVariants(resolved)) {
    candidates.add(candidate)
  }

  return Array.from(candidates)
}

function buildPathVariants(resolvedPath: string) {
  const normalized = normalizePath(resolvedPath)
  const variants = new Set<string>()
  const extensionMatch = normalized.match(/\.[^/.]+$/)

  variants.add(normalized)

  if (!extensionMatch) {
    for (const extension of [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".json"]) {
      variants.add(`${normalized}${extension}`)
      variants.add(path.posix.join(normalized, `index${extension}`))
    }
  }

  return Array.from(variants)
}

function normalizeProjectMemory(value: ProjectMemoryData | string | null | undefined): ProjectMemoryData | null {
  if (!value) {
    return null
  }

  if (typeof value === "string") {
    const trimmed = value.trim()
    if (!trimmed) {
      return null
    }

    try {
      const parsed = JSON.parse(trimmed) as unknown
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return normalizeProjectMemoryObject(parsed as Record<string, unknown>)
      }
    } catch {
      return {
        notes: [trimmed],
      }
    }

    return null
  }

  return normalizeProjectMemoryObject(value)
}

function normalizeProjectMemoryObject(value: Record<string, unknown> | ProjectMemoryData): ProjectMemoryData {
  const source = value as Record<string, unknown>

  return {
    framework: normalizeString(source.framework),
    uiStyle: normalizeString(source.uiStyle),
    database: normalizeString(source.database),
    auth: normalizeString(source.auth),
    folderRules: normalizeString(source.folderRules),
    naming: normalizeString(source.naming),
    notes: Array.isArray(source.notes)
      ? source.notes.map((note) => normalizeString(note)).filter((note): note is string => Boolean(note))
      : undefined,
  }
}

function normalizeString(value: unknown) {
  return typeof value === "string" ? value.trim() || null : null
}

function normalizePath(value: string) {
  return String(value || "").replace(/\\/g, "/").replace(/^\.\//, "").toLowerCase()
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
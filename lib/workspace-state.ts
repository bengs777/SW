import type { GeneratedFile } from "@/lib/types"

export const WORKSPACE_STATE_FILE_PATH = ".swift/workspace-state.json"

export const VALID_LANGUAGES = [
  "tsx",
  "ts",
  "css",
  "json",
  "html",
  "prisma",
  "md",
  "env",
] as const

export type ValidLanguage = (typeof VALID_LANGUAGES)[number]

export function normalizeFileLanguage(value: unknown): ValidLanguage {
  if (typeof value === "string" && VALID_LANGUAGES.includes(value as ValidLanguage)) {
    return value as ValidLanguage
  }
  return "ts"
}

export type WorkspaceState = {
  version: number
  dirty: boolean
  lockedPaths: string[]
  activeFilePath: string | null
  updatedAt: string
}

type WorkspaceStateFileSplit = {
  files: GeneratedFile[]
  stateFile: GeneratedFile | null
}

const normalizeWorkspacePath = (input: string) =>
  input.replace(/\\/g, "/").replace(/^\.\//, "").trim()

export const isWorkspaceStateFilePath = (input: string) =>
  normalizeWorkspacePath(input) === WORKSPACE_STATE_FILE_PATH

export const isWorkspaceStateFile = (file: GeneratedFile) =>
  isWorkspaceStateFilePath(file.path)

/**
 * Accepts raw file arrays (e.g. from Prisma where language is plain string)
 * and normalizes language to the valid union at runtime, removing the need
 * for unsafe type assertions at call sites.
 */
export function splitWorkspaceStateFiles(
  files: Array<{ path: string; content: string; language: string | null | undefined }>
): WorkspaceStateFileSplit {
  const visibleFiles: GeneratedFile[] = []
  let stateFile: GeneratedFile | null = null

  for (const file of files) {
    const normalizedFile: GeneratedFile = {
      path: normalizeWorkspacePath(file.path),
      content: String(file.content ?? ""),
      language: normalizeFileLanguage(file.language),
    }

    if (isWorkspaceStateFile(normalizedFile)) {
      if (!stateFile) {
        stateFile = normalizedFile
      }
      continue
    }

    visibleFiles.push(normalizedFile)
  }

  return {
    files: visibleFiles,
    stateFile,
  }
}

export function buildWorkspaceStateFile(state: WorkspaceState): GeneratedFile {
  return {
    path: WORKSPACE_STATE_FILE_PATH,
    content: JSON.stringify(state, null, 2),
    language: "json",
  }
}

export function readWorkspaceStateFile(file: GeneratedFile | null | undefined): WorkspaceState | null {
  if (!file || !isWorkspaceStateFile(file) || !String(file.content || "").trim()) {
    return null
  }

  try {
    const parsed = JSON.parse(file.content) as Partial<WorkspaceState>
    const lockedPaths = Array.isArray(parsed.lockedPaths)
      ? parsed.lockedPaths.filter((path): path is string => typeof path === "string" && path.trim().length > 0)
      : []

    return {
      version: Number.isFinite(parsed.version) ? Number(parsed.version) : 0,
      dirty: Boolean(parsed.dirty),
      lockedPaths: Array.from(new Set(lockedPaths)),
      activeFilePath: typeof parsed.activeFilePath === "string" && parsed.activeFilePath.trim() ? parsed.activeFilePath.trim() : null,
      updatedAt: typeof parsed.updatedAt === "string" && parsed.updatedAt.trim() ? parsed.updatedAt : new Date().toISOString(),
    }
  } catch {
    return null
  }
}

export function createWorkspaceStateSnapshot(input: {
  version: number
  dirty: boolean
  lockedPaths: Iterable<string>
  activeFilePath?: string | null
}): WorkspaceState {
  return {
    version: Math.max(0, Math.floor(input.version)),
    dirty: Boolean(input.dirty),
    lockedPaths: Array.from(new Set(Array.from(input.lockedPaths).map((path) => path.trim()).filter(Boolean))).sort(),
    activeFilePath: input.activeFilePath?.trim() || null,
    updatedAt: new Date().toISOString(),
  }
}
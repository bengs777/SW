import type { GeneratedFile } from "@/lib/types"
import type { GeneratedArtifact, GeneratedTaskGraph } from "@/lib/ai/generated-artifact"
import { normalizeGeneratedPath, validateGeneratedPath } from "@/lib/ai/file-policy"
import { normalizeFileLanguage } from "@/lib/workspace-state"

export const MAX_CHANGED_FILES_PER_REQUEST = 5

export type LinePatchChange = {
  line: number
  replace: string
}

export type ProjectPatchOperation =
  | { operation: "createFile"; file: string; content: string; language?: GeneratedFile["language"] | string }
  | { operation: "modifyFile"; file: string; content: string; language?: GeneratedFile["language"] | string }
  | { operation: "deleteFile"; file: string }
  | { operation: "patchFile"; file: string; changes: LinePatchChange[]; language?: GeneratedFile["language"] | string }

export type ProjectPatchResult = {
  files: GeneratedFile[]
  changedFiles: GeneratedFile[]
  deletedPaths: string[]
  operations: ProjectPatchOperation[]
}

export function artifactToPatchOperations(input: {
  artifact: GeneratedArtifact
  currentFiles: GeneratedFile[]
}): ProjectPatchOperation[] {
  const currentPaths = new Set(input.currentFiles.map((file) => normalizePath(file.path)))
  const taskOperations = input.artifact.taskGraph?.operations || []

  if (taskOperations.length > 0) {
    return taskOperations.map((operation) => {
      const file = normalizePath(operation.path)
      if (operation.action === "delete") return { operation: "deleteFile", file }
      if (operation.action === "patch") {
        return {
          operation: "patchFile",
          file,
          changes: operation.changes || [],
          language: operation.language,
        }
      }
      return {
        operation: operation.action === "create" || !currentPaths.has(file) ? "createFile" : "modifyFile",
        file,
        content: String(operation.content || ""),
        language: operation.language,
      }
    })
  }

  return input.artifact.files.map((file) => {
    const path = normalizePath(file.path)
    return {
      operation: currentPaths.has(path) ? "modifyFile" : "createFile",
      file: path,
      content: file.content,
      language: file.language,
    }
  })
}

export function applyProjectPatchOperations(
  currentFiles: GeneratedFile[],
  operations: ProjectPatchOperation[],
  options: { maxChangedFilesPerRequest?: number } = {}
): ProjectPatchResult {
  const maxChangedFiles = options.maxChangedFilesPerRequest || MAX_CHANGED_FILES_PER_REQUEST
  const normalizedOperations = collapsePatchOperations(operations)
  if (normalizedOperations.length > maxChangedFiles) {
    throw new Error(`Diff/Patch request changed ${normalizedOperations.length} files; maximum is ${maxChangedFiles}.`)
  }

  const byPath = new Map(currentFiles.map((file) => [normalizePath(file.path), normalizeFile(file)]))
  const changedPathSet = new Set<string>()
  const deletedPaths: string[] = []

  for (const operation of normalizedOperations) {
    const filePath = validateGeneratedPath(operation.file, process.cwd(), { allowManagedPackageJson: true }).path

    if (operation.operation === "deleteFile") {
      if (byPath.delete(filePath)) {
        changedPathSet.add(filePath)
        deletedPaths.push(filePath)
      }
      continue
    }

    if (operation.operation === "patchFile") {
      const current = byPath.get(filePath)
      if (!current) throw new Error(`Cannot patch missing file: ${filePath}`)
      byPath.set(filePath, {
        ...current,
        content: applyLineChanges(current.content, operation.changes),
        language: normalizeFileLanguage(operation.language || current.language),
      })
      changedPathSet.add(filePath)
      continue
    }

    byPath.set(filePath, {
      path: filePath,
      content: operation.content,
      language: normalizeFileLanguage(operation.language),
    })
    changedPathSet.add(filePath)
  }

  const files = Array.from(byPath.values()).sort((left, right) => left.path.localeCompare(right.path))
  return {
    files,
    changedFiles: files.filter((file) => changedPathSet.has(normalizePath(file.path))),
    deletedPaths,
    operations: normalizedOperations,
  }
}

export function taskGraphFromPatchOperations(operations: ProjectPatchOperation[]): GeneratedTaskGraph {
  return {
    intent: "diff_patch",
    dependencies: [],
    operations: operations.map((operation) => {
      if (operation.operation === "deleteFile") {
        return { action: "delete", path: operation.file }
      }
      if (operation.operation === "patchFile") {
        return {
          action: "patch",
          path: operation.file,
          changes: operation.changes,
          language: normalizeFileLanguage(operation.language),
        }
      }
      return {
        action: operation.operation === "createFile" ? "create" : "modify",
        path: operation.file,
        content: operation.content,
        language: normalizeFileLanguage(operation.language),
      }
    }),
  }
}

function collapsePatchOperations(operations: ProjectPatchOperation[]) {
  const byPath = new Map<string, ProjectPatchOperation>()
  for (const operation of operations) {
    byPath.set(normalizePath(operation.file), {
      ...operation,
      file: normalizePath(operation.file),
    } as ProjectPatchOperation)
  }
  return Array.from(byPath.values())
}

function applyLineChanges(content: string, changes: LinePatchChange[]) {
  const lines = content.split(/\r?\n/)
  for (const change of changes) {
    const index = Math.max(0, Math.floor(change.line) - 1)
    if (index >= lines.length) throw new Error(`Patch line ${change.line} is outside file length.`)
    lines[index] = change.replace
  }
  return lines.join("\n")
}

function normalizeFile(file: GeneratedFile): GeneratedFile {
  return {
    path: normalizePath(file.path),
    content: String(file.content || ""),
    language: normalizeFileLanguage(file.language),
  }
}

function normalizePath(input: string) {
  return normalizeGeneratedPath(input)
}

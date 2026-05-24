import type { GeneratedFile } from "@/lib/types"
import type { ProjectDependencyGraph } from "@/lib/project-state/dependency-graph"
import { nearestDependencyPaths } from "@/lib/project-state/dependency-graph"

export type RankedProjectContext = {
  files: GeneratedFile[]
  selectedPaths: string[]
  totalChars: number
  omittedPaths: string[]
}

export type RankProjectContextInput = {
  files: GeneratedFile[]
  dependencyGraph: ProjectDependencyGraph
  modifiedPaths?: string[]
  failingPaths?: string[]
  maxFiles?: number
  maxTotalChars?: number
}

const DEFAULT_MAX_FILES = 10
const DEFAULT_MAX_TOTAL_CHARS = 64 * 1024

export function rankProjectContext(input: RankProjectContextInput): RankedProjectContext {
  const maxFiles = input.maxFiles || DEFAULT_MAX_FILES
  const maxTotalChars = input.maxTotalChars || DEFAULT_MAX_TOTAL_CHARS
  const byPath = new Map(input.files.map((file) => [normalizePath(file.path), file]))
  const modifiedPaths = unique(input.modifiedPaths || [])
  const failingPaths = unique(input.failingPaths || [])
  const importedDependencies = unique(modifiedPaths.flatMap((path) => input.dependencyGraph.imports[path] || []))
  const nearest = nearestDependencyPaths(input.dependencyGraph, [...modifiedPaths, ...failingPaths], maxFiles * 2)

  const priority = unique([
    ...modifiedPaths,
    ...importedDependencies,
    ...failingPaths,
    ...nearest,
    "package.json",
    "tsconfig.json",
    "app/layout.tsx",
    "app/page.tsx",
    ...Array.from(byPath.keys()).sort(),
  ])

  const selected: GeneratedFile[] = []
  let totalChars = 0

  for (const path of priority) {
    const file = byPath.get(path)
    if (!file || selected.some((item) => normalizePath(item.path) === path)) continue
    const content = String(file.content || "")
    if (selected.length >= maxFiles) continue
    if (totalChars + content.length > maxTotalChars && selected.length > 0) continue
    selected.push(file)
    totalChars += content.length
  }

  const selectedPathSet = new Set(selected.map((file) => normalizePath(file.path)))
  return {
    files: selected,
    selectedPaths: selected.map((file) => normalizePath(file.path)),
    totalChars,
    omittedPaths: Array.from(byPath.keys()).filter((path) => !selectedPathSet.has(path)).sort(),
  }
}

function unique(paths: string[]) {
  return Array.from(new Set(paths.map(normalizePath).filter(Boolean)))
}

function normalizePath(input: string) {
  return input.replace(/\\/g, "/").replace(/^\.\//, "").trim()
}

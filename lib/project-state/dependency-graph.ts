import path from "node:path"
import type { GeneratedFile } from "@/lib/types"

export type ProjectDependencyGraph = {
  imports: Record<string, string[]>
  importedBy: Record<string, string[]>
}

const IMPORT_RE = /(?:import\s+(?:type\s+)?[\s\S]*?\s+from\s+["']([^"']+)["']|import\s*\(\s*["']([^"']+)["']\s*\)|export\s+[\s\S]*?\s+from\s+["']([^"']+)["'])/g
const EXTENSIONS = ["", ".ts", ".tsx", ".js", ".jsx", ".json", ".css"]
const INDEX_EXTENSIONS = ["/index.ts", "/index.tsx", "/index.js", "/index.jsx"]

export function buildProjectDependencyGraph(files: GeneratedFile[]): ProjectDependencyGraph {
  const filePaths = new Set(files.map((file) => normalizePath(file.path)))
  const imports: Record<string, string[]> = {}
  const importedBy: Record<string, string[]> = {}

  for (const file of files) {
    const filePath = normalizePath(file.path)
    const dependencies = resolveImports(filePath, file.content, filePaths)
    imports[filePath] = dependencies
    for (const dependency of dependencies) {
      importedBy[dependency] = [...(importedBy[dependency] || []), filePath].sort()
    }
  }

  return { imports, importedBy }
}

function resolveImports(filePath: string, content: string, filePaths: Set<string>) {
  const resolved = new Set<string>()
  IMPORT_RE.lastIndex = 0
  let match: RegExpExecArray | null

  while ((match = IMPORT_RE.exec(content))) {
    const specifier = match[1] || match[2] || match[3] || ""
    const target = resolveImportSpecifier(filePath, specifier, filePaths)
    if (target) resolved.add(target)
  }

  return Array.from(resolved).sort()
}

function resolveImportSpecifier(filePath: string, specifier: string, filePaths: Set<string>) {
  if (!specifier.startsWith(".") && !specifier.startsWith("@/")) return null

  const base = specifier.startsWith("@/")
    ? specifier.slice(2)
    : path.posix.normalize(path.posix.join(path.posix.dirname(filePath), specifier))

  for (const suffix of [...EXTENSIONS, ...INDEX_EXTENSIONS]) {
    const candidate = normalizePath(`${base}${suffix}`)
    if (filePaths.has(candidate)) return candidate
  }

  return null
}

export function nearestDependencyPaths(graph: ProjectDependencyGraph, seedPaths: string[], limit = 10) {
  const queue = seedPaths.map(normalizePath)
  const seen = new Set<string>()
  const result: string[] = []

  while (queue.length > 0 && result.length < limit) {
    const current = queue.shift()
    if (!current || seen.has(current)) continue
    seen.add(current)
    if (!seedPaths.map(normalizePath).includes(current)) result.push(current)
    queue.push(...(graph.imports[current] || []), ...(graph.importedBy[current] || []))
  }

  return result
}

function normalizePath(input: string) {
  return input.replace(/\\/g, "/").replace(/^\.\//, "").trim()
}

import path from "node:path"
import ts from "typescript"
import type { GeneratedFile } from "@/lib/types"
import { buildDependencyMap } from "@/lib/ai/generation-pipeline"
import { buildImportGraph, type ImportGraph } from "@/lib/ai/import-graph"

type ImportBinding = {
  defaultName?: string
  named: string[]
  typeOnly: boolean
}

export type ImportRepairResult = {
  files: GeneratedFile[]
  changedFiles: GeneratedFile[]
  createdFiles: GeneratedFile[]
  rewrites: Array<{ file: string; from: string; to: string; target: string }>
  deferredMissing: Array<{ file: string; specifier: string; plannedPath: string }>
  diagnostics: string[]
}

const CODE_FILE_RE = /\.(tsx?|jsx?|mjs|cjs)$/i
const STYLE_FILE_RE = /\.css$/i
const JSON_FILE_RE = /\.json$/i
const ALLOWED_GENERATED_ROOT_RE = /^(app|components|sections|lib|src)\//i

export function repairRuntimeImportGraph(
  files: GeneratedFile[],
  options?: {
    plannedPaths?: string[]
    createMissing?: boolean
  }
): ImportRepairResult {
  let currentFiles = normalizeFiles(files)
  const plannedPaths = new Set((options?.plannedPaths || []).map(normalizePath).filter(Boolean))
  const rewrites: ImportRepairResult["rewrites"] = []
  const deferredMissing: ImportRepairResult["deferredMissing"] = []
  const diagnostics: string[] = []

  const firstAliasRepair = rewriteResolvableAliasImports(currentFiles)
  currentFiles = firstAliasRepair.files
  rewrites.push(...firstAliasRepair.rewrites)

  const createdFiles: GeneratedFile[] = []
  const dependencyMap = buildDependencyMap(currentFiles)
  const pathSet = new Set(currentFiles.map((file) => normalizePath(file.path)))

  for (const missing of dependencyMap.missingLocalImports) {
    const plannedPath = missing.candidates.find((candidate) => plannedPaths.has(normalizePath(candidate)))
    if (plannedPath && !pathSet.has(normalizePath(plannedPath))) {
      deferredMissing.push({
        file: normalizePath(missing.file),
        specifier: missing.specifier,
        plannedPath: normalizePath(plannedPath),
      })
    }

    if (!options?.createMissing) continue
    const targetPath = chooseMissingFilePath(missing.candidates, plannedPath)
    if (!targetPath || pathSet.has(targetPath)) continue

    const importer = currentFiles.find((file) => normalizePath(file.path) === normalizePath(missing.file))
    const binding = importer ? findImportBinding(importer, missing.specifier) : null
    const created = createMissingImportFile(targetPath, binding)
    if (!created) continue

    currentFiles.push(created)
    createdFiles.push(created)
    pathSet.add(targetPath)
  }

  if (createdFiles.length > 0) {
    const secondAliasRepair = rewriteResolvableAliasImports(currentFiles)
    currentFiles = secondAliasRepair.files
    rewrites.push(...secondAliasRepair.rewrites)
  }

  const graph = buildImportGraph(currentFiles)
  const cycles = detectCircularImports(graph)
  if (cycles.length > 0) {
    diagnostics.push(...cycles.map((cycle) => `Circular import: ${cycle.join(" -> ")}`))
  }

  const changedByPath = new Map<string, GeneratedFile>()
  for (const rewrite of rewrites) {
    const file = currentFiles.find((item) => normalizePath(item.path) === normalizePath(rewrite.file))
    if (file) changedByPath.set(normalizePath(file.path), file)
  }
  for (const file of createdFiles) {
    changedByPath.set(normalizePath(file.path), file)
  }

  return {
    files: currentFiles,
    changedFiles: Array.from(changedByPath.values()).sort((left, right) => left.path.localeCompare(right.path)),
    createdFiles,
    rewrites,
    deferredMissing,
    diagnostics,
  }
}

export function hasValidTsconfigAlias(files: GeneratedFile[]) {
  const tsconfig = normalizeFiles(files).find((file) => normalizePath(file.path) === "tsconfig.json")
  if (!tsconfig) return false

  try {
    const parsed = JSON.parse(String(tsconfig.content || ""))
    const paths = parsed?.compilerOptions?.paths
    const alias = paths?.["@/*"]
    return Array.isArray(alias) && alias.some((value) => typeof value === "string" && /^(?:\.\/)?(?:\*|src\/\*)$/.test(value))
  } catch {
    return false
  }
}

export function usesWorkspaceAlias(files: GeneratedFile[]) {
  return normalizeFiles(files).some((file) => CODE_FILE_RE.test(file.path) && /from\s+["']@\/|import\s*\(\s*["']@\//.test(String(file.content || "")))
}

function rewriteResolvableAliasImports(files: GeneratedFile[]) {
  const graph = buildImportGraph(files)
  const filesByPath = new Map(files.map((file) => [normalizePath(file.path), file]))
  const replacementsByFile = new Map<string, Array<{ from: string; to: string; target: string }>>()

  for (const node of graph.nodes) {
    for (const edge of node.imports) {
      if (!edge.resolvedPath || !edge.specifier.startsWith("@/")) continue
      const to = relativeImportSpecifier(node.file, edge.resolvedPath)
      if (!to || to === edge.specifier) continue

      const replacements = replacementsByFile.get(node.file) || []
      replacements.push({ from: edge.specifier, to, target: edge.resolvedPath })
      replacementsByFile.set(node.file, replacements)
    }
  }

  const rewrites: ImportRepairResult["rewrites"] = []
  const repairedFiles = files.map((file) => {
    const normalized = normalizePath(file.path)
    const replacements = replacementsByFile.get(normalized)
    if (!replacements || !CODE_FILE_RE.test(normalized)) return file

    let content = String(file.content || "")
    for (const replacement of replacements) {
      const before = content
      content = replaceImportSpecifier(content, replacement.from, replacement.to)
      if (content !== before) {
        rewrites.push({
          file: normalized,
          from: replacement.from,
          to: replacement.to,
          target: replacement.target,
        })
      }
    }

    return content === file.content ? file : { ...file, path: normalized, content }
  })

  for (const [filePath, file] of filesByPath.entries()) {
    if (!repairedFiles.some((item) => normalizePath(item.path) === filePath)) {
      repairedFiles.push(file)
    }
  }

  return { files: repairedFiles, rewrites }
}

function chooseMissingFilePath(candidates: string[], plannedPath?: string) {
  const normalizedPlanned = plannedPath ? normalizePath(plannedPath) : ""
  if (normalizedPlanned && isSafeGeneratedPath(normalizedPlanned)) return normalizedPlanned

  return candidates
    .map(normalizePath)
    .find((candidate) =>
      isSafeGeneratedPath(candidate) &&
      /\.(tsx?|jsx?|mjs|cjs|json|css)$/i.test(candidate) &&
      !candidate.endsWith(".env") &&
      !candidate.endsWith(".md") &&
      !candidate.endsWith(".prisma")
    ) || null
}

function createMissingImportFile(filePath: string, binding: ImportBinding | null): GeneratedFile | null {
  const normalized = normalizePath(filePath)
  if (!isSafeGeneratedPath(normalized)) return null

  if (STYLE_FILE_RE.test(normalized)) {
    return { path: normalized, language: "css", content: "/* Auto-created to satisfy generated stylesheet imports. */\n" }
  }
  if (JSON_FILE_RE.test(normalized)) {
    return { path: normalized, language: "json", content: "{}\n" }
  }

  const isTsx = /\.tsx$/i.test(normalized) || /^(components|sections|app)\//i.test(normalized)
  const named = Array.from(new Set(binding?.named || [])).filter(isIdentifier)
  const defaultName = binding?.defaultName && isIdentifier(binding.defaultName) ? binding.defaultName : null
  const lines: string[] = []

  if (isTsx) {
    lines.push('import type { ReactNode } from "react"', "")
  }

  if (binding?.typeOnly) {
    for (const name of named) {
      lines.push(`export type ${name} = Record<string, unknown>`)
    }
  } else {
    for (const name of named) {
      lines.push(isTsx
        ? `export function ${name}(_props: Record<string, unknown> & { children?: ReactNode }) {\n  return null\n}`
        : `export function ${name}(..._args: unknown[]) {\n  return null\n}`)
    }
  }

  if (defaultName) {
    lines.push(isTsx
      ? `function ${defaultName}(_props: Record<string, unknown> & { children?: ReactNode }) {\n  return null\n}\n\nexport default ${defaultName}`
      : `const ${defaultName} = {}\n\nexport default ${defaultName}`)
  } else if (!named.length) {
    lines.push(isTsx
      ? "export default function GeneratedImportFallback(_props: { children?: ReactNode }) {\n  return null\n}"
      : "const generatedImportFallback = {}\n\nexport default generatedImportFallback")
  }

  return {
    path: normalized,
    language: isTsx ? "tsx" : "ts",
    content: `${lines.join("\n\n").trim()}\n`,
  }
}

function findImportBinding(file: GeneratedFile, specifier: string): ImportBinding | null {
  const content = String(file.content || "")
  const sourceFile = ts.createSourceFile(normalizePath(file.path), content, ts.ScriptTarget.Latest, true, scriptKindForPath(file.path))
  let binding: ImportBinding | null = null

  sourceFile.forEachChild((node) => {
    if (binding || !ts.isImportDeclaration(node) || !ts.isStringLiteralLike(node.moduleSpecifier)) return
    if (node.moduleSpecifier.text !== specifier) return

    const importClause = node.importClause
    const named: string[] = []
    if (importClause?.namedBindings && ts.isNamedImports(importClause.namedBindings)) {
      for (const element of importClause.namedBindings.elements) {
        named.push(element.propertyName?.text || element.name.text)
      }
    }

    binding = {
      defaultName: importClause?.name?.text,
      named,
      typeOnly: Boolean(importClause?.isTypeOnly),
    }
  })

  return binding
}

function detectCircularImports(graph: ImportGraph) {
  const cycles: string[][] = []
  const visiting = new Set<string>()
  const visited = new Set<string>()
  const stack: string[] = []

  const visit = (file: string) => {
    if (visited.has(file)) return
    if (visiting.has(file)) {
      const start = stack.indexOf(file)
      if (start >= 0) cycles.push([...stack.slice(start), file])
      return
    }

    visiting.add(file)
    stack.push(file)
    const node = graph.byFile.get(file)
    for (const edge of node?.imports || []) {
      if (edge.resolvedPath) visit(edge.resolvedPath)
    }
    stack.pop()
    visiting.delete(file)
    visited.add(file)
  }

  for (const node of graph.nodes) {
    visit(node.file)
  }

  const seen = new Set<string>()
  return cycles.filter((cycle) => {
    const key = cycle.join(" -> ")
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function replaceImportSpecifier(content: string, from: string, to: string) {
  const escaped = escapeRegExp(from)
  return content.replace(new RegExp(`(["'])${escaped}\\1`, "g"), (_match, quote: string) => `${quote}${to}${quote}`)
}

function relativeImportSpecifier(fromPath: string, toPath: string) {
  const fromDir = path.posix.dirname(normalizePath(fromPath))
  let relative = path.posix.relative(fromDir, stripImportExtension(normalizePath(toPath))).replace(/\\/g, "/")
  if (!relative.startsWith(".")) relative = `./${relative}`
  return relative
}

function stripImportExtension(filePath: string) {
  return normalizePath(filePath)
    .replace(/\/index\.(tsx?|jsx?|mjs|cjs|json|css)$/i, "")
    .replace(/\.(tsx?|jsx?|mjs|cjs|json|css)$/i, "")
}

function normalizeFiles(files: GeneratedFile[]) {
  return files.map((file) => ({ ...file, path: normalizePath(file.path), content: String(file.content || "") }))
}

function isSafeGeneratedPath(filePath: string) {
  const normalized = normalizePath(filePath)
  return ALLOWED_GENERATED_ROOT_RE.test(normalized) && !normalized.includes("..") && !normalized.includes("node_modules")
}

function scriptKindForPath(filePath: string) {
  const normalized = filePath.toLowerCase()
  if (normalized.endsWith(".tsx")) return ts.ScriptKind.TSX
  if (normalized.endsWith(".jsx")) return ts.ScriptKind.JSX
  if (normalized.endsWith(".js") || normalized.endsWith(".mjs") || normalized.endsWith(".cjs")) return ts.ScriptKind.JS
  return ts.ScriptKind.TS
}

function isIdentifier(value: string) {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(value)
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

function normalizePath(value: string) {
  return String(value || "").replace(/\\/g, "/").replace(/^\/+/, "").replace(/^\.\//, "").trim()
}

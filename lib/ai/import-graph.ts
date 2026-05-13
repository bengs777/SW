import path from "node:path"
import ts from "typescript"
import type { GeneratedFile } from "@/lib/types"

export type ImportKind = "local" | "external" | "unresolved"

export type ImportGraphEdge = {
  source: string
  specifier: string
  kind: ImportKind
  resolvedPath?: string
  packageName?: string
  typeOnly?: boolean
}

export type ImportGraphNode = {
  file: string
  imports: ImportGraphEdge[]
  importedBy: ImportGraphEdge[]
}

export type ImportGraph = {
  nodes: ImportGraphNode[]
  byFile: Map<string, ImportGraphNode>
  externalPackages: string[]
  missingLocalImports: Array<{ file: string; specifier: string; candidates: string[] }>
  localEdges: ImportGraphEdge[]
}

const PARSEABLE_FILE_RE = /\.(tsx?|jsx?|mjs|cjs)$/i
const STYLE_FILE_RE = /\.(css)$/i
const FILE_EXTENSIONS = ["", ".tsx", ".ts", ".jsx", ".js", ".mjs", ".cjs", ".json", ".css", ".prisma", ".md", ".env"]
const INDEX_EXTENSIONS = [".tsx", ".ts", ".jsx", ".js", ".json", ".css"]

export function buildImportGraph(files: GeneratedFile[]): ImportGraph {
  const normalizedFiles = files
    .map((file) => ({
      ...file,
      path: normalizePath(file.path),
      content: String(file.content || ""),
    }))
    .filter((file) => file.path)
    .sort((left, right) => left.path.localeCompare(right.path))
  const fileMap = new Map(normalizedFiles.map((file) => [file.path, file]))
  const byFile = new Map<string, ImportGraphNode>()
  const externalPackages = new Set<string>()
  const missingLocalImports: ImportGraph["missingLocalImports"] = []
  const localEdges: ImportGraphEdge[] = []

  for (const file of normalizedFiles) {
    byFile.set(file.path, {
      file: file.path,
      imports: [],
      importedBy: [],
    })
  }

  for (const file of normalizedFiles) {
    const node = byFile.get(file.path)
    if (!node) continue

    for (const item of collectImportSpecifiers(file)) {
      if (isLocalImport(item.specifier)) {
        const candidates = resolveLocalImportCandidates(file.path, item.specifier)
        const resolvedPath = candidates.find((candidate) => fileMap.has(candidate))
        const edge: ImportGraphEdge = {
          source: file.path,
          specifier: item.specifier,
          kind: resolvedPath ? "local" : "unresolved",
          resolvedPath,
          typeOnly: item.typeOnly || undefined,
        }
        node.imports.push(edge)

        if (resolvedPath) {
          localEdges.push(edge)
          byFile.get(resolvedPath)?.importedBy.push(edge)
        } else {
          missingLocalImports.push({
            file: file.path,
            specifier: item.specifier,
            candidates,
          })
        }
      } else if (!isTypeOnlyVirtualImport(item.specifier)) {
        const packageName = packageRoot(item.specifier)
        externalPackages.add(packageName)
        node.imports.push({
          source: file.path,
          specifier: item.specifier,
          kind: "external",
          packageName,
          typeOnly: item.typeOnly || undefined,
        })
      }
    }
  }

  return {
    nodes: Array.from(byFile.values()).sort((left, right) => left.file.localeCompare(right.file)),
    byFile,
    externalPackages: Array.from(externalPackages).sort(),
    missingLocalImports,
    localEdges,
  }
}

export function getImportGraphNode(graph: ImportGraph, filePath: string) {
  return graph.byFile.get(normalizePath(filePath)) || null
}

export function getDirectImportPaths(graph: ImportGraph, filePath: string) {
  const node = getImportGraphNode(graph, filePath)
  if (!node) return []

  return node.imports
    .map((edge) => edge.resolvedPath)
    .filter((value): value is string => Boolean(value))
    .sort()
}

export function getDirectImporterPaths(graph: ImportGraph, filePath: string) {
  const node = getImportGraphNode(graph, filePath)
  if (!node) return []

  return node.importedBy
    .map((edge) => edge.source)
    .filter(Boolean)
    .sort()
}

export function getTransitiveImpactPaths(
  graph: ImportGraph,
  roots: string[],
  options?: {
    direction?: "imports" | "importedBy" | "both"
    maxDepth?: number
    maxFiles?: number
  }
) {
  const direction = options?.direction || "both"
  const maxDepth = Math.max(1, options?.maxDepth || 2)
  const maxFiles = Math.max(1, options?.maxFiles || 24)
  const visited = new Set<string>()
  const queue = roots.map((root) => ({ path: normalizePath(root), depth: 0 }))

  while (queue.length > 0 && visited.size < maxFiles) {
    const current = queue.shift()
    if (!current || visited.has(current.path)) continue
    visited.add(current.path)
    if (current.depth >= maxDepth) continue

    const next = new Set<string>()
    if (direction === "imports" || direction === "both") {
      for (const imported of getDirectImportPaths(graph, current.path)) {
        next.add(imported)
      }
    }
    if (direction === "importedBy" || direction === "both") {
      for (const importer of getDirectImporterPaths(graph, current.path)) {
        next.add(importer)
      }
    }

    for (const nextPath of Array.from(next).sort()) {
      if (!visited.has(nextPath)) {
        queue.push({ path: nextPath, depth: current.depth + 1 })
      }
    }
  }

  return Array.from(visited).sort()
}

function collectImportSpecifiers(file: { path: string; content: string }) {
  if (PARSEABLE_FILE_RE.test(file.path)) {
    return collectTypeScriptImports(file.path, file.content)
  }

  if (STYLE_FILE_RE.test(file.path)) {
    return collectStyleImports(file.content)
  }

  return []
}

function collectTypeScriptImports(filePath: string, content: string) {
  const sourceFile = ts.createSourceFile(
    filePath,
    content,
    ts.ScriptTarget.Latest,
    true,
    scriptKindForPath(filePath)
  )
  const imports: Array<{ specifier: string; typeOnly?: boolean }> = []

  const addSpecifier = (specifier: unknown, typeOnly?: boolean) => {
    if (typeof specifier === "string" && specifier.trim()) {
      imports.push({ specifier: specifier.trim(), typeOnly })
    }
  }

  const visit = (node: ts.Node) => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteralLike(node.moduleSpecifier)) {
      addSpecifier(node.moduleSpecifier.text, Boolean(node.importClause?.isTypeOnly))
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteralLike(node.moduleSpecifier)) {
      addSpecifier(node.moduleSpecifier.text, Boolean(node.isTypeOnly))
    } else if (ts.isImportTypeNode(node)) {
      const argument = node.argument
      if (
        ts.isLiteralTypeNode(argument) &&
        ts.isStringLiteralLike(argument.literal)
      ) {
        addSpecifier(argument.literal.text, true)
      }
    } else if (ts.isCallExpression(node)) {
      const firstArg = node.arguments[0]
      const isDynamicImport = node.expression.kind === ts.SyntaxKind.ImportKeyword
      const isRequire =
        ts.isIdentifier(node.expression) &&
        node.expression.text === "require"
      if ((isDynamicImport || isRequire) && firstArg && ts.isStringLiteralLike(firstArg)) {
        addSpecifier(firstArg.text)
      }
    }

    ts.forEachChild(node, visit)
  }

  visit(sourceFile)
  return dedupeImports(imports)
}

function collectStyleImports(content: string) {
  const imports: Array<{ specifier: string; typeOnly?: boolean }> = []
  const importRe = /@import\s+(?:url\()?["']([^"')]+)["']\)?/g

  for (const match of content.matchAll(importRe)) {
    if (match[1]) {
      imports.push({ specifier: match[1].trim() })
    }
  }

  return dedupeImports(imports)
}

function dedupeImports(imports: Array<{ specifier: string; typeOnly?: boolean }>) {
  const seen = new Set<string>()
  const output: Array<{ specifier: string; typeOnly?: boolean }> = []

  for (const item of imports) {
    const key = `${item.specifier}:${item.typeOnly ? "type" : "value"}`
    if (seen.has(key)) continue
    seen.add(key)
    output.push(item)
  }

  return output
}

function resolveLocalImportCandidates(fromPath: string, specifier: string) {
  const normalizedSpecifier = specifier.replace(/\\/g, "/")
  const base =
    normalizedSpecifier.startsWith("@/") || normalizedSpecifier.startsWith("~/")
      ? normalizedSpecifier.slice(2)
      : path.posix.normalize(path.posix.join(path.posix.dirname(normalizePath(fromPath)), normalizedSpecifier))
  const normalizedBase = normalizePath(base)
  const candidates = new Set<string>()

  for (const extension of FILE_EXTENSIONS) {
    candidates.add(normalizePath(`${normalizedBase}${extension}`))
  }
  for (const extension of INDEX_EXTENSIONS) {
    candidates.add(normalizePath(path.posix.join(normalizedBase, `index${extension}`)))
  }

  return Array.from(candidates)
}

function scriptKindForPath(filePath: string) {
  const normalized = filePath.toLowerCase()
  if (normalized.endsWith(".tsx")) return ts.ScriptKind.TSX
  if (normalized.endsWith(".jsx")) return ts.ScriptKind.JSX
  if (normalized.endsWith(".json")) return ts.ScriptKind.JSON
  if (normalized.endsWith(".js") || normalized.endsWith(".mjs") || normalized.endsWith(".cjs")) {
    return ts.ScriptKind.JS
  }
  return ts.ScriptKind.TS
}

function isLocalImport(specifier: string) {
  return specifier.startsWith(".") || specifier.startsWith("@/") || specifier.startsWith("~/") || specifier.startsWith("/")
}

function isTypeOnlyVirtualImport(specifier: string) {
  return specifier.startsWith("node:")
}

function packageRoot(specifier: string) {
  if (specifier.startsWith("@")) {
    return specifier.split("/").slice(0, 2).join("/")
  }
  return specifier.split("/")[0] || specifier
}

function normalizePath(value: string) {
  return String(value || "").replace(/\\/g, "/").replace(/^\/+/, "").replace(/^\.\//, "").trim()
}

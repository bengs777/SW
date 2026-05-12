import { createHash } from "node:crypto"
import type { GeneratedFile } from "@/lib/types"
import { buildDependencyMap } from "@/lib/ai/generation-pipeline"
import { analyzeNextJsIntegrity, type NextJsIntegrityIssue } from "@/lib/ai/nextjs-integrity"

export type ArtifactIntegritySeverity = "error" | "warning"

export type ArtifactIntegrityIssue = {
  code: string
  severity: ArtifactIntegritySeverity
  message: string
  filePath?: string | null
  data?: Record<string, unknown>
}

export type ArtifactFileManifestEntry = {
  path: string
  language: GeneratedFile["language"]
  bytes: number
  sha256: string
}

export type ArtifactDependencyEdge = {
  from: string
  to: string
  specifier: string
}

export type ArtifactManifest = {
  schemaVersion: 1
  artifactHash: string
  fileCount: number
  totalBytes: number
  files: ArtifactFileManifestEntry[]
  dependencyGraph: {
    localEdges: ArtifactDependencyEdge[]
    externalPackages: string[]
    routePaths: string[]
    apiRoutes: string[]
  }
  buildInputs: {
    promptHash: string
    projectIdHash: string
  }
  generatedAt: string
}

export type ArtifactIntegrityResult = {
  ok: boolean
  manifest: ArtifactManifest
  issues: ArtifactIntegrityIssue[]
  nextJsIssues: NextJsIntegrityIssue[]
}

const MANIFEST_VERSION = "swift-artifact-manifest-v1"
const ROUTE_GROUP_RE = /^\(.+\)$/
const HTTP_METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"])

export function buildArtifactManifest(input: {
  projectId: string
  prompt: string
  files: GeneratedFile[]
}): ArtifactManifest {
  const normalizedFiles = normalizeFiles(input.files)
  const dependencyMap = buildDependencyMap(normalizedFiles)
  const fileEntries = normalizedFiles.map((file) => {
    const content = String(file.content || "")
    return {
      path: file.path,
      language: file.language,
      bytes: Buffer.byteLength(content, "utf8"),
      sha256: sha256(content),
    }
  })
  const totalBytes = fileEntries.reduce((sum, file) => sum + file.bytes, 0)
  const localEdges = dependencyMap.localImports
    .filter((edge): edge is typeof edge & { resolvedPath: string } => Boolean(edge.resolvedPath))
    .map((edge) => ({
      from: normalizePath(edge.file),
      to: normalizePath(edge.resolvedPath),
      specifier: edge.specifier,
    }))

  const hash = createHash("sha256")
  hash.update(MANIFEST_VERSION)
  hash.update("\0")
  for (const file of fileEntries) {
    hash.update(file.path)
    hash.update("\0")
    hash.update(file.sha256)
    hash.update("\0")
  }
  for (const edge of localEdges) {
    hash.update(`${edge.from}->${edge.to}:${edge.specifier}`)
    hash.update("\0")
  }

  return {
    schemaVersion: 1,
    artifactHash: hash.digest("hex"),
    fileCount: fileEntries.length,
    totalBytes,
    files: fileEntries,
    dependencyGraph: {
      localEdges,
      externalPackages: dependencyMap.externalPackages,
      routePaths: normalizedFiles.map((file) => routePathForPage(file.path)).filter((value): value is string => Boolean(value)),
      apiRoutes: normalizedFiles.map((file) => routePathForApi(file.path)).filter((value): value is string => Boolean(value)),
    },
    buildInputs: {
      promptHash: sha256(input.prompt),
      projectIdHash: sha256(input.projectId),
    },
    generatedAt: new Date(0).toISOString(),
  }
}

export function validateArtifactIntegrity(input: {
  projectId: string
  prompt: string
  files: GeneratedFile[]
}): ArtifactIntegrityResult {
  const files = normalizeFiles(input.files)
  const issues: ArtifactIntegrityIssue[] = []
  const manifest = buildArtifactManifest({ ...input, files })
  const dependencyMap = buildDependencyMap(files)
  const fileByPath = new Map(files.map((file) => [file.path, file]))

  for (const duplicate of findDuplicatePaths(input.files)) {
    issues.push({
      code: "artifact.duplicate_path",
      severity: "error",
      message: `Duplicate generated file path: ${duplicate}`,
      filePath: duplicate,
    })
  }

  if (files.length === 0) {
    issues.push({
      code: "artifact.empty",
      severity: "error",
      message: "Artifact contains no files.",
    })
  }

  for (const item of dependencyMap.missingLocalImports) {
    issues.push({
      code: "dependency.missing_local_import",
      severity: "error",
      message: `Missing local import ${item.specifier} from ${item.file}`,
      filePath: item.file,
      data: { candidates: item.candidates },
    })
  }

  for (const item of dependencyMap.unsupportedPreviewImports) {
    issues.push({
      code: "dependency.unsupported_preview_import",
      severity: "error",
      message: `${item.specifier} is not supported in browser preview: ${item.reason}`,
      filePath: item.file,
      data: { specifier: item.specifier, reason: item.reason },
    })
  }

  for (const cycle of findCircularDependencies(manifest.dependencyGraph.localEdges)) {
    issues.push({
      code: "dependency.circular",
      severity: "error",
      message: `Circular dependency detected: ${cycle.join(" -> ")}`,
      filePath: cycle[0] || null,
      data: { cycle },
    })
  }

  for (const issue of validateRoutes(files)) {
    issues.push(issue)
  }

  for (const issue of validatePackageJson(files)) {
    issues.push(issue)
  }

  for (const orphan of findOrphanFiles(files, manifest.dependencyGraph.localEdges)) {
    issues.push({
      code: "artifact.orphan_file",
      severity: "warning",
      message: `File is not reachable from a route or known entrypoint: ${orphan}`,
      filePath: orphan,
    })
  }

  const nextJsIssues = analyzeNextJsIntegrity(files)
  for (const issue of nextJsIssues) {
    issues.push({
      code: `nextjs.${issue.code}`,
      severity: issue.severity,
      message: issue.message,
      filePath: issue.filePath,
      data: issue.data,
    })
  }

  return {
    ok: issues.every((issue) => issue.severity !== "error"),
    manifest,
    issues,
    nextJsIssues,
  }
}

export function normalizeArtifactFiles(files: GeneratedFile[]) {
  return normalizeFiles(files)
}

function normalizeFiles(files: GeneratedFile[]) {
  const fileMap = new Map<string, GeneratedFile>()
  for (const file of files) {
    const normalizedPath = normalizePath(file.path)
    if (!normalizedPath) continue
    fileMap.set(normalizedPath, {
      ...file,
      path: normalizedPath,
      content: String(file.content || ""),
    })
  }

  return Array.from(fileMap.values()).sort((left, right) => left.path.localeCompare(right.path))
}

function findDuplicatePaths(files: GeneratedFile[]) {
  const seen = new Set<string>()
  const duplicates = new Set<string>()
  for (const file of files) {
    const normalized = normalizePath(file.path)
    if (seen.has(normalized)) {
      duplicates.add(normalized)
    }
    seen.add(normalized)
  }
  return Array.from(duplicates)
}

function validateRoutes(files: GeneratedFile[]): ArtifactIntegrityIssue[] {
  const issues: ArtifactIntegrityIssue[] = []
  for (const file of files) {
    if (/^app\/(?:.+\/)?page\.(tsx|ts|jsx|js)$/i.test(file.path)) {
      if (!/export\s+default\s+/.test(file.content)) {
        issues.push({
          code: "route.invalid_page_export",
          severity: "error",
          message: "App Router page files must export a default component.",
          filePath: file.path,
        })
      }
    }

    if (/^app\/(?:.+\/)?layout\.(tsx|ts|jsx|js)$/i.test(file.path)) {
      if (!/export\s+default\s+/.test(file.content)) {
        issues.push({
          code: "route.invalid_layout_export",
          severity: "error",
          message: "App Router layout files must export a default component.",
          filePath: file.path,
        })
      }
    }

    if (/^app\/api\/.+\/route\.(ts|js)$/i.test(file.path)) {
      const exportedMethods = Array.from(file.content.matchAll(/export\s+(?:async\s+)?function\s+([A-Z]+)\s*\(/g))
        .map((match) => match[1])
      if (/export\s+default\s+/.test(file.content)) {
        issues.push({
          code: "route.default_export_in_route_handler",
          severity: "error",
          message: "Route handlers must use named HTTP method exports, not default exports.",
          filePath: file.path,
        })
      }
      if (exportedMethods.length === 0) {
        issues.push({
          code: "route.missing_http_method",
          severity: "error",
          message: "API route handler has no exported HTTP method.",
          filePath: file.path,
        })
      }
      for (const method of exportedMethods) {
        if (!HTTP_METHODS.has(method)) {
          issues.push({
            code: "route.invalid_http_method",
            severity: "error",
            message: `Invalid route handler export: ${method}`,
            filePath: file.path,
          })
        }
      }
    }
  }
  return issues
}

function validatePackageJson(files: GeneratedFile[]): ArtifactIntegrityIssue[] {
  const packageFile = files.find((file) => file.path === "package.json")
  if (!packageFile) return []

  try {
    const parsed = JSON.parse(packageFile.content) as {
      dependencies?: Record<string, unknown>
      devDependencies?: Record<string, unknown>
    }
    const deps = parsed.dependencies || {}
    const devDeps = parsed.devDependencies || {}
    return Object.keys(deps)
      .filter((name) => Object.prototype.hasOwnProperty.call(devDeps, name))
      .map((name) => ({
        code: "dependency.duplicate_dependency",
        severity: "error" as const,
        message: `Package is declared in both dependencies and devDependencies: ${name}`,
        filePath: packageFile.path,
        data: { packageName: name },
      }))
  } catch (error) {
    return [{
      code: "artifact.invalid_package_json",
      severity: "error",
      message: error instanceof Error ? error.message : "Invalid package.json",
      filePath: packageFile.path,
    }]
  }
}

function findCircularDependencies(edges: ArtifactDependencyEdge[]) {
  const graph = new Map<string, string[]>()
  for (const edge of edges) {
    const existing = graph.get(edge.from) || []
    existing.push(edge.to)
    graph.set(edge.from, existing)
  }

  const cycles: string[][] = []
  const visiting = new Set<string>()
  const visited = new Set<string>()
  const stack: string[] = []

  const visit = (node: string) => {
    if (visiting.has(node)) {
      const index = stack.indexOf(node)
      cycles.push([...stack.slice(Math.max(0, index)), node])
      return
    }
    if (visited.has(node)) return

    visiting.add(node)
    stack.push(node)
    for (const next of graph.get(node) || []) {
      visit(next)
    }
    stack.pop()
    visiting.delete(node)
    visited.add(node)
  }

  for (const node of graph.keys()) {
    visit(node)
  }

  return dedupeCycles(cycles)
}

function findOrphanFiles(files: GeneratedFile[], edges: ArtifactDependencyEdge[]) {
  const roots = files
    .map((file) => file.path)
    .filter((filePath) =>
      /^app\/(?:.+\/)?(page|layout|route)\.(tsx|ts|jsx|js)$/i.test(filePath) ||
      filePath === "middleware.ts" ||
      filePath === "proxy.ts" ||
      filePath === "package.json" ||
      filePath === "tsconfig.json" ||
      filePath === "next.config.js" ||
      filePath === "next.config.mjs" ||
      filePath === "postcss.config.mjs" ||
      filePath.endsWith(".css") ||
      filePath.startsWith("prisma/")
    )
  const graph = new Map<string, string[]>()
  for (const edge of edges) {
    const list = graph.get(edge.from) || []
    list.push(edge.to)
    graph.set(edge.from, list)
  }
  const reachable = new Set<string>()
  const visit = (path: string) => {
    if (reachable.has(path)) return
    reachable.add(path)
    for (const next of graph.get(path) || []) {
      visit(next)
    }
  }
  for (const root of roots) {
    visit(root)
  }

  return files
    .filter((file) => /\.(tsx?|jsx?)$/i.test(file.path))
    .map((file) => file.path)
    .filter((filePath) => !reachable.has(filePath))
}

function routePathForPage(filePath: string) {
  const match = normalizePath(filePath).match(/^app\/(.+\/)?page\.(tsx|ts|jsx|js)$/i)
  if (!match) return null
  const parts = (match[1] || "")
    .split("/")
    .filter(Boolean)
    .filter((part) => !ROUTE_GROUP_RE.test(part))
    .filter((part) => !part.startsWith("@"))
    .map((part) => part.replace(/^\((\.)+\)/, ""))
  if (parts.some((part) => part.includes("[") || part.includes("]"))) return null
  return `/${parts.join("/")}`.replace(/\/+$/, "") || "/"
}

function routePathForApi(filePath: string) {
  const match = normalizePath(filePath).match(/^app\/api\/(.+)\/route\.(ts|js)$/i)
  if (!match) return null
  if (match[1].includes("[") || match[1].includes("]")) return null
  return `/api/${match[1]}`
}

function dedupeCycles(cycles: string[][]) {
  const seen = new Set<string>()
  return cycles.filter((cycle) => {
    const key = cycle.join("->")
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex")
}

function normalizePath(value: string) {
  return String(value || "").replace(/\\/g, "/").replace(/^\/+/, "").replace(/^\.\//, "").trim()
}

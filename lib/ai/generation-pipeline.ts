import type { GeneratedFile } from "@/lib/types"
import { buildImportGraph } from "@/lib/ai/import-graph"
import {
  SWIFT_BUILDER_MODEL_KEY,
  SWIFT_PROVIDER,
  type SwiftTierKey,
} from "@/lib/ai/swift-tiers"
import { analyzePromptIntent } from "@/lib/ai/intent-analyzer"
import { isHardFrontendOnlyPrompt } from "@/lib/ai/architecture-intent"
import type { CollaborationMode } from "@/lib/ai/collaboration-mode"

export type PromptClassification =
  | "simple_ui"
  | "dashboard"
  | "fullstack_app"
  | "architecture"
  | "repair"
  | "refactor"
  | "runtime_debug"
  | "component_edit"

export type GenerationLayer = "fast" | "builder" | "premium-repair"
export type RoutingPurpose = "generate" | "inspect" | "repair"

export type ComplexityScore = {
  score: number
  band: "low" | "medium" | "high"
  reasons: string[]
}

export type ModelRoutingDecision = {
  provider: typeof SWIFT_PROVIDER
  modelName: SwiftTierKey
  layer: GenerationLayer
  classification: PromptClassification
  complexity: ComplexityScore
  reason: string
  maxAutomaticRepairAttempts: number
  premiumEscalationAllowed: boolean
}

export type ContextBudget = {
  maxFiles: number
  maxCharsPerFile: number
  maxTotalChars: number
}

export type DependencyMap = {
  localImports: Array<{ file: string; specifier: string; resolvedPath?: string; missing?: boolean }>
  externalPackages: string[]
  missingLocalImports: Array<{ file: string; specifier: string; candidates: string[] }>
  unsupportedPreviewImports: Array<{ file: string; specifier: string; reason: string }>
}

export type DependencySourceKind = "file_import" | "task_graph_operation" | "explicit_dependency" | "artifact_signal"

export type DependencySource = {
  packageName: string
  sourceFile: string
  specifier: string
  kind: DependencySourceKind
}

export type TrimmedContext = {
  files: GeneratedFile[]
  dependencyMap: DependencyMap
  omittedFileCount: number
  totalChars: number
  budget: ContextBudget
}

export const MAX_AUTOMATIC_REPAIR_ATTEMPTS = 2

export const PACKAGE_VERSION_ALLOWLIST: Record<string, string> = {
  next: "16.2.6",
  react: "19.2.5",
  "react-dom": "19.2.5",
  typescript: "5.7.3",
  "lucide-react": "^0.564.0",
  clsx: "^2.1.1",
  "tailwind-merge": "^3.3.1",
  "class-variance-authority": "^0.7.1",
  zod: "^3.24.1",
  "@prisma/client": "^5.22.0",
  prisma: "^5.22.0",
  "next-auth": "^5.0.0-beta.20",
  "react-hook-form": "^7.54.1",
  "@hookform/resolvers": "^3.9.1",
  "@supabase/supabase-js": "^2.104.0",
  "@libsql/client": "^0.15.15",
  axios: "^1.7.9",
  bcryptjs: "^3.0.3",
  recharts: "2.15.0",
  "date-fns": "4.1.0",
  sonner: "^1.7.1",
  "@tailwindcss/postcss": "^4.2.0",
  "@types/node": "^22",
  "@types/react": "19.2.14",
  "@types/react-dom": "19.2.3",
  autoprefixer: "^10.4.20",
  postcss: "8.5.14",
  tailwindcss: "^4.2.0",
  "@radix-ui/react-slot": "1.2.4",
  "@radix-ui/react-tabs": "1.1.13",
  "@radix-ui/react-dialog": "1.1.15",
  "@radix-ui/react-dropdown-menu": "2.1.16",
  "@radix-ui/react-select": "2.2.6",
  "@radix-ui/react-popover": "1.1.15",
  "@radix-ui/react-toast": "1.2.15",
  "@radix-ui/react-label": "2.1.8",
  "@radix-ui/react-avatar": "1.1.11",
  "@radix-ui/react-alert-dialog": "1.1.15",
  "@radix-ui/react-checkbox": "1.3.3",
  "@radix-ui/react-collapsible": "1.1.12",
  "@radix-ui/react-context-menu": "2.2.16",
  "@radix-ui/react-hover-card": "1.1.15",
  "@radix-ui/react-menubar": "1.1.16",
  "@radix-ui/react-navigation-menu": "1.2.14",
  "@radix-ui/react-progress": "1.1.8",
  "@radix-ui/react-radio-group": "1.3.8",
  "@radix-ui/react-scroll-area": "1.2.10",
  "@radix-ui/react-separator": "1.1.8",
  "@radix-ui/react-slider": "1.3.6",
  "@radix-ui/react-switch": "1.2.6",
  "@radix-ui/react-toggle": "1.1.10",
  "@radix-ui/react-toggle-group": "1.1.11",
  "@radix-ui/react-tooltip": "1.2.8",
}

export const PACKAGE_DEV_DEPENDENCIES = new Set([
  "@tailwindcss/postcss",
  "@types/node",
  "@types/react",
  "@types/react-dom",
  "autoprefixer",
  "postcss",
  "prisma",
  "tailwindcss",
  "typescript",
])
const BUILTIN_PACKAGES = new Set([
  "assert",
  "buffer",
  "crypto",
  "events",
  "fs",
  "http",
  "https",
  "net",
  "node:assert",
  "node:buffer",
  "node:crypto",
  "node:events",
  "node:fs",
  "node:http",
  "node:https",
  "node:net",
  "node:path",
  "node:stream",
  "node:url",
  "node:util",
  "path",
  "stream",
  "url",
  "util",
])

const DEFAULT_CONTEXT_BUDGETS: Record<GenerationLayer, ContextBudget> = {
  fast: { maxFiles: 10, maxCharsPerFile: 8 * 1024, maxTotalChars: 64 * 1024 },
  builder: { maxFiles: 10, maxCharsPerFile: 8 * 1024, maxTotalChars: 64 * 1024 },
  "premium-repair": { maxFiles: 10, maxCharsPerFile: 8 * 1024, maxTotalChars: 64 * 1024 },
}

const SIMPLE_UI_RE =
  /\b(hero|landing|section|tailwind|component|button|card|copy|headline|pricing section|testimonial|navbar|footer|ubah warna|ganti teks|format|autocomplete)\b/i
const DASHBOARD_RE = /\b(dashboard|admin|analytics|chart|metric|table|kanban|workspace|panel)\b/i
const FULLSTACK_RE =
  /\b(full\s*stack|fullstack|full-stack|saas|crud|database|postgres|postgresql|prisma|auth|login|register|api route|route handler|backend|webhook|payment|stripe|pakasir|role|rbac|bpjs|integrasi|integration|pengelola|dokter|pasien)\b/i
const ARCH_RE = /\b(architecture|arsitektur|design system|multi-file|multi module|plan|roadmap|schema|data model|refactor besar)\b/i
const REPAIR_RE = /\b(fix|repair|perbaiki|error|bug|crash|failed|gagal|module not found|cannot find module|jsx-runtime|runtime|stack trace)\b/i
const REFACTOR_RE = /\b(refactor|rewrite|migrate|cleanup|restructure|split files|large edit|ubah struktur)\b/i
const COMPONENT_EDIT_RE = /\b(edit component|component edit|ubah komponen|update component|small edit|minor edit)\b/i
const PREMIUM_REPAIR_RE =
  /\b(repeated|berulang|persist|persistent|dependency graph|build error|preview crash|runtime crash|cannot resolve|module not found|jsx-runtime|react module)\b/i
const LARGE_GENERATION_RE =
  /\b(full\s*stack|fullstack|full-stack|multi-file|multi file|multi module|production|deployable|crud|database|postgres|postgresql|prisma|auth|login|register|api route|route handler|backend|webhook|payment|stripe|pakasir|role|rbac|bpjs|integrasi|integration|admin|pengelola|staff)\b/i

const UNSUPPORTED_PREVIEW_IMPORTS = new Map<string, string>([
  ["fs", "Node filesystem APIs cannot run in the browser preview."],
  ["node:fs", "Node filesystem APIs cannot run in the browser preview."],
  ["path", "Node path APIs cannot run in the browser preview."],
  ["node:path", "Node path APIs cannot run in the browser preview."],
  ["child_process", "Process APIs cannot run in the browser preview."],
  ["next/headers", "next/headers is server-only."],
  ["next/server", "Route handler helpers are server-only."],
  ["@prisma/client", "Prisma must stay on the server."],
])

const IMPORT_SPECIFIER_RE =
  /(?:import\s+(?:type\s+)?[\s\S]*?\s+from\s+["']([^"']+)["']|import\s*["']([^"']+)["']|import\s*\(\s*["']([^"']+)["']\s*\)|require\s*\(\s*["']([^"']+)["']\s*\)|export\s+[\s\S]*?\s+from\s+["']([^"']+)["'])/g

export function classifyPrompt(
  prompt: string,
  input?: {
    collaborationMode?: CollaborationMode
    previewError?: string | null
    existingFiles?: GeneratedFile[]
  }
): PromptClassification {
  const text = `${prompt}\n${input?.previewError || ""}`.toLowerCase()
  const intent = analyzePromptIntent(prompt)
  const hasExistingProject = (input?.existingFiles?.length || 0) > 0
  const hardFrontendOnly = isHardFrontendOnlyPrompt(prompt)
  const backendIntent = intent.requiredCapabilities.some((capability) =>
    /api|prisma|model|admin|crud|management|persistence|route|service/i.test(capability)
  )

  if (input?.collaborationMode === "fix" && input.previewError) return "runtime_debug"
  if (hardFrontendOnly) return hasExistingProject ? "component_edit" : "simple_ui"
  if (PREMIUM_REPAIR_RE.test(text) && REPAIR_RE.test(text)) return "runtime_debug"
  if (REPAIR_RE.test(text)) return "repair"
  if (REFACTOR_RE.test(text)) return "refactor"
  if (FULLSTACK_RE.test(text) || (backendIntent && LARGE_GENERATION_RE.test(text))) return "fullstack_app"
  if (ARCH_RE.test(text)) return "architecture"
  if (DASHBOARD_RE.test(text)) return "dashboard"
  if (COMPONENT_EDIT_RE.test(text)) return "component_edit"
  if (SIMPLE_UI_RE.test(text)) return "simple_ui"

  if (hasExistingProject) return "component_edit"
  return backendIntent ? "fullstack_app" : "simple_ui"
}

export function scorePromptComplexity(
  prompt: string,
  input?: {
    classification?: PromptClassification
    existingFiles?: GeneratedFile[]
    previewError?: string | null
    attachmentCount?: number
  }
): ComplexityScore {
  const reasons: string[] = []
  let score = 0
  const text = `${prompt}\n${input?.previewError || ""}`.toLowerCase()
  const classification = input?.classification || classifyPrompt(prompt, input)

  score += Math.min(30, Math.ceil(prompt.length / 500))
  if (prompt.length > 6000) reasons.push("long_prompt")

  const fileCount = input?.existingFiles?.length || 0
  if (fileCount > 0) {
    score += Math.min(25, Math.ceil(fileCount / 5) * 4)
    reasons.push("existing_project")
  }

  if (input?.attachmentCount) {
    score += Math.min(12, input.attachmentCount * 3)
    reasons.push("attachments")
  }

  const classWeight: Record<PromptClassification, number> = {
    simple_ui: 8,
    component_edit: 10,
    dashboard: 28,
    fullstack_app: 48,
    architecture: 55,
    repair: 32,
    refactor: 45,
    runtime_debug: 50,
  }
  score += classWeight[classification]
  reasons.push(classification)

  if (/\b(auth|prisma|postgres|api|webhook|payment|queue|cron|middleware|schema)\b/.test(text)) {
    score += 16
    reasons.push("backend_or_dependency_work")
  }

  if (/\b(module not found|cannot find module|build failed|jsx-runtime|stack trace|runtime crash)\b/.test(text)) {
    score += 20
    reasons.push("runtime_failure")
  }

  const boundedScore = Math.max(0, Math.min(100, score))
  const band = boundedScore >= 65 ? "high" : boundedScore >= 32 ? "medium" : "low"

  return {
    score: boundedScore,
    band,
    reasons: Array.from(new Set(reasons)),
  }
}

export function routeModelForRequest(input: {
  prompt: string
  purpose?: RoutingPurpose
  classification?: PromptClassification
  existingFiles?: GeneratedFile[]
  previewError?: string | null
  attachmentCount?: number
  repairAttempt?: number
  allowPremiumEscalation?: boolean
}): ModelRoutingDecision {
  const purpose = input.purpose || "generate"
  const classification = input.classification || classifyPrompt(input.prompt, input)
  const complexity = scorePromptComplexity(input.prompt, {
    classification,
    existingFiles: input.existingFiles,
    previewError: input.previewError,
    attachmentCount: input.attachmentCount,
  })
  const repairAttempt = input.repairAttempt ?? 0
  const reasonPrefix =
    purpose === "repair"
      ? repairAttempt <= 0
        ? "single_orchestrator_repair"
        : "single_orchestrator_repair_retry"
      : purpose === "inspect"
        ? "single_orchestrator_inspect"
        : "single_orchestrator_generate"

  return buildDecision(
    "builder",
    SWIFT_BUILDER_MODEL_KEY,
    classification,
    complexity,
    `${reasonPrefix}:${classification}:${complexity.band}`,
    false
  )
}

export function trimContextForGeneration(input: {
  prompt: string
  files: GeneratedFile[]
  activeFilePath?: string | null
  previewErrorFile?: string | null
  layer?: GenerationLayer
  budget?: Partial<ContextBudget>
}): TrimmedContext {
  const layer = input.layer || "builder"
  const budget = {
    ...DEFAULT_CONTEXT_BUDGETS[layer],
    ...(input.budget || {}),
  }
  const dependencyMap = buildDependencyMap(input.files)
  const terms = extractTerms(input.prompt)
  const activePath = normalizePath(input.activeFilePath || "")
  const errorPath = normalizePath(input.previewErrorFile || "")
  const fileByPath = new Map(input.files.map((file) => [normalizePath(file.path), file]))
  const dependentPaths = new Set<string>()

  for (const item of dependencyMap.localImports) {
    if (item.resolvedPath) {
      dependentPaths.add(normalizePath(item.resolvedPath))
    }
  }

  const ranked = input.files
    .map((file) => ({
      file,
      score: scoreFileRelevance(file, { terms, activePath, errorPath, dependentPaths }),
    }))
    .filter((entry) => entry.score > 0 || input.files.length <= budget.maxFiles)
    .sort((left, right) => {
      if (left.score !== right.score) return right.score - left.score
      return left.file.path.localeCompare(right.file.path)
    })

  const selected: GeneratedFile[] = []
  let totalChars = 0

  for (const entry of ranked) {
    if (selected.length >= budget.maxFiles) break

    const original = fileByPath.get(normalizePath(entry.file.path)) || entry.file
    const content = trimFileContent(original.content, budget.maxCharsPerFile)
    if (totalChars + content.length > budget.maxTotalChars) continue

    selected.push({ ...original, content })
    totalChars += content.length
  }

  return {
    files: selected,
    dependencyMap,
    omittedFileCount: Math.max(0, input.files.length - selected.length),
    totalChars,
    budget,
  }
}

export function buildDependencyMap(files: GeneratedFile[]): DependencyMap {
  const graph = buildImportGraph(files)
  const localImports: DependencyMap["localImports"] = []
  const unsupportedPreviewImports: DependencyMap["unsupportedPreviewImports"] = []

  for (const node of graph.nodes) {
    for (const edge of node.imports) {
      const unsupportedReason = isBrowserPreviewFile(node.file) ? unsupportedPreviewReason(edge.specifier) : null
      if (unsupportedReason) {
        unsupportedPreviewImports.push({ file: node.file, specifier: edge.specifier, reason: unsupportedReason })
      }

      if (edge.kind === "local" || edge.kind === "unresolved") {
        localImports.push({
          file: node.file,
          specifier: edge.specifier,
          resolvedPath: edge.resolvedPath,
          missing: !edge.resolvedPath,
        })
      }
    }
  }

  return {
    localImports,
    externalPackages: graph.externalPackages,
    missingLocalImports: graph.missingLocalImports,
    unsupportedPreviewImports,
  }
}

export function normalizeGeneratedDependencies(files: GeneratedFile[]): {
  files: GeneratedFile[]
  addedPackages: string[]
  normalizedPackages: string[]
  conflictsPrevented: string[]
  detectedSources: DependencySource[]
  rejectedPackages: Array<{ packageName: string; sourceFile: string; specifier: string; reason: string }>
  finalManifest: {
    dependencies: Record<string, string>
    devDependencies: Record<string, string>
  }
} {
  const dependencyMap = buildDependencyMap(files)
  const scannedDependencies = collectInstallableDependencies({
    files,
    explicitDependencies: dependencyMap.externalPackages,
  })
  const packagePath = findPackageJsonPath(files)
  const packageFile = packagePath ? files.find((file) => normalizePath(file.path) === packagePath) || null : null
  const packageJson = parsePackageJson(packageFile?.content)
  const addedPackages: string[] = []
  const normalizedPackages: string[] = []
  const conflictsPrevented: string[] = []
  const rejectedPackages: Array<{ packageName: string; sourceFile: string; specifier: string; reason: string }> = []

  packageJson.dependencies = filterAllowedPackageRecord(packageJson.dependencies)
  packageJson.devDependencies = filterAllowedPackageRecord(packageJson.devDependencies)
  packageJson.scripts = {
    dev: "next dev",
    build: "next build",
    start: "next start",
  }

  for (const source of scannedDependencies.sources) {
    const packageName = source.packageName
    if (BUILTIN_PACKAGES.has(packageName) || packageName.startsWith("@/") || packageName.startsWith(".")) continue

    const version = PACKAGE_VERSION_ALLOWLIST[packageName]
    if (!version) {
      rejectedPackages.push({
        packageName,
        sourceFile: source.sourceFile,
        specifier: source.specifier,
        reason: "not_in_package_allowlist",
      })
      continue
    }

    installPackage({
      packageJson,
      packageName,
      version,
      addedPackages,
      normalizedPackages,
      conflictsPrevented,
    })
  }

  for (const [packageName, version] of Object.entries(PACKAGE_VERSION_ALLOWLIST)) {
    const target = PACKAGE_DEV_DEPENDENCIES.has(packageName) ? packageJson.devDependencies : packageJson.dependencies
    if (target?.[packageName] && shouldNormalizeVersion(packageName, target[packageName])) {
      target[packageName] = version
      normalizedPackages.push(packageName)
    }
  }

  const nextPackageFile: GeneratedFile = {
    path: packagePath || "package.json",
    language: "json",
    content: `${JSON.stringify(packageJson, null, 2)}\n`,
  }
  const output = files.filter((file) => normalizePath(file.path) !== normalizePath(nextPackageFile.path))

  return {
    files: [...output, nextPackageFile].sort((left, right) => normalizePath(left.path).localeCompare(normalizePath(right.path))),
    addedPackages: Array.from(new Set(addedPackages)).sort(),
    normalizedPackages: Array.from(new Set(normalizedPackages)).sort(),
    conflictsPrevented: Array.from(new Set(conflictsPrevented)).sort(),
    detectedSources: scannedDependencies.sources,
    rejectedPackages,
    finalManifest: {
      dependencies: { ...packageJson.dependencies },
      devDependencies: { ...packageJson.devDependencies },
    },
  }
}

export function collectInstallableDependencies(input: {
  files: GeneratedFile[]
  taskGraph?: {
    dependencies?: string[]
    operations?: Array<{ action: string; path: string; content?: string | null }>
  } | null
  explicitDependencies?: string[]
  expandedPaths?: string[]
}): {
  sources: DependencySource[]
  rejected: Array<{ packageName: string; sourceFile: string; specifier: string; reason: string }>
} {
  const sources: DependencySource[] = []
  const rejected: Array<{ packageName: string; sourceFile: string; specifier: string; reason: string }> = []
  const seen = new Set<string>()
  const expandedPaths = new Set((input.expandedPaths || []).map(normalizePath))

  const addSource = (source: DependencySource) => {
    const packageName = packageRoot(source.packageName || source.specifier)
    if (!packageName || BUILTIN_PACKAGES.has(packageName) || isLocalSpecifier(packageName)) return
    const normalizedSource = {
      ...source,
      packageName,
      sourceFile: normalizePath(source.sourceFile || "unknown"),
    }
    if (expandedPaths.size > 0 && normalizedSource.kind === "file_import" && !expandedPaths.has(normalizedSource.sourceFile)) {
      return
    }
    if (!PACKAGE_VERSION_ALLOWLIST[packageName]) {
      rejected.push({
        packageName,
        sourceFile: normalizedSource.sourceFile,
        specifier: normalizedSource.specifier,
        reason: "not_in_package_allowlist",
      })
      return
    }
    const key = `${normalizedSource.kind}:${normalizedSource.sourceFile}:${packageName}:${normalizedSource.specifier}`
    if (seen.has(key)) return
    seen.add(key)
    sources.push(normalizedSource)
  }

  const graph = buildImportGraph(input.files)
  for (const node of graph.nodes) {
    for (const edge of node.imports) {
      if (edge.kind !== "external") continue
      addSource({
        packageName: edge.packageName || packageRoot(edge.specifier),
        sourceFile: node.file,
        specifier: edge.specifier,
        kind: "file_import",
      })
    }
  }

  for (const file of input.files) {
    for (const specifier of extractImportSpecifiers(String(file.content || ""))) {
      if (isLocalSpecifier(specifier)) continue
      addSource({
        packageName: packageRoot(specifier),
        sourceFile: file.path,
        specifier,
        kind: "file_import",
      })
    }
  }

  for (const operation of input.taskGraph?.operations || []) {
    if (operation.action === "delete" || typeof operation.content !== "string") continue
    for (const specifier of extractImportSpecifiers(operation.content)) {
      if (isLocalSpecifier(specifier)) continue
      addSource({
        packageName: packageRoot(specifier),
        sourceFile: operation.path,
        specifier,
        kind: "task_graph_operation",
      })
    }
  }

  for (const dependency of [
    ...(input.explicitDependencies || []),
    ...(input.taskGraph?.dependencies || []),
  ]) {
    const packageName = parseDependencyName(dependency)
    addSource({
      packageName,
      sourceFile: "artifact.dependencies",
      specifier: dependency,
      kind: "explicit_dependency",
    })
  }

  if (input.files.some((file) => normalizePath(file.path) === "prisma/schema.prisma")) {
    addSource({
      packageName: "prisma",
      sourceFile: "prisma/schema.prisma",
      specifier: "prisma/schema.prisma",
      kind: "artifact_signal",
    })
    addSource({
      packageName: "@prisma/client",
      sourceFile: "prisma/schema.prisma",
      specifier: "prisma/schema.prisma",
      kind: "artifact_signal",
    })
  }

  return {
    sources: sources.sort((left, right) =>
      `${left.packageName}:${left.sourceFile}`.localeCompare(`${right.packageName}:${right.sourceFile}`)
    ),
    rejected,
  }
}

export function buildStaticValidationPrompt(input: {
  prompt: string
  dependencyMap: DependencyMap
  packageJson?: GeneratedFile | null
  previewError?: string | null
}) {
  return [
    input.prompt,
    "",
    "STATIC_VALIDATION_CONTEXT:",
    JSON.stringify(
      {
        dependencyMap: input.dependencyMap,
        packageJson: input.packageJson
          ? {
              path: input.packageJson.path,
              content: trimFileContent(input.packageJson.content, 2400),
            }
          : null,
        previewError: input.previewError || null,
        rules: [
          "Resolve missing local imports before adding new features.",
          "If adding external imports, update package.json dependencies.",
          "Keep browser preview files free of server-only imports.",
          `Maximum automatic repair attempts: ${MAX_AUTOMATIC_REPAIR_ATTEMPTS}.`,
        ],
      },
      null,
      2
    ),
  ].join("\n")
}

function buildDecision(
  layer: GenerationLayer,
  modelName: SwiftTierKey,
  classification: PromptClassification,
  complexity: ComplexityScore,
  reason: string,
  premiumEscalationAllowed: boolean
): ModelRoutingDecision {
  return {
    provider: SWIFT_PROVIDER,
    modelName,
    layer,
    classification,
    complexity,
    reason,
    maxAutomaticRepairAttempts: MAX_AUTOMATIC_REPAIR_ATTEMPTS,
    premiumEscalationAllowed,
  }
}

function scoreFileRelevance(
  file: GeneratedFile,
  input: {
    terms: string[]
    activePath: string
    errorPath: string
    dependentPaths: Set<string>
  }
) {
  const normalizedPath = normalizePath(file.path)
  const lowerPath = normalizedPath.toLowerCase()
  const searchable = `${lowerPath}\n${String(file.content || "").toLowerCase().slice(0, 10000)}`
  let score = 0

  if (input.activePath && normalizedPath === input.activePath) score += 120
  if (input.errorPath && normalizedPath === input.errorPath) score += 120
  if (input.dependentPaths.has(normalizedPath)) score += 50
  if (/^app\/(?:.+\/)?page\.(tsx|jsx|ts|js)$/i.test(lowerPath)) score += 45
  if (/^app\/layout\.(tsx|jsx|ts|js)$/i.test(lowerPath)) score += 42
  if (/^app\/api\/.+\/route\.ts$/i.test(lowerPath)) score += 36
  if (/^components\//i.test(lowerPath)) score += 30
  if (/^lib\/(db|services|ai|preview)\//i.test(lowerPath)) score += 28
  if (/^(package|tsconfig|next\.config|components)\.json$/i.test(lowerPath)) score += 22
  if (/^prisma\/schema\.prisma$/i.test(lowerPath)) score += 22

  for (const term of input.terms) {
    if (lowerPath.includes(term)) score += 28
    else if (searchable.includes(term)) score += 10
  }

  return score
}

function unsupportedPreviewReason(specifier: string) {
  const root = packageRoot(specifier)
  return UNSUPPORTED_PREVIEW_IMPORTS.get(specifier) || UNSUPPORTED_PREVIEW_IMPORTS.get(root) || null
}

function isBrowserPreviewFile(filePath: string) {
  const normalized = normalizePath(filePath).toLowerCase()
  if (normalized.startsWith("app/api/")) return false
  if (normalized.startsWith("lib/services/")) return false
  if (normalized.startsWith("lib/db/")) return false
  if (normalized === "prisma/schema.prisma") return false
  return /\.(tsx|jsx)$/.test(normalized) || /^app\/(?:.+\/)?page\.(ts|js)$/i.test(normalized)
}

function packageRoot(specifier: string) {
  if (specifier.startsWith("@")) {
    return specifier.split("/").slice(0, 2).join("/")
  }
  return specifier.split("/")[0] || specifier
}

function findPackageJsonPath(files: GeneratedFile[]) {
  return files.map((file) => normalizePath(file.path)).find((filePath) => filePath === "package.json" || filePath.endsWith("/package.json")) || null
}

function parsePackageJson(content: string | null | undefined) {
  try {
    const parsed = JSON.parse(String(content || "{}")) as Record<string, unknown>
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown> & {
        dependencies: Record<string, string>
        devDependencies: Record<string, string>
        scripts: Record<string, string>
      }
    }
  } catch {
    // Fall through to a minimal package.json.
  }

  return {
    name: "swift-generated-app",
    private: true,
    version: "0.1.0",
    scripts: {},
    dependencies: {},
    devDependencies: {},
  }
}

function normalizeRecord(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {}
  }

  const output: Record<string, string> = {}
  for (const [key, recordValue] of Object.entries(value)) {
    if (typeof recordValue === "string" && key.trim()) {
      output[key.trim()] = recordValue.trim()
    }
  }
  return output
}

function filterAllowedPackageRecord(value: unknown): Record<string, string> {
  const record = normalizeRecord(value)
  return Object.fromEntries(
    Object.entries(record).filter(([packageName]) => Boolean(PACKAGE_VERSION_ALLOWLIST[packageName]))
  )
}

function installPackage(input: {
  packageJson: {
    dependencies: Record<string, string>
    devDependencies: Record<string, string>
  }
  packageName: string
  version: string
  addedPackages: string[]
  normalizedPackages: string[]
  conflictsPrevented: string[]
}) {
  const target = PACKAGE_DEV_DEPENDENCIES.has(input.packageName)
    ? input.packageJson.devDependencies
    : input.packageJson.dependencies
  const otherTarget = PACKAGE_DEV_DEPENDENCIES.has(input.packageName)
    ? input.packageJson.dependencies
    : input.packageJson.devDependencies

  if (otherTarget?.[input.packageName]) {
    delete otherTarget[input.packageName]
    input.conflictsPrevented.push(input.packageName)
  }

  if (!target[input.packageName]) {
    target[input.packageName] = input.version
    input.addedPackages.push(input.packageName)
  } else if (target[input.packageName] !== input.version && shouldNormalizeVersion(input.packageName, target[input.packageName])) {
    target[input.packageName] = input.version
    input.normalizedPackages.push(input.packageName)
  }
}

function extractImportSpecifiers(content: string) {
  const specifiers = new Set<string>()
  IMPORT_SPECIFIER_RE.lastIndex = 0
  let match: RegExpExecArray | null

  while ((match = IMPORT_SPECIFIER_RE.exec(content))) {
    const specifier = match[1] || match[2] || match[3] || match[4] || match[5] || ""
    if (specifier.trim()) specifiers.add(specifier.trim())
  }

  return Array.from(specifiers).sort()
}

function parseDependencyName(value: string) {
  const trimmed = String(value || "").trim()
  if (!trimmed) return ""
  if (trimmed.startsWith("@")) {
    const parts = trimmed.split("@")
    return `@${parts[1] || ""}`
  }
  return trimmed.split("@")[0] || ""
}

function isLocalSpecifier(specifier: string) {
  return specifier.startsWith(".") || specifier.startsWith("/") || specifier.startsWith("@/") || specifier.startsWith("~/")
}

function shouldNormalizeVersion(packageName: string, currentVersion: string) {
  if (!currentVersion || currentVersion === "*" || currentVersion === "latest") return true
  if (packageName === "next" || packageName === "react" || packageName === "react-dom") return true
  return false
}

function trimFileContent(content: string, limit: number) {
  const source = String(content || "")
  if (source.length <= limit) return source
  const headLength = Math.max(1, Math.floor(limit * 0.68))
  const tailLength = Math.max(1, limit - headLength)
  return `${source.slice(0, headLength).trimEnd()}\n/* ...trimmed ${source.length - limit} chars... */\n${source
    .slice(-tailLength)
    .trimStart()}`
}

function extractTerms(prompt: string) {
  const stop = new Set([
    "buat",
    "bikin",
    "create",
    "build",
    "generate",
    "please",
    "tolong",
    "yang",
    "untuk",
    "with",
    "and",
    "dan",
    "the",
    "app",
    "web",
    "page",
    "halaman",
  ])

  return Array.from(
    new Set(
      String(prompt || "")
        .toLowerCase()
        .replace(/```[\s\S]*?```/g, " ")
        .replace(/[^a-z0-9/_-]+/g, " ")
        .split(/\s+/)
        .map((term) => term.trim())
        .filter((term) => term.length >= 3 && !stop.has(term))
    )
  ).slice(0, 24)
}

function normalizePath(value: string) {
  return String(value || "").replace(/\\/g, "/").replace(/^\/+/, "").replace(/^\.\//, "").trim()
}

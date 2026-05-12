import { parse } from "@babel/parser"
import type { GeneratedFile } from "@/lib/types"

export type RepairStage = "syntax" | "type" | "import" | "runtime" | "build"

export type RepairFailureCategory =
  | "syntax_error"
  | "type_error"
  | "missing_import"
  | "unsupported_import"
  | "nextjs_boundary"
  | "runtime_exception"
  | "hydration_error"
  | "api_route_error"
  | "build_error"
  | "unknown"

export type StructuredRepairPlan = {
  stage: RepairStage
  category: RepairFailureCategory
  reason: string
  targetFiles: string[]
  preserveFiles: string[]
  patchStrategy: "file_scoped_minimal_diff" | "import_only" | "route_handler_patch" | "runtime_boundary_patch"
  catastrophic: boolean
}

export type RepairProvenance = {
  attempt: number
  maxAttempts: number
  stage: RepairStage
  category: RepairFailureCategory
  reason: string
  targetFiles: string[]
  patchSummary: string[]
  beforeValidation: unknown
  afterValidation?: unknown
  createdAt: string
}

export function buildStructuredRepairPlan(input: {
  errorMessage: string
  files: GeneratedFile[]
  fallbackTargets?: string[]
}): StructuredRepairPlan {
  const category = classifyFailure(input.errorMessage)
  const stage = stageForCategory(category)
  const targetFiles = selectRepairTargets({
    errorMessage: input.errorMessage,
    files: input.files,
    fallbackTargets: input.fallbackTargets,
    category,
  })

  return {
    stage,
    category,
    reason: summarizeReason(input.errorMessage, category),
    targetFiles,
    preserveFiles: input.files
      .map((file) => normalizePath(file.path))
      .filter((path) => !targetFiles.includes(path)),
    patchStrategy: patchStrategyForCategory(category),
    catastrophic: targetFiles.length === 0 || /too many files|empty artifact|no entry file/i.test(input.errorMessage),
  }
}

export function buildRepairProvenance(input: {
  attempt: number
  maxAttempts: number
  plan: StructuredRepairPlan
  beforeValidation: unknown
  afterValidation?: unknown
  beforeFiles: GeneratedFile[]
  afterFiles: GeneratedFile[]
}): RepairProvenance {
  return {
    attempt: input.attempt,
    maxAttempts: input.maxAttempts,
    stage: input.plan.stage,
    category: input.plan.category,
    reason: input.plan.reason,
    targetFiles: input.plan.targetFiles,
    patchSummary: summarizeFileChanges(input.beforeFiles, input.afterFiles),
    beforeValidation: input.beforeValidation,
    afterValidation: input.afterValidation,
    createdAt: new Date().toISOString(),
  }
}

export function summarizeFileChanges(beforeFiles: GeneratedFile[], afterFiles: GeneratedFile[]) {
  const before = new Map(beforeFiles.map((file) => [normalizePath(file.path), String(file.content || "")]))
  const after = new Map(afterFiles.map((file) => [normalizePath(file.path), String(file.content || "")]))
  const summary: string[] = []

  for (const [path, content] of after) {
    if (!before.has(path)) {
      summary.push(`created ${path}`)
      continue
    }

    if (before.get(path) !== content) {
      summary.push(`updated ${path}`)
    }
  }

  for (const path of before.keys()) {
    if (!after.has(path)) {
      summary.push(`deleted ${path}`)
    }
  }

  return summary.sort()
}

export function extractImportSpecifiersAst(file: GeneratedFile) {
  if (!/\.(tsx?|jsx?)$/i.test(file.path)) return []

  try {
    const ast = parse(String(file.content || ""), {
      sourceType: "module",
      errorRecovery: true,
      plugins: ["jsx", "typescript", "dynamicImport", "importAttributes", "decorators-legacy"],
    }) as unknown as AstNode

    const specifiers: string[] = []
    walkAst(ast, (node) => {
      if (
        (node.type === "ImportDeclaration" || node.type === "ExportNamedDeclaration" || node.type === "ExportAllDeclaration") &&
        node.source &&
        typeof node.source.value === "string"
      ) {
        specifiers.push(node.source.value)
      }
    })
    return Array.from(new Set(specifiers))
  } catch {
    return []
  }
}

function classifyFailure(errorMessage: string): RepairFailureCategory {
  const message = String(errorMessage || "").toLowerCase()
  if (/missing local import|cannot find module|module not found|missing local preview modules/.test(message)) return "missing_import"
  if (/unsupported imports|external package is not allowlisted|server-only|unsupported preview import/.test(message)) return "unsupported_import"
  if (/hydration|text content did not match|initial ui does not match/.test(message)) return "hydration_error"
  if (/client component|server component|use client|use server|metadata/.test(message)) return "nextjs_boundary"
  if (/syntaxerror|unexpected token|unterminated|parse error/.test(message)) return "syntax_error"
  if (/type error|typescript|ts\d{4}|not assignable|does not exist on type/.test(message)) return "type_error"
  if (/api route|route handler|500|405/.test(message)) return "api_route_error"
  if (/pageerror|unhandled runtime|console\.error|runtime exception/.test(message)) return "runtime_exception"
  if (/build failed|npm run build|next build|compil/.test(message)) return "build_error"
  return "unknown"
}

function stageForCategory(category: RepairFailureCategory): RepairStage {
  if (category === "syntax_error") return "syntax"
  if (category === "type_error" || category === "nextjs_boundary") return "type"
  if (category === "missing_import" || category === "unsupported_import") return "import"
  if (category === "runtime_exception" || category === "hydration_error" || category === "api_route_error") return "runtime"
  return "build"
}

function selectRepairTargets(input: {
  errorMessage: string
  files: GeneratedFile[]
  fallbackTargets?: string[]
  category: RepairFailureCategory
}) {
  const filePaths = new Set<string>()
  for (const filePath of extractFilePaths(input.errorMessage)) {
    filePaths.add(filePath)
  }

  for (const fallback of input.fallbackTargets || []) {
    filePaths.add(normalizePath(fallback))
  }

  if (input.category === "missing_import") {
    for (const file of input.files) {
      const imports = extractImportSpecifiersAst(file)
      if (imports.some((specifier) => input.errorMessage.includes(specifier))) {
        filePaths.add(normalizePath(file.path))
      }
    }
  }

  const existing = new Set(input.files.map((file) => normalizePath(file.path)))
  const matched = Array.from(filePaths).filter((path) => existing.has(path)).slice(0, 8)
  if (matched.length > 0) return matched

  return input.files
    .map((file) => normalizePath(file.path))
    .filter((path) =>
      /^app\/(?:.+\/)?page\.(tsx|ts|jsx|js)$/i.test(path) ||
      /^app\/api\/.+\/route\.(ts|js)$/i.test(path) ||
      /^components\//i.test(path) ||
      path === "package.json"
    )
    .slice(0, 8)
}

function patchStrategyForCategory(category: RepairFailureCategory): StructuredRepairPlan["patchStrategy"] {
  if (category === "missing_import" || category === "unsupported_import") return "import_only"
  if (category === "api_route_error") return "route_handler_patch"
  if (category === "nextjs_boundary" || category === "runtime_exception" || category === "hydration_error") {
    return "runtime_boundary_patch"
  }
  return "file_scoped_minimal_diff"
}

function summarizeReason(errorMessage: string, category: RepairFailureCategory) {
  const singleLine = String(errorMessage || "").replace(/\s+/g, " ").trim()
  return `${category}: ${singleLine.slice(0, 700)}`
}

function extractFilePaths(message: string) {
  const paths = new Set<string>()
  const patterns = [
    /in\s+([A-Za-z0-9_./-]+\.(?:tsx?|jsx?|json|css|prisma))/gi,
    /(?:^|\s|\.\/)([A-Za-z0-9_./-]+\.(?:tsx?|jsx?|json|css|prisma))(?::\d+:\d+)?/gim,
  ]

  for (const pattern of patterns) {
    for (const match of String(message || "").matchAll(pattern)) {
      if (match[1]) paths.add(normalizePath(match[1]))
    }
  }

  return Array.from(paths)
}

type AstNode = Record<string, unknown> & {
  type?: string
  source?: { value?: string }
}

function walkAst(node: unknown, visit: (node: AstNode) => void) {
  if (!node || typeof node !== "object") return
  const current = node as AstNode
  if (typeof current.type === "string") visit(current)

  for (const [key, value] of Object.entries(current)) {
    if (key === "loc" || key === "start" || key === "end" || key === "range") continue
    if (Array.isArray(value)) {
      for (const child of value) walkAst(child, visit)
      continue
    }
    if (value && typeof value === "object") {
      walkAst(value, visit)
    }
  }
}

function normalizePath(value: string) {
  return String(value || "").replace(/\\/g, "/").replace(/^\/+/, "").replace(/^\.\//, "").trim()
}

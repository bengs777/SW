import type { GeneratedFile } from "@/lib/types"

export type FullStackCategory = "frontend" | "api" | "data" | "config"

export type FullStackCoverage = {
  hasFrontend: boolean
  hasApi: boolean
  hasDataLayer: boolean
  hasConfig: boolean
}

export type FullStackValidationResult = {
  coverage: FullStackCoverage
  missingCategories: FullStackCategory[]
}

export type FullStackRepairResult = {
  files: GeneratedFile[]
  missingBeforeRepair: FullStackCategory[]
  addedFiles: GeneratedFile[]
  repaired: boolean
}

const FRONTEND_PAGE_PATTERN = /^app\/(?:.+\/)?page\.(tsx|ts|jsx|js)$/i
const API_ROUTE_PATTERN = /^app\/api\/.+\/route\.ts$/i
const PRISMA_PATTERN = /^prisma\/schema\.prisma$/i
const DATA_LAYER_PATTERN = /^lib\/(db|services)\/.+\.(ts|tsx)$/i
const CONFIG_PATTERN = /^(package\.json|lib\/config\/.+\.(ts|tsx))$/i

export function validateFullStackFiles(files: GeneratedFile[]): FullStackValidationResult {
  const normalizedFiles = files.map((file) => ({
    ...file,
    path: normalizePath(file.path),
    content: String(file.content || ""),
  }))

  const hasFrontend = normalizedFiles.some(
    (file) => FRONTEND_PAGE_PATTERN.test(file.path) && isMeaningfulFrontendFile(file.content)
  )
  const hasApi = normalizedFiles.some(
    (file) => API_ROUTE_PATTERN.test(file.path) && isMeaningfulApiRoute(file.content)
  )
  const hasDataLayer = normalizedFiles.some((file) => {
    if (PRISMA_PATTERN.test(file.path)) {
      return isMeaningfulPrismaSchema(file.content)
    }

    return DATA_LAYER_PATTERN.test(file.path) && isMeaningfulServiceFile(file.content)
  })
  const hasConfig = normalizedFiles.some(
    (file) => CONFIG_PATTERN.test(file.path) && isMeaningfulConfigFile(file.content)
  )

  const missingCategories: FullStackCategory[] = []
  if (!hasFrontend) missingCategories.push("frontend")
  if (!hasApi) missingCategories.push("api")
  if (!hasDataLayer) missingCategories.push("data")
  if (!hasConfig) missingCategories.push("config")

  return {
    coverage: {
      hasFrontend,
      hasApi,
      hasDataLayer,
      hasConfig,
    },
    missingCategories,
  }
}

export function autoRepairFullStackFiles(
  files: GeneratedFile[],
  scaffoldFiles: GeneratedFile[]
): FullStackRepairResult {
  const validation = validateFullStackFiles(files)
  if (validation.missingCategories.length === 0) {
    return {
      files,
      missingBeforeRepair: [],
      addedFiles: [],
      repaired: false,
    }
  }

  const byPath = new Map<string, GeneratedFile>()
  for (const file of files) {
    byPath.set(normalizePath(file.path), file)
  }

  const addedFiles: GeneratedFile[] = []

  for (const category of validation.missingCategories) {
    const candidate = pickFallbackFileForCategory(category, scaffoldFiles, byPath)
    if (!candidate) {
      continue
    }

    const path = normalizePath(candidate.path)
    if (byPath.has(path)) {
      continue
    }

    byPath.set(path, candidate)
    addedFiles.push(candidate)
  }

  return {
    files: Array.from(byPath.values()).sort((left, right) => left.path.localeCompare(right.path)),
    missingBeforeRepair: validation.missingCategories,
    addedFiles,
    repaired: addedFiles.length > 0,
  }
}

function pickFallbackFileForCategory(
  category: FullStackCategory,
  scaffoldFiles: GeneratedFile[],
  currentFilesByPath: Map<string, GeneratedFile>
) {
  const preferredCandidates =
    category === "frontend"
      ? ["app/page.tsx", "app/page.ts", "app/layout.tsx"]
      : category === "api"
        ? ["app/api/health/route.ts", "app/api/projects/route.ts", "app/api/generate/route.ts"]
        : category === "data"
          ? ["prisma/schema.prisma", "lib/services/project.service.ts", "lib/db/client.ts"]
          : ["package.json", "lib/config/env.ts"]

  for (const preferred of preferredCandidates) {
    const exact = scaffoldFiles.find(
      (file) => normalizePath(file.path).toLowerCase() === preferred.toLowerCase()
    )
    if (exact && !currentFilesByPath.has(normalizePath(exact.path))) {
      return exact
    }
  }

  const fallback = scaffoldFiles.find((file) => {
    const path = normalizePath(file.path)
    if (currentFilesByPath.has(path)) {
      return false
    }

    if (category === "frontend") return FRONTEND_PAGE_PATTERN.test(path)
    if (category === "api") return API_ROUTE_PATTERN.test(path)
    if (category === "data") return PRISMA_PATTERN.test(path) || DATA_LAYER_PATTERN.test(path)
    return CONFIG_PATTERN.test(path)
  })

  return fallback || null
}

function normalizePath(path: string) {
  return path.replace(/\\/g, "/").replace(/^\.\//, "").trim()
}

function isMeaningfulFrontendFile(content: string) {
  return (
    /export\s+default\s+(function|async\s+function|[A-Z][A-Za-z0-9_]*)/i.test(content) &&
    /return\s*\(|<main\b|<section\b|<div\b|className=/i.test(content)
  )
}

function isMeaningfulApiRoute(content: string) {
  return (
    /export\s+async\s+function\s+(GET|POST|PUT|PATCH|DELETE)\s*\(/.test(content) &&
    /NextResponse\.json|Response\.json|new\s+Response/i.test(content)
  )
}

function isMeaningfulPrismaSchema(content: string) {
  return /model\s+[A-Z][A-Za-z0-9_]*\s*\{[\s\S]*?\}/.test(content)
}

function isMeaningfulServiceFile(content: string) {
  return /export\s+(async\s+)?function\s+[A-Za-z0-9_]+\s*\(|export\s+class\s+[A-Za-z0-9_]+|export\s+const\s+[A-Za-z0-9_]+\s*=/.test(content)
}

function isMeaningfulConfigFile(content: string) {
  return /"scripts"\s*:|"dependencies"\s*:|process\.env|export\s+const\s+[A-Za-z0-9_]+\s*=/.test(content)
}

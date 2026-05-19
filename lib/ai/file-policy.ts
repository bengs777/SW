import path from "node:path"

const WORKSPACE_ROOT = process.cwd()
const ALLOWED_GENERATED_ROOTS = ["src", "app", "components", "lib", "prisma"] as const
const BLOCKED_EXACT_FILES = new Set(["package-lock.json", "pnpm-lock.yaml"])
const BLOCKED_SEGMENTS = new Set(["..", "~", "node_modules", ".git"])

export type GeneratedPathValidationResult = {
  path: string
  resolvedPath: string
}

type GeneratedPathValidationOptions = {
  allowManagedPackageJson?: boolean
}

export function normalizeGeneratedPath(filePath: string) {
  return String(filePath || "")
    .replace(/\\/g, "/")
    .replace(/^\.\//, "")
    .trim()
}

export function resolveGeneratedPath(normalizedPath: string, workspaceRoot = WORKSPACE_ROOT) {
  return path.resolve(workspaceRoot, normalizedPath)
}

export function validateGeneratedPath(
  filePath: string,
  workspaceRoot = WORKSPACE_ROOT,
  options: GeneratedPathValidationOptions = {}
): GeneratedPathValidationResult {
  const rawPath = String(filePath || "")
  const normalized = normalizeGeneratedPath(rawPath)

  if (!normalized || normalized.includes("\0") || /[\u0000-\u001f\u007f]/.test(normalized)) {
    throw new Error(`Invalid generated file path: ${filePath}`)
  }

  if (
    rawPath.startsWith("/") ||
    rawPath.startsWith("\\") ||
    path.posix.isAbsolute(rawPath) ||
    path.win32.isAbsolute(rawPath)
  ) {
    throw new Error(`Absolute generated file path rejected: ${filePath}`)
  }

  const segments = normalized.split("/")
  if (segments.some((segment) => !segment || segment === "." || BLOCKED_SEGMENTS.has(segment.toLowerCase()))) {
    throw new Error(`Blocked generated file path rejected: ${filePath}`)
  }

  const lower = normalized.toLowerCase()
  if (
    lower.includes("..") ||
    lower.includes("~") ||
    lower.includes(".env") ||
    BLOCKED_EXACT_FILES.has(lower)
  ) {
    throw new Error(`Blocked generated file path rejected: ${filePath}`)
  }

  const isAllowedRoot = ALLOWED_GENERATED_ROOTS.some((root) => lower === root || lower.startsWith(`${root}/`))
  const isManagedPackageJson = options.allowManagedPackageJson === true && lower === "package.json"
  if (!isAllowedRoot && !isManagedPackageJson) {
    throw new Error(`Generated file path is outside allowed project roots: ${filePath}`)
  }

  const resolvedPath = resolveGeneratedPath(normalized, workspaceRoot)
  const resolvedRoot = path.resolve(workspaceRoot)
  if (resolvedPath !== resolvedRoot && !resolvedPath.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw new Error(`Resolved generated file path escapes workspace: ${filePath}`)
  }

  return {
    path: normalized,
    resolvedPath,
  }
}

export function isSafeGeneratedPath(filePath: string) {
  try {
    validateGeneratedPath(filePath)
    return true
  } catch {
    return false
  }
}

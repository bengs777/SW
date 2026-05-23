import path from "node:path"
import { canonicalizeGeneratedPath } from "@/lib/ai/canonical-path"

const WORKSPACE_ROOT = process.cwd()
export const ALLOWED_GENERATED_ROOTS = ["src", "app", "components", "lib", "prisma"] as const
export const SAFE_GENERATED_ROOT_FILES = [
  "package.json",
  "tsconfig.json",
  "next.config.ts",
  "next.config.js",
  "tailwind.config.ts",
  "tailwind.config.js",
  "postcss.config.js",
  "README.md",
  ".env.example",
] as const
export const MANAGED_WORKSPACE_STATE_FILE = ".swift/workspace-state.json" as const

const SAFE_GENERATED_ROOT_FILE_SET = new Set(SAFE_GENERATED_ROOT_FILES.map((file) => file.toLowerCase()))
const MANAGED_WORKSPACE_STATE_FILE_LOWER = MANAGED_WORKSPACE_STATE_FILE.toLowerCase()
const BLOCKED_EXACT_FILES = new Set([".env", ".git", "package-lock.json", "pnpm-lock.yaml", "yarn.lock"])
const BLOCKED_SEGMENTS = new Set(["..", "~", "node_modules", ".git"])

export type GeneratedPathValidationDiagnostic = {
  error: "PATH_ERROR"
  reason: string
  received: string
  expected?: string
  allowedRootFiles?: readonly string[]
}

export type GeneratedPathValidationResult = {
  path: string
  resolvedPath: string
  received: string
  canonicalized: boolean
  repairs: string[]
}

type GeneratedPathValidationOptions = {
  allowManagedPackageJson?: boolean
  allowManagedWorkspaceState?: boolean
}

export class GeneratedPathValidationError extends Error {
  readonly diagnostic: GeneratedPathValidationDiagnostic

  constructor(diagnostic: GeneratedPathValidationDiagnostic) {
    super(JSON.stringify(diagnostic))
    this.name = "GeneratedPathValidationError"
    this.diagnostic = diagnostic
  }
}

export function normalizeGeneratedPath(filePath: string) {
  return canonicalizeGeneratedPath(filePath).path
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
  const canonical = canonicalizeGeneratedPath(rawPath)
  const normalized = canonical.path

  if (!normalized || normalized.includes("\0") || /[\u0000-\u001f\u007f]/.test(normalized)) {
    throwPathError("Path is empty or contains control characters", rawPath, normalized || undefined)
  }

  if (/^[a-zA-Z]:[\\/]/.test(rawPath.trim())) {
    throwPathError("Absolute filesystem path not allowed", rawPath)
  }

  const segments = normalized.split("/")
  if (segments.some((segment) => !segment || segment === "." || BLOCKED_SEGMENTS.has(segment.toLowerCase()))) {
    throwPathError("Blocked path segment not allowed", rawPath, normalized)
  }

  const lower = normalized.toLowerCase()
  if (lower.includes("..") || lower.includes("~") || BLOCKED_EXACT_FILES.has(lower) || isBlockedEnvPath(lower)) {
    throwPathError("Blocked path pattern not allowed", rawPath, normalized)
  }

  const isAllowedRoot = ALLOWED_GENERATED_ROOTS.some((root) => lower === root || lower.startsWith(`${root}/`))
  const isSafeRootFile = SAFE_GENERATED_ROOT_FILE_SET.has(lower)
  const isManagedPackageJson = options.allowManagedPackageJson === true && lower === "package.json"
  const isManagedWorkspaceState =
    options.allowManagedWorkspaceState === true && lower === MANAGED_WORKSPACE_STATE_FILE_LOWER
  if (!isAllowedRoot && !isSafeRootFile && !isManagedPackageJson && !isManagedWorkspaceState) {
    const isRootFile = !normalized.includes("/")
    throwPathError(
      isRootFile ? "Root file not allowlisted" : "Path must start with an allowed generated root",
      rawPath,
      normalized,
      isRootFile ? SAFE_GENERATED_ROOT_FILES : undefined
    )
  }

  const resolvedPath = resolveGeneratedPath(normalized, workspaceRoot)
  const resolvedRoot = path.resolve(workspaceRoot)
  if (resolvedPath !== resolvedRoot && !resolvedPath.startsWith(`${resolvedRoot}${path.sep}`)) {
    throwPathError("Resolved path escapes workspace", rawPath, normalized)
  }

  return {
    path: normalized,
    resolvedPath,
    received: rawPath,
    canonicalized: canonical.changed,
    repairs: canonical.fixes,
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

export function formatGeneratedPathValidationError(error: unknown) {
  if (error instanceof GeneratedPathValidationError) {
    return error.diagnostic
  }

  return {
    error: "PATH_ERROR" as const,
    reason: error instanceof Error ? error.message : String(error),
    received: "",
  }
}

function isBlockedEnvPath(lowerPath: string) {
  if (lowerPath === ".env.example") return false
  return lowerPath
    .split("/")
    .some((segment) => segment === ".env" || segment.startsWith(".env."))
}

function throwPathError(
  reason: string,
  received: string,
  expected?: string,
  allowedRootFiles?: readonly string[]
): never {
  throw new GeneratedPathValidationError({
    error: "PATH_ERROR",
    reason,
    received,
    ...(expected && expected !== received ? { expected } : {}),
    ...(allowedRootFiles ? { allowedRootFiles } : {}),
  })
}

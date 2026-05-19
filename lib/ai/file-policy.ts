import path from "node:path"
import { canonicalizeGeneratedPath } from "@/lib/ai/canonical-path"

const WORKSPACE_ROOT = process.cwd()
const ALLOWED_GENERATED_ROOTS = ["src", "app", "components", "lib", "prisma"] as const
const BLOCKED_EXACT_FILES = new Set(["package-lock.json", "pnpm-lock.yaml"])
const BLOCKED_SEGMENTS = new Set(["..", "~", "node_modules", ".git"])

export type GeneratedPathValidationDiagnostic = {
  error: "PATH_ERROR"
  reason: string
  received: string
  expected?: string
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
  if (
    lower.includes("..") ||
    lower.includes("~") ||
    lower.includes(".env") ||
    BLOCKED_EXACT_FILES.has(lower)
  ) {
    throwPathError("Blocked path pattern not allowed", rawPath, normalized)
  }

  const isAllowedRoot = ALLOWED_GENERATED_ROOTS.some((root) => lower === root || lower.startsWith(`${root}/`))
  const isManagedPackageJson = options.allowManagedPackageJson === true && lower === "package.json"
  if (!isAllowedRoot && !isManagedPackageJson) {
    throwPathError("Path must start with an allowed generated root", rawPath, normalized)
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

function throwPathError(reason: string, received: string, expected?: string): never {
  throw new GeneratedPathValidationError({
    error: "PATH_ERROR",
    reason,
    received,
    ...(expected && expected !== received ? { expected } : {}),
  })
}

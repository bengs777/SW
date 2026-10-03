import { env } from "@/lib/env"

export const AUTH_ROLES = ["user", "admin", "developer"] as const
export type AuthRole = (typeof AUTH_ROLES)[number]

export type AuthRuntimeIssue = {
  key: string
  code: "missing_env" | "invalid_env" | "provider_unavailable"
  severity: "warning" | "error"
  message: string
}

export type AuthRuntimeDiagnostic = {
  ok: boolean
  status: "healthy" | "degraded" | "unhealthy"
  sessionStrategy: "clerk"
  providers: {
    clerk: {
      configured: boolean
      missing: string[]
    }
  }
  issues: AuthRuntimeIssue[]
}

export type NormalizedAuthErrorCode =
  | "AUTH_REQUIRED"
  | "AUTH_PROVIDER_UNAVAILABLE"
  | "FORBIDDEN"

const appRoleRank: Record<AuthRole, number> = {
  user: 1,
  admin: 2,
  developer: 3,
}

export function normalizeAuthRole(value: unknown): AuthRole | null {
  return typeof value === "string" && AUTH_ROLES.includes(value as AuthRole)
    ? value as AuthRole
    : null
}

export function derivePrimaryRole(roles: AuthRole[]): AuthRole {
  if (roles.includes("developer")) return "developer"
  if (roles.includes("admin")) return "admin"
  return "user"
}

export function canAccessRole(currentRole: AuthRole, requiredRole: AuthRole) {
  return appRoleRank[currentRole] >= appRoleRank[requiredRole]
}

export function getClerkAuthMissingEnv() {
  const missing: string[] = []
  if (!env.clerkPublishableKey) missing.push("NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY")
  if (!env.clerkSecretKey) missing.push("CLERK_SECRET_KEY")
  return missing
}

export function getAuthRuntimeDiagnostic(): AuthRuntimeDiagnostic {
  const isProduction = env.nodeEnv === "production"
  const issues: AuthRuntimeIssue[] = []

  const clerkMissing = getClerkAuthMissingEnv()
  if (clerkMissing.length > 0) {
    issues.push({
      key: clerkMissing.join(", "),
      code: "provider_unavailable",
      severity: isProduction ? "error" : "warning",
      message: `Clerk auth is unavailable because ${clerkMissing.join(" and ")} ${clerkMissing.length === 1 ? "is" : "are"} missing.`,
    })
  }

  const hasError = issues.some((issue) => issue.severity === "error")
  const hasWarning = issues.some((issue) => issue.severity === "warning")

  return {
    ok: !hasError,
    status: hasError ? "unhealthy" : hasWarning ? "degraded" : "healthy",
    sessionStrategy: "clerk",
    providers: {
      clerk: {
        configured: clerkMissing.length === 0,
        missing: clerkMissing,
      },
    },
    issues,
  }
}

export function createNormalizedAuthError(
  code: NormalizedAuthErrorCode,
  message: string,
  status: 401 | 403 | 503,
  detail?: unknown
) {
  return {
    error: message,
    code,
    status,
    detail,
  }
}

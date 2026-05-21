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
  sessionStrategy: "jwt"
  providers: {
    google: {
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

export function getGoogleAuthMissingEnv() {
  const missing: string[] = []
  if (!env.googleClientId) missing.push("GOOGLE_CLIENT_ID")
  if (!env.googleClientSecret) missing.push("GOOGLE_CLIENT_SECRET")
  return missing
}

export function getAuthRuntimeDiagnostic(): AuthRuntimeDiagnostic {
  const isProduction = env.nodeEnv === "production"
  const issues: AuthRuntimeIssue[] = []

  if (!env.nextAuthSecret) {
    issues.push({
      key: "NEXTAUTH_SECRET",
      code: "missing_env",
      severity: isProduction ? "error" : "warning",
      message: isProduction
        ? "NEXTAUTH_SECRET is required for production session signing."
        : "NEXTAUTH_SECRET is missing; development auth can start, but sessions are not production-ready.",
    })
  }

  try {
    if (env.nextAuthUrl) {
      new URL(env.nextAuthUrl)
    }
  } catch {
    issues.push({
      key: "NEXTAUTH_URL",
      code: "invalid_env",
      severity: isProduction ? "error" : "warning",
      message: "NEXTAUTH_URL must be a valid absolute URL.",
    })
  }

  const googleMissing = getGoogleAuthMissingEnv()
  if (googleMissing.length > 0) {
    issues.push({
      key: googleMissing.join(", "),
      code: "provider_unavailable",
      severity: isProduction ? "error" : "warning",
      message: `Google OAuth is unavailable because ${googleMissing.join(" and ")} ${googleMissing.length === 1 ? "is" : "are"} missing.`,
    })
  }

  const hasError = issues.some((issue) => issue.severity === "error")
  const hasWarning = issues.some((issue) => issue.severity === "warning")

  return {
    ok: !hasError,
    status: hasError ? "unhealthy" : hasWarning ? "degraded" : "healthy",
    sessionStrategy: "jwt",
    providers: {
      google: {
        configured: googleMissing.length === 0,
        missing: googleMissing,
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

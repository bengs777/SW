import { NextResponse } from "next/server"
import { auth } from "@/auth"
import { prisma } from "@/lib/db/client"
import { env } from "@/lib/env"
import {
  canAccessRole,
  createNormalizedAuthError,
  derivePrimaryRole,
  getAuthRuntimeDiagnostic,
  type AuthRole,
} from "@/lib/auth/runtime"

export function normalizeAdminEmail(email: string) {
  return email.trim().toLowerCase()
}

type CurrentActor = {
  id: string
  email: string
  balance: number
  isDeveloperAccount: boolean
  roles: AuthRole[]
  role: AuthRole
}

function deriveActorRoles(input: {
  isDeveloperAccount: boolean
  workspaceRoles: string[]
  ownsWorkspace: boolean
}): AuthRole[] {
  const roles = new Set<AuthRole>(["user"])
  if (input.ownsWorkspace || input.workspaceRoles.some((role) => role === "admin")) {
    roles.add("admin")
  }
  if (input.isDeveloperAccount) {
    roles.add("admin")
    roles.add("developer")
  }
  return Array.from(roles)
}

function authErrorResponse(
  code: "AUTH_REQUIRED" | "AUTH_PROVIDER_UNAVAILABLE" | "FORBIDDEN",
  message: string,
  status: 401 | 403 | 503,
  detail?: unknown
) {
  return NextResponse.json(
    createNormalizedAuthError(code, message, status, detail),
    { status }
  )
}

export async function getCurrentAuthActor(): Promise<CurrentActor | null> {
  const runtime = getAuthRuntimeDiagnostic()
  if (!runtime.ok && env.nodeEnv === "production") {
    return null
  }

  const session = await auth()
  const email = session?.user?.email

  if (!email) {
    return null
  }

  const sessionEmail = normalizeAdminEmail(email)

  const user = await prisma.user.findUnique({
    where: { email: sessionEmail },
    select: {
      id: true,
      email: true,
      balance: true,
      isDeveloperAccount: true,
      workspaces: { select: { id: true }, take: 1 },
      memberships: { select: { role: true } },
    },
  })

  if (!user) return null

  const isOwnerDeveloper =
    user.isDeveloperAccount &&
    normalizeAdminEmail(user.email) === normalizeAdminEmail(env.devOwnerEmail)
  const roles = deriveActorRoles({
    isDeveloperAccount: isOwnerDeveloper,
    ownsWorkspace: Boolean(user.workspaces.length),
    workspaceRoles: user.memberships.map((membership) => membership.role),
  })

  return {
    id: user.id,
    email: user.email,
    balance: user.balance,
    isDeveloperAccount: isOwnerDeveloper,
    roles,
    role: derivePrimaryRole(roles),
  }
}

export async function getCurrentDeveloperActor() {
  const actor = await getCurrentAuthActor()
  return actor?.role === "developer" ? actor : null
}

export async function requireAuthenticatedActorResponse() {
  const runtime = getAuthRuntimeDiagnostic()
  if (!runtime.ok && env.nodeEnv === "production") {
    return {
      error: authErrorResponse(
        "AUTH_PROVIDER_UNAVAILABLE",
        "Authentication is not configured",
        503,
        runtime
      ),
    }
  }

  const actor = await getCurrentAuthActor()

  if (!actor) {
    return {
      error: authErrorResponse("AUTH_REQUIRED", "Authentication required", 401),
    }
  }

  return { actor }
}

export async function requireRoleResponse(requiredRole: AuthRole) {
  const actorResult = await requireAuthenticatedActorResponse()
  if ("error" in actorResult) return actorResult

  if (!canAccessRole(actorResult.actor.role, requiredRole)) {
    return {
      error: authErrorResponse(
        "FORBIDDEN",
        `${requiredRole[0].toUpperCase()}${requiredRole.slice(1)} access required`,
        403,
        { requiredRole, role: actorResult.actor.role }
      ),
    }
  }

  return actorResult
}

export function requireAdminActorResponse() {
  return requireRoleResponse("admin")
}

export async function requireDeveloperActorResponse() {
  return requireRoleResponse("developer")
}

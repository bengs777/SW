import { auth, currentUser } from "@clerk/nextjs/server"
import { db } from "@/lib/db/client"
import { users, workspaces, workspaceMembers } from "@/lib/db/schema"
import { eq } from "drizzle-orm"
import { env } from "@/lib/env"
import { log } from "@/lib/logging"
import {
  derivePrimaryRole,
  getAuthRuntimeDiagnostic,
  type AuthRole,
} from "@/lib/auth/runtime"

export type AuthSession = {
  userId: string
  email: string
  name: string | null
  image: string | null
  roles: AuthRole[]
  role: AuthRole
  isDeveloperAccount: boolean
}

const userCache = new Map<string, AuthSession>()
const userLookupInflight = new Map<string, Promise<AuthSession | null>>()
const creditGrantCache = new Map<string, number>()
const creditGrantInflight = new Map<string, Promise<void>>()
const authDebugEnabled = process.env.SWIFT_AUTH_DEBUG === "true"
const CREDIT_GRANT_SESSION_TTL_MS = 10 * 60 * 1000

const authRuntime = getAuthRuntimeDiagnostic()

if (!authRuntime.ok || authRuntime.status === "degraded") {
  log(authRuntime.ok ? "warn" : "error", "auth_runtime_configuration", {
    status: authRuntime.status,
    issues: authRuntime.issues,
  })
}

function deriveRoles(input: {
  isDeveloperAccount?: boolean | null
  workspaceRoles?: string[]
  ownsWorkspace?: boolean
}): AuthRole[] {
  const roles = new Set<AuthRole>(["user"])

  if (input.ownsWorkspace || input.workspaceRoles?.some((role) => role === "admin")) {
    roles.add("admin")
  }

  if (input.isDeveloperAccount) {
    roles.add("developer")
    roles.add("admin")
  }

  return Array.from(roles)
}

async function resolveDatabaseUser(email?: string | null): Promise<AuthSession | null> {
  if (!email) return null

  const normalizedEmail = email.trim().toLowerCase()

  if (userCache.has(normalizedEmail)) {
    return userCache.get(normalizedEmail) ?? null
  }

  const inflight = userLookupInflight.get(normalizedEmail)
  if (inflight) {
    try {
      return await inflight
    } catch {
      return null
    }
  }

  const lookup = (async () => {
    const dbUser = await db.query.users.findFirst({
      where: eq(users.email, normalizedEmail),
      with: {
        workspaces: { limit: 1 },
        memberships: { columns: { role: true } },
      },
    }) as unknown as {
      id: string
      email: string
      name: string | null
      image: string | null
      isDeveloperAccount: boolean
      workspaces: Array<{ id: string }>
      memberships: Array<{ role: string }>
    } | undefined

    const roles = deriveRoles({
      isDeveloperAccount: dbUser?.isDeveloperAccount,
      ownsWorkspace: Boolean(dbUser?.workspaces.length),
      workspaceRoles: dbUser?.memberships.map((m) => m.role) ?? [],
    })

    const authUser: AuthSession = {
      userId: dbUser?.id ?? "",
      email: normalizedEmail,
      name: dbUser?.name ?? null,
      image: dbUser?.image ?? null,
      roles,
      role: derivePrimaryRole(roles),
      isDeveloperAccount: dbUser?.isDeveloperAccount ?? false,
    }

    userCache.set(normalizedEmail, authUser)
    return authUser
  })()

  userLookupInflight.set(normalizedEmail, lookup)

  try {
    return await lookup
  } catch (error) {
    log("error", "auth_user_id_resolve_failed", { error: error instanceof Error ? error.message : String(error) })
    return null
  } finally {
    userLookupInflight.delete(normalizedEmail)
  }
}

async function grantMonthlyFreeCreditsFromSession(email: string) {
  const normalizedEmail = email.trim().toLowerCase()
  const lastGrantedAt = creditGrantCache.get(normalizedEmail) || 0
  if (Date.now() - lastGrantedAt < CREDIT_GRANT_SESSION_TTL_MS) return

  const inflight = creditGrantInflight.get(normalizedEmail)
  if (inflight) return inflight

  const grant = Promise.resolve()
    .then(async () => {
      const existing = await db.query.users.findFirst({
        where: eq(users.email, normalizedEmail),
        columns: { id: true, balance: true },
      })
      if (!existing) return

      const now = new Date()
      const lastGrant = await db.query.billingTransactions.findFirst({
        where: eq(users.id, existing.id),
        columns: { createdAt: true },
      })

      if (lastGrant) {
        const daysSinceLastGrant = (now.getTime() - lastGrant.createdAt.getTime()) / (1000 * 60 * 60 * 24)
        if (daysSinceLastGrant < 30) return
      }

      await db.update(users)
        .set({ balance: existing.balance + 10000 })
        .where(eq(users.id, existing.id))

      creditGrantCache.set(normalizedEmail, Date.now())
    })
    .finally(() => {
      creditGrantInflight.delete(normalizedEmail)
    })

  creditGrantInflight.set(normalizedEmail, grant)
  return grant
}

setInterval(() => {
  userCache.clear()
}, 5 * 60 * 1000)

export async function getSession(): Promise<AuthSession | null> {
  const { userId } = await auth()
  if (!userId) return null

  const clerkUser = await currentUser()
  if (!clerkUser) return null

  const email = clerkUser.emailAddresses[0]?.emailAddress
  if (!email) return null

  const dbUser = await resolveDatabaseUser(email)

  if (dbUser) {
    try {
      await grantMonthlyFreeCreditsFromSession(email)
    } catch (error) {
      log("warn", "auth_session_credit_sync_failed", { error: error instanceof Error ? error.message : String(error) })
    }
  }

  const roles = dbUser?.roles ?? ["user"]
  const session: AuthSession = {
    userId: dbUser?.userId ?? userId,
    email,
    name: clerkUser.fullName,
    image: clerkUser.imageUrl,
    roles,
    role: dbUser?.role ?? derivePrimaryRole(roles),
    isDeveloperAccount: dbUser?.isDeveloperAccount ?? false,
  }

  if (authDebugEnabled) {
    log("info", "auth_session", {
      email: session.email,
      userId: session.userId,
      isDeveloperAccount: session.isDeveloperAccount,
      role: session.role,
      roles: session.roles,
    })
  }

  return session
}

export async function requireAuth(): Promise<AuthSession> {
  const session = await getSession()
  if (!session) {
    throw new Error("Unauthorized")
  }
  return session
}

export { auth, currentUser }

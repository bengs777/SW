import NextAuth, { type Session } from "next-auth"
import Google from "next-auth/providers/google"
import type { JWT } from "next-auth/jwt"
import { prisma } from "@/lib/db/client"
import { isMissingRequiredTableError, shouldSoftFailMissingTable } from "@/lib/db/errors"
import { UserService } from "@/lib/services/user.service"
import { env } from "@/lib/env"
import { log } from "@/lib/logging"
import {
  derivePrimaryRole,
  getAuthRuntimeDiagnostic,
  type AuthRole,
} from "@/lib/auth/runtime"

type CachedAuthUser = {
  id: string | null
  isDeveloperAccount: boolean | null
  roles: AuthRole[]
  role: AuthRole
}

const userCache = new Map<string, CachedAuthUser>()
const userLookupInflight = new Map<string, Promise<CachedAuthUser | null>>()
const creditGrantCache = new Map<string, number>()
const creditGrantInflight = new Map<string, Promise<void>>()
const authDebugEnabled = process.env.SWIFT_AUTH_DEBUG === "true"
const CREDIT_GRANT_SESSION_TTL_MS = 10 * 60 * 1000

type AuthToken = JWT & {
  id?: string | null
  email?: string | null
  roles?: AuthRole[]
  role?: AuthRole
  isDeveloperAccount?: boolean | null
}

type AuthSession = Session & {
  user: NonNullable<Session["user"]> & {
    id?: string | null
    isDeveloperAccount?: boolean | null
    roles?: AuthRole[]
    role?: AuthRole
  }
}

const authRuntime = getAuthRuntimeDiagnostic()
const authProviders = authRuntime.providers.google.configured
  ? [
      Google({
        clientId: env.googleClientId,
        clientSecret: env.googleClientSecret,
        // SECURITY: Removed allowDangerousEmailAccountLinking to prevent account takeover
        // via email address reuse across OAuth providers.
      }),
    ]
  : []

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

async function resolveDatabaseUserId(email?: string | null) {
  return (await resolveDatabaseUser(email))?.id ?? null
}

async function resolveDatabaseUser(email?: string | null): Promise<CachedAuthUser | null> {
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
    const dbUser = await prisma.user.findUnique({
      where: { email: normalizedEmail },
      select: {
        id: true,
        isDeveloperAccount: true,
        workspaces: { select: { id: true }, take: 1 },
        memberships: { select: { role: true } },
      },
    })
    const roles = deriveRoles({
      isDeveloperAccount: dbUser?.isDeveloperAccount,
      ownsWorkspace: Boolean(dbUser?.workspaces.length),
      workspaceRoles: dbUser?.memberships.map((membership) => membership.role) ?? [],
    })

    const authUser = {
      id: dbUser?.id ?? null,
      isDeveloperAccount: dbUser?.isDeveloperAccount ?? null,
      roles,
      role: derivePrimaryRole(roles),
    }
    userCache.set(normalizedEmail, authUser)
    return authUser
  })()

  userLookupInflight.set(normalizedEmail, lookup)

  try {
    return await lookup
  } catch (error) {
    if (isMissingRequiredTableError(error)) {
      if (shouldSoftFailMissingTable()) {
        log("warn", "auth_database_tables_missing", { action: "skip_user_lookup" })
        userCache.set(normalizedEmail, { id: null, isDeveloperAccount: null, roles: ["user"], role: "user" })
        return null
      }

      throw error
    }

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

  const grant = UserService.grantMonthlyFreeCreditsIfNeeded(normalizedEmail)
    .then(() => {
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

export const { handlers, auth, signIn, signOut } = NextAuth({
  // SECURITY: Trust host on Vercel (VERCEL=1) or non-production or when explicitly configured
  trustHost: process.env.VERCEL === "1" || process.env.NODE_ENV !== "production" || Boolean(process.env.NEXTAUTH_URL),
  secret: env.nextAuthSecret || (process.env.NODE_ENV === "production" ? undefined : "swift-development-auth-secret"),
  providers: authProviders,
  session: {
    strategy: "jwt",
    maxAge: 30 * 24 * 60 * 60,
    updateAge: 24 * 60 * 60,
  },
  pages: {
    signIn: "/login",
    error: "/auth/error",
  },
  cookies: {
    // SECURITY: Enforce secure cookie settings in production
    sessionToken: {
      name: process.env.NODE_ENV === "production" ? "__Secure-authjs.session-token" : "authjs.session-token",
      options: {
        httpOnly: true,
        sameSite: "lax" as const,
        path: "/",
        secure: process.env.NODE_ENV === "production",
      },
    },
    csrfToken: {
      name: process.env.NODE_ENV === "production" ? "__Host-authjs.csrf-token" : "authjs.csrf-token",
      options: {
        httpOnly: true,
        sameSite: "lax" as const,
        path: "/",
        secure: process.env.NODE_ENV === "production",
      },
    },
  },
  callbacks: {
    async jwt({ token, user }) {
      const currentToken = token as AuthToken

      if (user?.email) {
        currentToken.email = user.email
      }

      const databaseUserId = await resolveDatabaseUserId(
        user?.email ?? currentToken.email
      )

      if (databaseUserId) {
        currentToken.id = databaseUserId
      } else if (user?.id) {
        currentToken.id = user.id
      }

      const databaseUser = await resolveDatabaseUser(user?.email ?? currentToken.email)
      if (databaseUser) {
        currentToken.roles = databaseUser.roles
        currentToken.role = databaseUser.role
        currentToken.isDeveloperAccount = databaseUser.isDeveloperAccount
      }

      return currentToken
    },
    async session({ session, token }) {
      if (session.user) {
        const currentToken = token as AuthToken
        const currentSession = session as AuthSession
        const sessionUser = currentSession.user
        const userEmail = sessionUser.email ?? currentToken.email

        if (userEmail) {
          try {
            await grantMonthlyFreeCreditsFromSession(userEmail)
          } catch (error) {
            if (isMissingRequiredTableError(error) && !shouldSoftFailMissingTable()) {
              throw error
            }

            log("warn", "auth_session_credit_sync_failed", { error: error instanceof Error ? error.message : String(error) })
          }
        }

        const databaseUser = await resolveDatabaseUser(userEmail)
        const databaseUserId = databaseUser?.id ?? null

        sessionUser.id = databaseUserId ?? currentToken.id ?? undefined
        sessionUser.email = currentToken.email ?? sessionUser.email ?? null
        sessionUser.isDeveloperAccount = databaseUser?.isDeveloperAccount ?? null
        sessionUser.roles = databaseUser?.roles ?? currentToken.roles ?? ["user"]
        sessionUser.role = databaseUser?.role ?? currentToken.role ?? derivePrimaryRole(sessionUser.roles)

        if (authDebugEnabled) {
          log("info", "auth_session", {
            email: sessionUser.email,
            id: sessionUser.id,
            isDeveloperAccount: sessionUser.isDeveloperAccount,
            role: sessionUser.role,
            roles: sessionUser.roles,
          })
        }
      }

      return session
    },
    async redirect({ url, baseUrl }) {
      if (url.startsWith("/")) return `${baseUrl}${url}`
      if (url.startsWith(baseUrl)) return url
      return baseUrl
    },
    async signIn({ user, account }) {
      try {
        if (account?.provider === "google" && user.email) {
          await UserService.createUserWithWorkspaceIfMissing(
            user.email,
            user.name || user.email.split("@")[0],
            user.image || null
          )
          await UserService.grantWelcomeBonusIfNeeded(user.email)

          userCache.delete(user.email.trim().toLowerCase())
        }
      } catch (error) {
        if (isMissingRequiredTableError(error) && !shouldSoftFailMissingTable()) {
          log("error", "auth_signin_blocked_missing_tables", { error: error instanceof Error ? error.message : String(error) })
          return false
        }

        log("warn", "auth_signin_sync_failed", { error: error instanceof Error ? error.message : String(error) })
      }

      return true
    },
  },
  events: {
    async signIn({ user, account }) {
      if (authDebugEnabled) {
        log("info", "auth_signin", { email: user.email, provider: account?.provider })
      }
    },
    async signOut(message) {
      if (authDebugEnabled) {
        log("info", "auth_signout", {
          tokenEmail: "token" in message ? message.token?.email : null,
          sessionUserId: "session" in message ? message.session?.userId : null,
        })
      }
    },
  },
})

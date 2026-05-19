import NextAuth from "next-auth"
import Google from "next-auth/providers/google"
import type { Session } from "next-auth"
import type { JWT } from "next-auth/jwt"
import { prisma } from "@/lib/db/client"
import { isMissingRequiredTableError, shouldSoftFailMissingTable } from "@/lib/db/errors"
import { UserService } from "@/lib/services/user.service"
import { env } from "@/lib/env"
import { log } from "@/lib/logging"

type CachedAuthUser = {
  id: string | null
  isDeveloperAccount: boolean | null
}

const userCache = new Map<string, CachedAuthUser>()
const authDebugEnabled = process.env.SWIFT_AUTH_DEBUG === "true"

type AuthToken = JWT & {
  id?: string | null
  email?: string | null
}

type AuthSession = Session & {
  user: NonNullable<Session["user"]> & {
    id?: string | null
    isDeveloperAccount?: boolean | null
  }
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

  try {
    const dbUser = await prisma.user.findUnique({
      where: { email: normalizedEmail },
      select: { id: true, isDeveloperAccount: true },
    })

    const authUser = {
      id: dbUser?.id ?? null,
      isDeveloperAccount: dbUser?.isDeveloperAccount ?? null,
    }
    userCache.set(normalizedEmail, authUser)
    return authUser
  } catch (error) {
    if (isMissingRequiredTableError(error)) {
      if (shouldSoftFailMissingTable()) {
        log("warn", "auth_database_tables_missing", { action: "skip_user_lookup" })
        userCache.set(normalizedEmail, { id: null, isDeveloperAccount: null })
        return null
      }

      throw error
    }

    log("error", "auth_user_id_resolve_failed", { error: error instanceof Error ? error.message : String(error) })
    return null
  }
}

setInterval(() => {
  userCache.clear()
}, 5 * 60 * 1000)

export const { handlers, auth, signIn, signOut } = NextAuth({
  // SECURITY: Trust host on Vercel (VERCEL=1) or non-production or when explicitly configured
  trustHost: process.env.VERCEL === "1" || process.env.NODE_ENV !== "production" || Boolean(process.env.NEXTAUTH_URL),
  secret: env.nextAuthSecret,
  providers: [
    Google({
      clientId: env.googleClientId,
      clientSecret: env.googleClientSecret,
      // SECURITY: Removed allowDangerousEmailAccountLinking to prevent account takeover
      // via email address reuse across OAuth providers.
    }),
  ],
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
            await UserService.grantMonthlyFreeCreditsIfNeeded(userEmail)
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

        if (authDebugEnabled) {
          log("info", "auth_session", {
            email: sessionUser.email,
            id: sessionUser.id,
            isDeveloperAccount: sessionUser.isDeveloperAccount,
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
  },
})

import NextAuth from "next-auth"
import type { Session } from "next-auth"
import type { JWT } from "next-auth/jwt"
import { prisma } from "@/lib/db/client"
import { isMissingRequiredTableError, shouldSoftFailMissingTable } from "@/lib/db/errors"
import { UserService } from "@/lib/services/user.service"
import { authConfig } from "./auth.config"

/**
 * Full Node.js-runtime NextAuth handler.
 *
 * MUST NOT be imported by `proxy.ts` (middleware/edge). The middleware imports
 * `auth.config.ts` directly and constructs its own slim `NextAuth(...)` from
 * that config — see `proxy.ts` for the pattern.
 *
 * This file extends `authConfig` with callbacks that touch Prisma and Node-only
 * services (UserService, db client). Anything that needs a database call
 * belongs here, not in `auth.config.ts`.
 */

const userIdCache = new Map<string, string | null>()

type AuthToken = JWT & {
  id?: string | null
  email?: string | null
}

type AuthSession = Session & {
  user: NonNullable<Session["user"]> & {
    id?: string | null
  }
}

async function resolveDatabaseUserId(email?: string | null) {
  if (!email) return null

  const normalizedEmail = email.trim().toLowerCase()

  if (userIdCache.has(normalizedEmail)) {
    return userIdCache.get(normalizedEmail) ?? null
  }

  try {
    const dbUser = await prisma.user.findUnique({
      where: { email: normalizedEmail },
      select: { id: true },
    })

    const userId = dbUser?.id ?? null
    userIdCache.set(normalizedEmail, userId)
    return userId
  } catch (error) {
    if (isMissingRequiredTableError(error)) {
      if (shouldSoftFailMissingTable()) {
        console.warn("[auth] Required database tables are not ready yet; skipping database user lookup.")
        userIdCache.set(normalizedEmail, null)
        return null
      }

      throw error
    }

    console.error("[auth] Database error resolving user ID:", error)
    return null
  }
}

// Clear user ID cache periodically to prevent stale data.
// Only start the interval at runtime (not during build phase).
if (typeof globalThis !== "undefined" && process.env.NEXT_PHASE !== "phase-production-build") {
  const interval = setInterval(() => {
    userIdCache.clear()
  }, 5 * 60 * 1000)

  // Don't keep the process alive just for cache clearing
  if (interval.unref) {
    interval.unref()
  }
}

export const { handlers, auth, signIn, signOut } = NextAuth({
  ...authConfig,
  callbacks: {
    ...authConfig.callbacks,
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

            console.error("[auth] Session credit sync warning:", error)
          }
        }

        const databaseUserId = await resolveDatabaseUserId(userEmail)

        sessionUser.id = databaseUserId ?? currentToken.id ?? undefined
        sessionUser.email = currentToken.email ?? sessionUser.email ?? null
      }

      return session
    },
    async signIn({ user, account }) {
      try {
        if (account?.provider === "google" && user.email) {
          await UserService.createUserWithWorkspaceIfMissing(
            user.email,
            user.name || user.email.split("@")[0],
            user.image || null
          )

          userIdCache.delete(user.email.trim().toLowerCase())
        }
      } catch (error) {
        if (isMissingRequiredTableError(error) && !shouldSoftFailMissingTable()) {
          console.error("[auth] Required database tables are missing; blocking sign-in until the database is synced.", error)
          return false
        }

        console.error("[auth] Auth signIn sync warning:", error)
      }

      return true
    },
  },
  events: {
    async signIn({ user, account }) {
      console.log("[auth] User signed in:", user.email, "via", account?.provider)
    },
  },
})

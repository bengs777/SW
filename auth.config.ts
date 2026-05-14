/**
 * Edge-safe NextAuth configuration.
 *
 * IMPORTANT: This module MUST NOT import Prisma, the database client, services,
 * or any Node.js-only library. It is loaded by `proxy.ts` (the Next.js
 * middleware/proxy edge bundle) and by `auth.ts` (the Node.js runtime).
 *
 * RELIABILITY ROOT CAUSE THIS PREVENTS:
 *   When `proxy.ts` imported `auth.ts` directly, it pulled the entire Prisma
 *   client (incl. `@prisma/client`, `pg`, ioredis transitively) into the
 *   middleware dependency graph. Symptoms in production:
 *     - Cold-start latency on every request (middleware loads Prisma)
 *     - Bundle-size warnings / edge runtime errors
 *     - Prisma `kind: Closed` errors traced through middleware path
 *     - Worker queue side effects accidentally evaluated on first request
 *
 * Pattern follows NextAuth v5 docs:
 *   https://authjs.dev/guides/edge-compatibility
 */

import type { NextAuthConfig } from "next-auth"
import Google from "next-auth/providers/google"

const isProduction = process.env.NODE_ENV === "production"

export const authConfig = {
  // SECURITY: Only trust host in non-production or when explicitly configured
  // via NEXTAUTH_URL. The middleware uses this same setting.
  trustHost: !isProduction || Boolean(process.env.NEXTAUTH_URL),
  secret: process.env.NEXTAUTH_SECRET,
  providers: [
    Google({
      clientId: process.env.GOOGLE_CLIENT_ID,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET,
    }),
  ],
  pages: {
    signIn: "/login",
    error: "/auth/error",
  },
  cookies: {
    // SECURITY: Enforce secure cookie settings in production. The `__Secure-` /
    // `__Host-` prefixes require HTTPS and are enforced by the browser.
    sessionToken: {
      name: isProduction ? "__Secure-authjs.session-token" : "authjs.session-token",
      options: {
        httpOnly: true,
        sameSite: "lax" as const,
        path: "/",
        secure: isProduction,
      },
    },
    csrfToken: {
      name: isProduction ? "__Host-authjs.csrf-token" : "authjs.csrf-token",
      options: {
        httpOnly: true,
        sameSite: "lax" as const,
        path: "/",
        secure: isProduction,
      },
    },
  },
  callbacks: {
    // Edge-safe callbacks only. The full `jwt` and `session` callbacks live in
    // `auth.ts` and execute under the Node.js runtime where Prisma is
    // available. The `authorized` callback runs in middleware and MUST stay
    // Prisma-free — it only inspects the token.
    authorized({ auth }) {
      // We let `proxy.ts` make the public/protected routing decision. Returning
      // `true` here means NextAuth itself doesn't redirect; the proxy does.
      return Boolean(auth)
    },
    async redirect({ url, baseUrl }) {
      if (url.startsWith("/")) return `${baseUrl}${url}`
      if (url.startsWith(baseUrl)) return url
      return baseUrl
    },
  },
} satisfies NextAuthConfig

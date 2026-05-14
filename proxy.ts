import NextAuth from "next-auth"
import { NextResponse } from "next/server"
import type { NextRequest } from "next/server"
import { authConfig } from "@/auth.config"

/**
 * Next.js 16 proxy / middleware handler.
 *
 * RELIABILITY: this file MUST NOT import `auth.ts` (the full Node config) or
 * `lib/db/client` (Prisma) — that would pull the database client into the
 * edge bundle and run on every request. We construct a slim NextAuth instance
 * directly from `auth.config.ts`, which has no DB / Prisma / service imports.
 *
 * Responsibilities:
 *   - Auth gate (cookie-only, no DB)
 *   - Security headers
 *   - CORS
 *   - Top-level request size guard (fast 413)
 *
 * The matcher (bottom of file) excludes static assets, image optimization,
 * SSE streams, and webhooks so we don't run on every byte. Routes that need
 * a heavier auth check call `auth()` from `auth.ts` themselves at the route
 * level.
 */

const { auth: middlewareAuth } = NextAuth(authConfig)

const PUBLIC_PATH_PREFIXES = [
  "/api/auth/",
  "/api/health",
  "/api/billing/pakasir/webhook",
  "/api/providers/status",
  "/_next/",
  "/favicon.ico",
  "/public/",
]

const PUBLIC_PATHS = new Set([
  "/login",
  "/signup",
  "/auth/error",
  "/",
])

const PROTECTED_API_PREFIXES = [
  "/api/projects",
  "/api/generate",
  "/api/orchestrator",
  "/api/workspaces",
  "/api/api-keys",
  "/api/ai",
  "/api/admin",
  "/api/billing",
  "/api/models",
  "/api/templates",
  "/api/crypto",
  "/api/user",
]

const PROTECTED_PAGE_PREFIXES = ["/dashboard"]

function isPublicPath(pathname: string): boolean {
  if (PUBLIC_PATHS.has(pathname)) return true
  return PUBLIC_PATH_PREFIXES.some((prefix) => pathname.startsWith(prefix))
}

function isApiRoute(pathname: string): boolean {
  return pathname.startsWith("/api/")
}

function isProtectedRoute(pathname: string): boolean {
  if (PROTECTED_PAGE_PREFIXES.some((prefix) => pathname.startsWith(prefix))) return true
  if (PROTECTED_API_PREFIXES.some((prefix) => pathname.startsWith(prefix))) return true
  return false
}

function applySecurityHeaders(response: NextResponse): NextResponse {
  response.headers.set("X-Frame-Options", "DENY")
  response.headers.set("X-Content-Type-Options", "nosniff")
  response.headers.set("Referrer-Policy", "strict-origin-when-cross-origin")
  response.headers.set("X-XSS-Protection", "1; mode=block")
  response.headers.set(
    "Permissions-Policy",
    "camera=(), microphone=(), geolocation=(), interest-cohort=()"
  )
  if (process.env.NODE_ENV === "production") {
    response.headers.set(
      "Strict-Transport-Security",
      "max-age=31536000; includeSubDomains; preload"
    )
  }
  return response
}

function applyCorsHeaders(request: NextRequest, response: NextResponse): NextResponse {
  const origin = request.headers.get("origin")
  const appUrl = process.env.NEXT_PUBLIC_APP_URL || process.env.NEXTAUTH_URL || ""

  const allowedOrigins = new Set(
    [
      appUrl,
      appUrl.replace("https://", "http://"),
      "http://localhost:3000",
      "https://localhost:3000",
    ].filter(Boolean)
  )

  if (origin && allowedOrigins.has(origin)) {
    response.headers.set("Access-Control-Allow-Origin", origin)
    response.headers.set("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS")
    response.headers.set(
      "Access-Control-Allow-Headers",
      "Content-Type, Authorization, X-Request-Id, X-CSRF-Token"
    )
    response.headers.set("Access-Control-Allow-Credentials", "true")
    response.headers.set("Access-Control-Max-Age", "86400")
  }

  return response
}

export const proxy = middlewareAuth((req) => {
  const { pathname } = req.nextUrl
  const request = req as unknown as NextRequest

  // Handle CORS preflight without auth/header overhead.
  if (req.method === "OPTIONS") {
    const response = new NextResponse(null, { status: 204 })
    applySecurityHeaders(response)
    applyCorsHeaders(request, response)
    return response
  }

  // Top-level request size guard (10MB) for API routes.
  // Per-route routes also enforce smaller caps.
  if (isApiRoute(pathname)) {
    const contentLength = req.headers.get("content-length")
    if (contentLength && Number(contentLength) > 10 * 1024 * 1024) {
      const response = NextResponse.json(
        { error: "Request payload too large" },
        { status: 413 }
      )
      applySecurityHeaders(response)
      return response
    }
  }

  // Public path: pass through with security headers only.
  if (isPublicPath(pathname)) {
    const response = NextResponse.next()
    applySecurityHeaders(response)
    applyCorsHeaders(request, response)
    return response
  }

  // Protected route: require valid session cookie. NOTE: this only checks the
  // signed JWT cookie — no DB lookup. The route handler itself does the
  // authoritative `auth()` check (which may hit the DB) before privileged work.
  if (isProtectedRoute(pathname) && !req.auth) {
    if (isApiRoute(pathname)) {
      const response = NextResponse.json(
        { error: "Authentication required" },
        { status: 401 }
      )
      applySecurityHeaders(response)
      return response
    }

    const loginUrl = new URL("/login", req.nextUrl.origin)
    loginUrl.searchParams.set("callbackUrl", pathname)
    return NextResponse.redirect(loginUrl)
  }

  const response = NextResponse.next()
  applySecurityHeaders(response)
  applyCorsHeaders(request, response)
  return response
})

/**
 * MATCHER (Fix 5: reduce middleware matcher scope).
 *
 * Was: "/((?!_next/static|_next/image|favicon.ico).*)" — ran on every request
 * including static assets, image optimizer, SSE streams, and webhook endpoints.
 *
 * Now: positive list of paths the middleware needs to act on, plus a negative
 * lookahead that excludes:
 *   - _next/static, _next/image            (build-time / image optimizer)
 *   - favicon.ico, robots.txt, sitemap.xml (browser metadata)
 *   - public/ (static files served from /public)
 *   - api/billing/pakasir/webhook          (high-frequency webhook; signature
 *     verification handles its own auth — middleware adds no value but adds
 *     latency, and we don't want to risk a CORS/header path mutating webhook
 *     responses)
 *   - api/generate/jobs/[id]/stream        (long-lived SSE; running middleware
 *     on every reconnect doubles edge invocations and breaks 1MB header limit
 *     on streamed responses)
 *   - api/health                           (canary endpoint; must stay sub-ms)
 *
 * Anything not matched here bypasses the proxy entirely. That means:
 *   - Static assets stream from the CDN with zero edge work.
 *   - SSE streams open one edge invocation, not one-per-byte.
 *   - The webhook does not pay for header rewriting on every Pakasir delivery.
 *
 * Reference: https://nextjs.org/docs/app/api-reference/file-conventions/middleware#matcher
 */
export const config = {
  matcher: [
    "/((?!_next/static|_next/image|_next/data|favicon\\.ico|robots\\.txt|sitemap\\.xml|public/|api/billing/pakasir/webhook|api/generate/jobs/.*?/stream|api/health).*)",
  ],
}

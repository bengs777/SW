import { auth } from "@/auth"
import { NextResponse } from "next/server"
import type { NextRequest } from "next/server"
import { hasValidObservabilityToken } from "@/lib/security/internal-observability"

/**
 * Next.js 16 proxy handler (replaces middleware.ts).
 * Handles: auth enforcement, security headers, CORS, and request size limits.
 */

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

const INTERNAL_OBSERVABILITY_PATH_PREFIXES = [
  "/api/metrics",
  "/api/production",
  "/api/worker",
]

function isPublicPath(pathname: string): boolean {
  if (PUBLIC_PATHS.has(pathname)) return true
  return PUBLIC_PATH_PREFIXES.some((prefix) => pathname.startsWith(prefix))
}

function isInternalObservabilityPath(pathname: string): boolean {
  return INTERNAL_OBSERVABILITY_PATH_PREFIXES.some((prefix) =>
    pathname === prefix || pathname.startsWith(`${prefix}/`)
  )
}

function isApiRoute(pathname: string): boolean {
  return pathname.startsWith("/api/")
}

function contentSecurityPolicy() {
  return [
    "default-src 'self'",
    "base-uri 'self'",
    "object-src 'none'",
    "frame-ancestors 'none'",
    "form-action 'self'",
    "img-src 'self' data: blob: https:",
    "font-src 'self' data: https:",
    "style-src 'self' 'unsafe-inline'",
    "script-src 'self' 'unsafe-inline' 'unsafe-eval' blob: https://va.vercel-scripts.com https://vercel.live",
    "connect-src 'self' https: wss:",
    "frame-src 'self' https:",
    "worker-src 'self' blob:",
    "upgrade-insecure-requests",
  ].join("; ")
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
    response.headers.set("Content-Security-Policy", contentSecurityPolicy())
  }
  return response
}

function applyCorsHeaders(request: NextRequest, response: NextResponse): NextResponse {
  const origin = request.headers.get("origin")
  const appUrl = process.env.NEXT_PUBLIC_APP_URL || process.env.NEXTAUTH_URL || ""

  const allowedOrigins = new Set([
    appUrl,
    appUrl.replace("https://", "http://"),
    "http://localhost:3000",
    "https://localhost:3000",
  ].filter(Boolean))

  if (origin && allowedOrigins.has(origin)) {
    response.headers.set("Access-Control-Allow-Origin", origin)
    response.headers.set("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS")
    response.headers.set("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Request-Id, X-CSRF-Token")
    response.headers.set("Access-Control-Allow-Credentials", "true")
    response.headers.set("Access-Control-Max-Age", "86400")
  }

  return response
}

export const proxy = auth((req) => {
  const { pathname } = req.nextUrl
  const request = req as unknown as NextRequest

  // Handle CORS preflight
  if (req.method === "OPTIONS") {
    const response = new NextResponse(null, { status: 204 })
    applySecurityHeaders(response)
    applyCorsHeaders(request, response)
    return response
  }

  // Request size guard for API routes (10MB max)
  if (isApiRoute(pathname)) {
    const contentLength = req.headers.get("content-length")
    if (contentLength && Number(contentLength) > 10 * 1024 * 1024) {
      return NextResponse.json(
        { error: "Request payload too large", code: "PAYLOAD_TOO_LARGE", status: 413 },
        { status: 413 }
      )
    }
  }

  if (isInternalObservabilityPath(pathname) && !req.auth && !hasValidObservabilityToken(request)) {
    const response = NextResponse.json(
      { error: "Authentication required", code: "AUTH_REQUIRED", status: 401 },
      { status: 401 }
    )
    applySecurityHeaders(response)
    return response
  }

  // Public paths — no auth required
  if (isPublicPath(pathname)) {
    const response = NextResponse.next()
    applySecurityHeaders(response)
    applyCorsHeaders(request, response)
    return response
  }

  // Protected routes — require authentication
  const protectedRoutes = [
    "/dashboard",
    "/api/projects",
    "/api/generate",
    "/api/orchestrator",
    "/api/orchestration",
    "/api/system",
    "/api/workspaces",
    "/api/api-keys",
    "/api/ai",
    "/api/admin",
    "/api/billing",
    "/api/debug",
    "/api/models",
    "/api/products",
    "/api/templates",
    "/api/crypto",
  ]

  const isProtectedRoute = protectedRoutes.some((route) =>
    pathname.startsWith(route)
  )

  if (isProtectedRoute && !req.auth) {
    if (isApiRoute(pathname)) {
      const response = NextResponse.json(
        { error: "Authentication required", code: "AUTH_REQUIRED", status: 401 },
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

export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico).*)",
  ],
}

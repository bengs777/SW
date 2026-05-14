import { NextRequest, NextResponse } from "next/server"
import { auth } from "@/auth"

/**
 * Centralized security middleware for Swift AI.
 * Handles: security headers, CORS, auth enforcement, and request size limits.
 */

const PUBLIC_PATHS = new Set([
  "/api/health",
  "/api/auth",
  "/api/billing/pakasir/webhook",
  "/api/providers/status",
  "/login",
  "/auth/error",
  "/",
])

const PUBLIC_PATH_PREFIXES = [
  "/api/auth/",
  "/api/health",
  "/_next/",
  "/favicon.ico",
  "/public/",
]

// Paths that don't require authentication (webhooks, public pages)
function isPublicPath(pathname: string): boolean {
  if (PUBLIC_PATHS.has(pathname)) return true
  return PUBLIC_PATH_PREFIXES.some((prefix) => pathname.startsWith(prefix))
}

// Paths that are only accessible from same origin (API routes with state changes)
function isApiRoute(pathname: string): boolean {
  return pathname.startsWith("/api/")
}

// Security headers applied to all responses
function applySecurityHeaders(response: NextResponse): NextResponse {
  // Prevent clickjacking
  response.headers.set("X-Frame-Options", "DENY")
  // Prevent MIME-type sniffing
  response.headers.set("X-Content-Type-Options", "nosniff")
  // Referrer policy
  response.headers.set("Referrer-Policy", "strict-origin-when-cross-origin")
  // XSS protection (legacy browsers)
  response.headers.set("X-XSS-Protection", "1; mode=block")
  // Permissions policy
  response.headers.set(
    "Permissions-Policy",
    "camera=(), microphone=(), geolocation=(), interest-cohort=()"
  )
  // HSTS (only in production)
  if (process.env.NODE_ENV === "production") {
    response.headers.set(
      "Strict-Transport-Security",
      "max-age=31536000; includeSubDomains; preload"
    )
  }
  // Content Security Policy
  response.headers.set(
    "Content-Security-Policy",
    [
      "default-src 'self'",
      "script-src 'self' 'unsafe-inline' 'unsafe-eval' https://vercel.live",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: https: blob:",
      "font-src 'self' data:",
      "connect-src 'self' https://openrouter.ai https://*.supabase.co https://vercel.live wss://ws-us3.pusher.com https://*.sentry.io",
      "frame-ancestors 'none'",
      "base-uri 'self'",
      "form-action 'self'",
    ].join("; ")
  )

  return response
}

// CORS enforcement for API routes
function applyCorsHeaders(request: NextRequest, response: NextResponse): NextResponse {
  const origin = request.headers.get("origin")
  const appUrl = process.env.NEXT_PUBLIC_APP_URL || process.env.NEXTAUTH_URL || ""

  // Only allow requests from our own origin
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
  } else if (origin && isApiRoute(request.nextUrl.pathname)) {
    // Block cross-origin API requests from unknown origins
    // Exception: webhook endpoints don't have origin headers (server-to-server)
    const isWebhook = request.nextUrl.pathname.includes("/webhook")
    if (!isWebhook) {
      response.headers.set("Access-Control-Allow-Origin", "null")
    }
  }

  return response
}

// Request size guard for API routes
function isRequestTooLarge(request: NextRequest): boolean {
  const contentLength = request.headers.get("content-length")
  if (!contentLength) return false

  const MAX_BODY_SIZE = 10 * 1024 * 1024 // 10MB
  return Number(contentLength) > MAX_BODY_SIZE
}

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl

  // Handle CORS preflight
  if (request.method === "OPTIONS") {
    const response = new NextResponse(null, { status: 204 })
    applySecurityHeaders(response)
    applyCorsHeaders(request, response)
    return response
  }

  // Request size guard
  if (isApiRoute(pathname) && isRequestTooLarge(request)) {
    return NextResponse.json(
      { error: "Request payload too large" },
      { status: 413 }
    )
  }

  // Public paths - no auth required
  if (isPublicPath(pathname)) {
    const response = NextResponse.next()
    applySecurityHeaders(response)
    applyCorsHeaders(request, response)
    return response
  }

  // Protected API routes and dashboard - require authentication
  if (isApiRoute(pathname) || pathname.startsWith("/dashboard")) {
    const session = await auth()

    if (!session?.user?.email) {
      if (isApiRoute(pathname)) {
        const response = NextResponse.json(
          { error: "Authentication required" },
          { status: 401 }
        )
        applySecurityHeaders(response)
        return response
      }

      // Redirect to login for page routes
      const loginUrl = new URL("/login", request.url)
      loginUrl.searchParams.set("callbackUrl", pathname)
      return NextResponse.redirect(loginUrl)
    }
  }

  const response = NextResponse.next()
  applySecurityHeaders(response)
  applyCorsHeaders(request, response)
  return response
}

export const config = {
  matcher: [
    /*
     * Match all request paths except static files and images
     */
    "/((?!_next/static|_next/image|favicon.ico|public/).*)",
  ],
}

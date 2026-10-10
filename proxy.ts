import { clerkMiddleware, createRouteMatcher } from "@clerk/nextjs/server"
import { NextResponse } from "next/server"
import type { NextRequest } from "next/server"
import { hasValidObservabilityToken } from "@/lib/security/internal-observability"

const isPublicRoute = createRouteMatcher([
  "/login(.*)",
  "/signup(.*)",
  "/forgot-password(.*)",
  "/auth/error",
  "/",
  "/api/auth(.*)",
  "/api/health",
  "/api/billing/pakasir/webhook",
  "/api/webhooks(.*)",
  "/api/providers/status",
  "/preview(.*)",
  "/api/preview(.*)",
])

const isInternalObservabilityRoute = createRouteMatcher([
  "/api/metrics(.*)",
  "/api/production(.*)",
  "/api/worker(.*)",
])

const isProtectedApiRoute = createRouteMatcher([
  "/api/projects(.*)",
  "/api/generate(.*)",
  "/api/orchestrator(.*)",
  "/api/orchestration(.*)",
  "/api/system(.*)",
  "/api/workspaces(.*)",
  "/api/api-keys(.*)",
  "/api/ai(.*)",
  "/api/admin(.*)",
  "/api/billing(.*)",
  "/api/debug(.*)",
  "/api/models(.*)",
  "/api/products(.*)",
  "/api/templates(.*)",
  "/api/crypto(.*)",
])

function contentSecurityPolicy(isPreview?: boolean) {
  return [
    "default-src 'self'",
    "base-uri 'self'",
    "object-src 'none'",
    `frame-ancestors ${isPreview ? "'self'" : "'none'"}`,
    "form-action 'self'",
    "img-src 'self' data: blob: https:",
    "font-src 'self' data: https:",
    "style-src 'self' 'unsafe-inline'",
    "script-src 'self' 'unsafe-inline' 'unsafe-eval' blob: https://va.vercel-scripts.com https://vercel.live https://*.clerk.com https://*.clerk.accounts.dev",
    "connect-src 'self' https: wss:",
    "frame-src 'self' https://*.clerk.com https://*.clerk.accounts.dev",
    "worker-src 'self' blob:",
    "upgrade-insecure-requests",
  ].join("; ")
}

function applySecurityHeaders(response: NextResponse, pathname?: string): NextResponse {
  const isPreview = pathname?.startsWith("/preview") || pathname?.startsWith("/api/preview")
  if (isPreview) {
    response.headers.set("X-Frame-Options", "SAMEORIGIN")
  } else {
    response.headers.set("X-Frame-Options", "DENY")
  }
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
    response.headers.set("Content-Security-Policy", contentSecurityPolicy(isPreview))
  }
  return response
}

function applyCorsHeaders(request: NextRequest, response: NextResponse): NextResponse {
  const origin = request.headers.get("origin")
  const appUrl = process.env.NEXT_PUBLIC_APP_URL || ""

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

const middleware = clerkMiddleware(async (auth, req) => {
  const { pathname } = req.nextUrl
  const request = req as unknown as NextRequest

  if (req.method === "OPTIONS") {
    const response = new NextResponse(null, { status: 204 })
    applySecurityHeaders(response, pathname)
    applyCorsHeaders(request, response)
    return response
  }

  if (pathname.startsWith("/api/")) {
    const contentLength = req.headers.get("content-length")
    if (contentLength && Number(contentLength) > 10 * 1024 * 1024) {
      return NextResponse.json(
        { error: "Request payload too large", code: "PAYLOAD_TOO_LARGE", status: 413 },
        { status: 413 }
      )
    }
  }

  if (isInternalObservabilityRoute(req)) {
    const { userId } = await auth()
    if (!userId) {
      if (!hasValidObservabilityToken(request)) {
        const response = NextResponse.json(
          { error: "Authentication required", code: "AUTH_REQUIRED", status: 401 },
          { status: 401 }
        )
        applySecurityHeaders(response, pathname)
        return response
      }

      const response = NextResponse.next()
      applySecurityHeaders(response, pathname)
      applyCorsHeaders(request, response)
      return response
    }
  }

  if (isPublicRoute(req)) {
    const response = NextResponse.next()
    applySecurityHeaders(response, pathname)
    applyCorsHeaders(request, response)
    return response
  }

  if (isProtectedApiRoute(req)) {
    const { userId } = await auth()
    if (!userId) {
      const response = NextResponse.json(
        { error: "Authentication required", code: "AUTH_REQUIRED", status: 401 },
        { status: 401 }
      )
      applySecurityHeaders(response, pathname)
      return response
    }
  }

  const { userId } = await auth()
  if (!userId) {
    if (pathname.startsWith("/api/")) {
      const response = NextResponse.json(
        { error: "Authentication required", code: "AUTH_REQUIRED", status: 401 },
        { status: 401 }
      )
      applySecurityHeaders(response, pathname)
      return response
    }

    const loginUrl = new URL("/login", req.nextUrl.origin)
    loginUrl.searchParams.set("callbackUrl", `${pathname}${req.nextUrl.search}`)
    return NextResponse.redirect(loginUrl)
  }

  const response = NextResponse.next()
  applySecurityHeaders(response, pathname)
  applyCorsHeaders(request, response)
  return response
})

export default middleware

export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico).*)",
  ],
}

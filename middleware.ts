import { NextRequest, NextResponse } from "next/server"

export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl

  // Allow webhook callbacks without auth (they use their own verification)
  if (pathname === "/api/billing/pakasir/webhook") {
    return NextResponse.next()
  }

  // Check for session token cookie
  const hasSession =
    request.cookies.has("next-auth.session-token") ||
    request.cookies.has("__Secure-next-auth.session-token")

  if (hasSession) {
    return NextResponse.next()
  }

  // Unauthenticated: redirect dashboard routes to login, return 401 for API
  if (pathname.startsWith("/api/")) {
    return NextResponse.json(
      { error: "Authentication required" },
      { status: 401 }
    )
  }

  // Dashboard routes - redirect to login
  const loginUrl = new URL("/login", request.url)
  loginUrl.searchParams.set("callbackUrl", pathname)
  return NextResponse.redirect(loginUrl)
}

export const config = {
  matcher: [
    "/dashboard/:path*",
    "/api/generate/:path*",
    "/api/projects/:path*",
    "/api/user/:path*",
    "/api/billing/:path*",
    "/api/admin/:path*",
    "/api/api-keys/:path*",
    "/api/templates/:path*",
    "/api/models/:path*",
  ],
}

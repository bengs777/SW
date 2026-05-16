import { auth } from "@/auth"
import { NextResponse } from "next/server"

/**
 * Centralized auth middleware — protects /dashboard and /api routes
 * (except public endpoints) in one place, eliminating per-page auth duplication.
 */
export default auth((req) => {
  const { pathname } = req.nextUrl

  // Allow public API routes
  const publicApiPaths = [
    "/api/auth",
    "/api/health",
    "/api/billing/pakasir/webhook",
    "/api/billing/crypto/verify",
  ]
  if (publicApiPaths.some((p) => pathname.startsWith(p))) {
    return NextResponse.next()
  }

  // Protect /dashboard and /api routes — redirect unauthenticated users
  const isProtected = pathname.startsWith("/dashboard") || pathname.startsWith("/api/")

  if (isProtected && !req.auth?.user?.email) {
    if (pathname.startsWith("/api/")) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }

    const loginUrl = new URL("/login", req.nextUrl.origin)
    loginUrl.searchParams.set("callbackUrl", pathname)
    return NextResponse.redirect(loginUrl)
  }

  console.log("[middleware]", {
    path: pathname,
    email: req.auth?.user?.email ?? null,
    authenticated: Boolean(req.auth?.user?.email),
  })

  return NextResponse.next()
})

export const config = {
  matcher: [
    "/dashboard/:path*",
    "/api/((?!auth|health|billing/pakasir/webhook|billing/crypto/verify).*)",
  ],
}

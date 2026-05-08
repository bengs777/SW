import { auth } from "@/auth"
import { NextResponse } from "next/server"

export const proxy = auth((req) => {
  const { pathname } = req.nextUrl

  const isAuthRoute =
    pathname === "/api/auth" || pathname.startsWith("/api/auth/")
  const isPublicAuthRoute =
    pathname.startsWith("/auth") || pathname === "/login" || pathname === "/signup"

  if (isAuthRoute || isPublicAuthRoute) {
    return NextResponse.next()
  }

  const protectedRoutes = [
    "/dashboard",
    "/api/projects",
    "/api/generate",
    "/api/workspaces",
    "/api/api-keys",
  ]

  const isProtectedRoute = protectedRoutes.some((route) =>
    pathname.startsWith(route)
  )

  if (isProtectedRoute && !req.auth) {
    const loginUrl = new URL("/login", req.nextUrl.origin)
    loginUrl.searchParams.set("callbackUrl", pathname)
    return NextResponse.redirect(loginUrl)
  }

  return NextResponse.next()
})

export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico).*)",
  ],
}

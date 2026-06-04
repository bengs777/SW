import { NextRequest, NextResponse } from "next/server"

const BEARER_PREFIX = "Bearer "

type HeaderReader = Pick<NextRequest, "headers">

export function getObservabilityToken() {
  return process.env.SWIFT_METRICS_TOKEN?.trim() || ""
}

export function hasValidObservabilityToken(request: HeaderReader) {
  const token = getObservabilityToken()
  if (!token) return false

  const authorization = request.headers.get("authorization")?.trim() || ""
  if (!authorization.startsWith(BEARER_PREFIX)) return false

  return authorization.slice(BEARER_PREFIX.length).trim() === token
}

export function canExposeInternalObservability(request: HeaderReader) {
  if (hasValidObservabilityToken(request)) return true

  return (
    process.env.NODE_ENV !== "production" &&
    process.env.SWIFT_ALLOW_UNAUTHENTICATED_OBSERVABILITY === "true"
  )
}

export function observabilityUnauthorizedResponse(message = "Observability authentication required") {
  return NextResponse.json(
    {
      error: "Unauthorized",
      code: "OBSERVABILITY_AUTH_REQUIRED",
      message,
      status: 401,
    },
    {
      status: 401,
      headers: {
        "Cache-Control": "no-store",
      },
    }
  )
}

export function requireObservabilityTokenResponse(request: HeaderReader) {
  if (hasValidObservabilityToken(request)) return null

  const message = getObservabilityToken()
    ? "A valid SWIFT_METRICS_TOKEN bearer token is required."
    : "SWIFT_METRICS_TOKEN must be configured before internal observability endpoints can be used."

  return observabilityUnauthorizedResponse(message)
}

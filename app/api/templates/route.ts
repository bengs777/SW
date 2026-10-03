import { NextRequest, NextResponse } from "next/server"
import { listTemplates } from "@/lib/templates/catalog"
import { enforceRouteRateLimit } from "@/lib/security/rate-limit"

export async function GET(request: NextRequest) {
  try {
    await enforceRouteRateLimit(`templates:${request.headers.get("x-forwarded-for") || "anon"}`, {
      maxPerMinute: 60,
      maxPerHour: 600,
    })
  } catch {
    return NextResponse.json({ error: "Too many requests. Please try again later." }, { status: 429 })
  }

  const { searchParams } = new URL(request.url)
  const category = searchParams.get("category") || undefined
  const featured = searchParams.get("featured")

  let filteredTemplates = listTemplates(category)

  if (featured === "true") {
    filteredTemplates = filteredTemplates.filter((template) => template.featured)
  }

  return NextResponse.json({ templates: filteredTemplates })
}

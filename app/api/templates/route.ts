import { NextRequest, NextResponse } from "next/server"
import { listTemplates } from "@/lib/templates/catalog"

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url)
  const category = searchParams.get("category") || undefined
  const featured = searchParams.get("featured")

  let filteredTemplates = listTemplates(category)

  if (featured === "true") {
    filteredTemplates = filteredTemplates.filter((template) => template.featured)
  }

  return NextResponse.json({ templates: filteredTemplates })
}

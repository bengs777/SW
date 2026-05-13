import { NextRequest, NextResponse } from "next/server"
import { requireDeveloperActorResponse } from "@/lib/admin"
import { GenerationQualityService } from "@/lib/services/generation-quality.service"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export async function GET(request: NextRequest) {
  const actorResult = await requireDeveloperActorResponse()
  if ("error" in actorResult) {
    return actorResult.error
  }

  const days = Math.max(1, Math.min(90, Number(request.nextUrl.searchParams.get("days") || 7)))
  const summary = await GenerationQualityService.summarizeRecent(days)

  return NextResponse.json({
    ok: true,
    summary,
  })
}

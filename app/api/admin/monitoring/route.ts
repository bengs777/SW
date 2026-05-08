import { NextRequest, NextResponse } from "next/server"
import { requireDeveloperActorResponse } from "@/lib/admin"
import { AdminMonitoringService } from "@/lib/services/admin-monitoring.service"

export async function GET(request: NextRequest) {
  const actorResult = await requireDeveloperActorResponse()
  if ("error" in actorResult) {
    return actorResult.error
  }

  const windowHours = Number(request.nextUrl.searchParams.get("windowHours") || 24)
  try {
    const overview = await AdminMonitoringService.getOverview(windowHours)

    return NextResponse.json({
      ok: true,
      actor: {
        id: actorResult.actor.id,
        email: actorResult.actor.email,
        balance: actorResult.actor.balance,
      },
      overview,
    })
  } catch (error) {
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : "Failed to load monitoring overview",
      },
      { status: 500 }
    )
  }
}

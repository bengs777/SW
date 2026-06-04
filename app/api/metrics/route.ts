import { NextRequest } from "next/server"
import { OrchestrationRuntimeService } from "@/lib/services/orchestration-runtime.service"
import { requireObservabilityTokenResponse } from "@/lib/security/internal-observability"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export async function GET(request: NextRequest) {
  const unauthorized = requireObservabilityTokenResponse(request)
  if (unauthorized) return unauthorized

  const body = await OrchestrationRuntimeService.prometheusMetrics()
  return new Response(body, {
    headers: {
      "Content-Type": "text/plain; version=0.0.4; charset=utf-8",
      "Cache-Control": "no-store",
    },
  })
}

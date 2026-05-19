import { NextRequest } from "next/server"
import { OrchestrationRuntimeService } from "@/lib/services/orchestration-runtime.service"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export async function GET(request: NextRequest) {
  const token = process.env.SWIFT_METRICS_TOKEN
  if (token) {
    const authorization = request.headers.get("authorization") || ""
    if (authorization !== `Bearer ${token}`) {
      return new Response("Unauthorized", { status: 401 })
    }
  }

  const body = await OrchestrationRuntimeService.prometheusMetrics()
  return new Response(body, {
    headers: {
      "Content-Type": "text/plain; version=0.0.4; charset=utf-8",
      "Cache-Control": "no-store",
    },
  })
}

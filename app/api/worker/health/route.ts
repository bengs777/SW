import { NextResponse } from "next/server"
import { getGenerationQueueHealth } from "@/lib/queue/generation-queue"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export async function GET() {
  try {
    const health = await getGenerationQueueHealth()
    const heartbeatAgeMs = health.workerHeartbeat?.ageMs ?? null
    const workerHealthy = health.status === "healthy" && typeof heartbeatAgeMs === "number" && heartbeatAgeMs <= 90_000

    return NextResponse.json({
      status: workerHealthy ? "healthy" : health.status,
      mode: "queue",
      worker: workerHealthy ? "healthy" : health.workerHeartbeat ? "degraded" : "missing",
      queue: health.status,
      deadLetter: health.deadLetter,
      heartbeat: health.workerHeartbeat,
      redis: health.redis,
      checkedAt: new Date().toISOString(),
    }, {
      status: workerHealthy ? 200 : 503,
      headers: {
        "Cache-Control": "no-store",
      },
    })
  } catch (error) {
    return NextResponse.json({
      status: "unhealthy",
      mode: "queue",
      worker: "unhealthy",
      error: error instanceof Error ? error.message : String(error),
      checkedAt: new Date().toISOString(),
    }, {
      status: 503,
      headers: {
        "Cache-Control": "no-store",
      },
    })
  }
}

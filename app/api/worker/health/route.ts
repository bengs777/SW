import { NextResponse } from "next/server"
import { getExternalWorkerRuntimeHealth } from "@/lib/observability/external-runtime-health"
import { getGenerationQueueHealth } from "@/lib/queue/generation-queue"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export async function GET() {
  try {
    const [health, workerService] = await Promise.all([
      getGenerationQueueHealth(),
      getExternalWorkerRuntimeHealth(),
    ])
    const heartbeatAgeMs = health.workerHeartbeat?.ageMs ?? null
    const workerHeartbeatHealthy = health.status === "healthy" && typeof heartbeatAgeMs === "number" && heartbeatAgeMs <= 90_000
    const workerServiceHealthy = !workerService.configured || workerService.ok
    const workerHealthy = workerHeartbeatHealthy && workerServiceHealthy
    const workerStatus = workerHealthy
      ? "healthy"
      : !workerHeartbeatHealthy && health.workerHeartbeat
        ? "degraded"
        : !workerHeartbeatHealthy
          ? "missing"
          : "unhealthy"

    return NextResponse.json({
      status: workerHealthy ? "healthy" : health.status,
      mode: "queue",
      worker: workerStatus,
      queue: health.status,
      deadLetter: health.deadLetter,
      heartbeat: health.workerHeartbeat,
      redis: health.redis,
      workerService,
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

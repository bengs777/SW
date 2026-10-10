import { db } from "@/lib/db/client"
import { generationJobs } from "@/lib/db/schema"
import { inArray } from "drizzle-orm"
import { env } from "@/lib/env"
import { GenerationJobService } from "@/lib/services/generation-job.service"

async function main() {
  console.log("env.aiMaxConcurrentGenerations:", env.aiMaxConcurrentGenerations)
  const userId = "usr_ms8rdt5x7453pgq6"
  const count = await GenerationJobService.countActiveForUser(userId)
  console.log(`Active jobs count for user ${userId}:`, count)

  const activeJobs = await db
    .select()
    .from(generationJobs)
    .where(inArray(generationJobs.status, ["queued", "running", "processing", "retrying", "stalled", "orphaned", "cancelling"]))

  console.log(`Found ${activeJobs.length} active jobs across all users:`)
  for (const j of activeJobs) {
    console.log({
      id: j.id,
      userId: j.userId,
      projectId: j.projectId,
      status: j.status,
      stage: j.stage,
      label: j.label,
      error: j.error,
      workerId: j.workerId,
      leaseOwner: j.leaseOwner,
      createdAt: j.createdAt,
      updatedAt: j.updatedAt,
    })
  }
}

main().catch(console.error)

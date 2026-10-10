import { db } from "@/lib/db/client"
import { generationJobs, usageLogs } from "@/lib/db/schema"
import { desc } from "drizzle-orm"

async function main() {
  const jobs = await db
    .select({
      id: generationJobs.id,
      userId: generationJobs.userId,
      projectId: generationJobs.projectId,
      status: generationJobs.status,
      stage: generationJobs.stage,
      label: generationJobs.label,
      error: generationJobs.error,
      previewUrl: generationJobs.previewUrl,
      createdAt: generationJobs.createdAt,
    })
    .from(generationJobs)
    .orderBy(desc(generationJobs.createdAt))
    .limit(10)

  console.log("Recent Generation Jobs:")
  for (const j of jobs) {
    console.log({
      id: j.id,
      userId: j.userId,
      projectId: j.projectId,
      status: j.status,
      stage: j.stage,
      error: j.error,
      previewUrl: j.previewUrl,
      createdAt: j.createdAt,
    })
  }

  const logs = await db
    .select()
    .from(usageLogs)
    .orderBy(desc(usageLogs.createdAt))
    .limit(10)

  console.log("\nRecent Usage Logs:")
  for (const l of logs) {
    console.log({
      id: l.id,
      userId: l.userId,
      status: l.status,
      cost: l.cost,
      createdAt: l.createdAt,
      errorMessage: l.errorMessage,
    })
  }
}

main().catch(console.error)

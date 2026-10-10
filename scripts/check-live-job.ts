import { db } from "@/lib/db/client"
import { generationJobs, generationEvents } from "@/lib/db/schema"
import { eq, desc, asc } from "drizzle-orm"
import { ProjectFilesystemService } from "@/lib/services/project-filesystem.service"

async function main() {
  const jobId = "6d0a4ccc-842c-4ab3-b16d-bbe84f1a9d55"
  const [job] = await db.select().from(generationJobs).where(eq(generationJobs.id, jobId))
  console.log("=== CURRENT JOB STATUS ===")
  console.log({
    id: job.id,
    status: job.status,
    stage: job.stage,
    label: job.label,
    error: job.error,
    workerId: job.workerId,
    startedAt: job.startedAt,
    previewUrl: job.previewUrl,
    leaseOwner: job.leaseOwner,
    leaseExpiresAt: job.leaseExpiresAt,
    lastHeartbeatAt: job.lastHeartbeatAt,
    completedAt: job.completedAt,
    failedAt: job.failedAt,
  })

  console.log("Current time:", new Date().toISOString())

  const events = await db
    .select()
    .from(generationEvents)
    .where(eq(generationEvents.jobId, jobId))
    .orderBy(desc(generationEvents.sequence))

  const ev516 = events.find((e) => e.sequence === 516)
  console.log("\n=== EVENT 516 (FALLBACK) ===", ev516)
  const ev522 = events.find((e) => e.sequence === 522)
  console.log("\n=== EVENT 522 (FAILED) ===", ev522)

  const files = await ProjectFilesystemService.readFiles("prj_ms8re9qotmnr4ig7")
  console.log(`\n=== PROJECT FILES (TOTAL: ${files.length}) ===`)
  for (const f of files) {
    console.log(`  - ${f.path} (${f.content.length} chars)`)
  }
}

main().catch(console.error)

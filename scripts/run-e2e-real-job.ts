import { db } from "@/lib/db/client"
import { projects, users, generationJobs, generationEvents } from "@/lib/db/schema"
import { eq, desc, asc } from "drizzle-orm"
import { BillingService } from "@/lib/services/billing.service"
import { enqueueGenerationTask } from "@/lib/queue/generation-queue"
import { GenerationJobService } from "@/lib/services/generation-job.service"
import { ModelConfigService } from "@/lib/services/model-config.service"
import { ProjectFilesystemService } from "@/lib/services/project-filesystem.service"

const PROJECT_ID = "prj_ms8re9qotmnr4ig7"
const USER_ID = "usr_ms8rdt5x7453pgq6"
const PROMPT = "Buat aplikasi kasir laundry lengkap"

async function main() {
  console.log("==================================================")
  console.log("  SWIFT AI E2E GENERATION TEST (LIVE REAL PIPELINE)")
  console.log("==================================================")
  console.log("Project ID:", PROJECT_ID)
  console.log("User ID:", USER_ID)
  console.log("Prompt:", PROMPT)

  const [project] = await db.select().from(projects).where(eq(projects.id, PROJECT_ID))
  if (!project) throw new Error("Project not found")

  const [user] = await db.select().from(users).where(eq(users.id, USER_ID))
  if (!user) throw new Error("User not found")

  const modelConfig = await ModelConfigService.getActiveModelByKey("swift-builder")
  if (!modelConfig) throw new Error("Model config swift-builder not found")

  console.log("\n[1/5] Step 1: Reserving and creating generation job in DB...")
  const startedAt = Date.now()
  const reservation = await BillingService.reserveGenerationJob({
    userId: user.id,
    projectId: project.id,
    prompt: PROMPT,
    modelConfigId: modelConfig.id,
    model: modelConfig.key,
    provider: "swift",
    cost: 3000,
    traceId: `e2e-${Date.now()}`,
    context: {
      mode: "build",
      promptLanguage: "id",
    },
  })

  const job = reservation.job
  const usageLog = reservation.usageLog
  console.log("Job Created ID:", job.id)
  console.log("Initial Status:", job.status)

  const queueId = `generation__${user.id}__${project.id}__e2e_${Date.now()}`
  const payload = {
    jobId: job.id,
    userId: user.id,
    projectId: project.id,
    prompt: PROMPT,
    model: modelConfig.key,
    provider: "swift",
    usageLogId: usageLog.id,
    reservedCost: 3000,
    modelConfigId: modelConfig.id,
    promptLanguage: "id" as const,
    collaborationMode: "build" as const,
    traceId: `e2e-${Date.now()}`,
  }

  console.log("\n[2/5] Step 2: Enqueuing to BullMQ queue...")
  const queueJob = await enqueueGenerationTask(payload, { jobId: queueId })
  if (!queueJob) throw new Error("Failed to enqueue task to BullMQ")
  console.log("BullMQ Queue Job ID:", queueJob.id)

  console.log("\n[3/5] Step 3: Monitoring job lifecycle and progress stream events...")
  let lastEventSeq = 0
  let isDone = false
  let finalStatus = "unknown"
  const maxWaitMs = 900_000 // 15 minutes max

  while (!isDone && Date.now() - startedAt < maxWaitMs) {
    await new Promise((r) => setTimeout(r, 2000))

    const [freshJob] = await db.select().from(generationJobs).where(eq(generationJobs.id, job.id))
    if (!freshJob) continue

    const events = await db
      .select()
      .from(generationEvents)
      .where(eq(generationEvents.jobId, job.id))
      .orderBy(asc(generationEvents.sequence))

    for (const ev of events) {
      if (ev.sequence > lastEventSeq) {
        lastEventSeq = ev.sequence
        console.log(`  -> [Seq ${ev.sequence}] [${ev.stage}] [${ev.status}] ${ev.type}: ${ev.message}`)
      }
    }

    if (["completed", "failed", "dead_lettered", "cancelled"].includes(freshJob.status)) {
      isDone = true
      finalStatus = freshJob.status
      console.log(`\nJob reached terminal status: ${finalStatus}`)
      if (freshJob.error) {
        console.log("Job Error Message:", freshJob.error)
      }
    }
  }

  const durationSec = Math.round((Date.now() - startedAt) / 1000)
  console.log("\n[4/5] Step 4: Verifying project files generated...")
  const files = await ProjectFilesystemService.readFiles(PROJECT_ID)
  console.log(`Total files in project: ${files.length}`)
  for (const f of files.slice(0, 15)) {
    console.log(`  - ${f.path} (${f.content.length} chars)`)
  }

  console.log("\n[5/5] Final Verification:")
  console.log("Duration:", durationSec, "seconds")
  console.log("Terminal Status:", finalStatus)

  if (finalStatus === "completed") {
    console.log("\n>>> GENERATION E2E: PASS <<<")
  } else {
    console.log("\n>>> GENERATION E2E: FAIL <<<")
    process.exit(1)
  }
}

main().catch((err) => {
  console.error("Fatal error:", err)
  process.exit(1)
})

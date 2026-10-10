import { db } from "@/lib/db/client"
import { generationEvents, generationHistory, generationJobs, projectFiles } from "@/lib/db/schema"
import { eq, desc, asc } from "drizzle-orm"
import fs from "node:fs"
import path from "node:path"

const JOB_ID = "6d0a4ccc-842c-4ab3-b16d-bbe84f1a9d55"
const PROJECT_ID = "prj_ms8re9qotmnr4ig7"

async function main() {
  console.log("=================================================================")
  console.log("  DIAGNOSING LAUNDRY ARTIFACTS & COMPONENT CONTRACT MISMATCHES   ")
  console.log("=================================================================")

  // 1. Check generationEvents for job
  const events = await db
    .select()
    .from(generationEvents)
    .where(eq(generationEvents.jobId, JOB_ID))
    .orderBy(asc(generationEvents.sequence))

  console.log(`\n[1] Total events for job ${JOB_ID}: ${events.length}`)
  
  // Find events around typecheck failure, fallback, or file updates
  const failEvents = events.filter(
    (e) =>
      e.stage === "building" ||
      e.stage === "repairing" ||
      e.type.includes("fail") ||
      e.type.includes("fallback") ||
      e.type.includes("artifact")
  )
  console.log(`Key lifecycle events (${failEvents.length}):`)
  for (const fe of failEvents) {
    console.log(`  - [Seq ${fe.sequence}] [${fe.stage}] [${fe.status}] ${fe.type}: ${fe.message}`)
    if ((fe as any).metadata) {
      const metaStr = JSON.stringify((fe as any).metadata)
      if (metaStr.length > 300) {
        console.log(`    Metadata snippet: ${metaStr.slice(0, 300)}...`)
      } else {
        console.log(`    Metadata: ${metaStr}`)
      }
    }
  }

  // 2. Check generationHistory
  const histories = await db
    .select()
    .from(generationHistory)
    .where(eq(generationHistory.projectId, PROJECT_ID))
    .orderBy(desc(generationHistory.createdAt))

  console.log(`\n[2] Total generationHistory records for ${PROJECT_ID}: ${histories.length}`)
  for (const h of histories) {
    console.log(`  - History ID: ${h.id} | Prompt: ${h.prompt?.slice(0, 40)} | Date: ${h.createdAt}`)
    try {
      const parsed = JSON.parse(h.result)
      console.log(`    Files in history snapshot: ${parsed.length}`)
      const pageFile = parsed.find((f: any) => f.path === "app/page.tsx")
      if (pageFile) {
        console.log(`    app/page.tsx snippet in history: ${pageFile.content.slice(0, 150)}...`)
      }
    } catch {}
  }

  // 3. Check for any failed artifacts on disk
  console.log(`\n[3] Checking filesystem for artifact dumps or backups...`)
  const possibleDirs = [
    path.resolve(process.cwd(), ".swift-failed-artifacts"),
    path.resolve(process.cwd(), ".swift-sandboxes"),
    path.resolve(process.cwd(), "artifacts"),
  ]
  for (const d of possibleDirs) {
    if (fs.existsSync(d)) {
      console.log(`  Directory ${d} exists:`)
      try {
        const list = fs.readdirSync(d)
        console.log(`    Contents: ${list.join(", ")}`)
      } catch (err: any) {
        console.log(`    Read error: ${err.message}`)
      }
    } else {
      console.log(`  Directory ${d} does not exist`)
    }
  }

  // 4. Check component registry and current files in projectFiles table
  console.log(`\n[4] Inspecting Actual Exports and Actual Imports...`)
  const files = await db
    .select()
    .from(projectFiles)
    .where(eq(projectFiles.projectId, PROJECT_ID))

  const targetFiles = [
    "component-registry/navbar.tsx",
    "component-registry/footer.tsx",
    "component-registry/feature-section.tsx",
    "component-registry/hero.tsx",
    "components/cta-section.tsx",
    "app/layout.tsx",
    "app/page.tsx",
    "sections/hero-section.tsx",
    "sections/features-section.tsx",
  ]

  for (const tf of targetFiles) {
    const found = files.find((f) => f.path === tf)
    if (found) {
      console.log(`\n=== FILE: ${tf} ===`)
      console.log(found.content)
    } else {
      console.log(`\n=== FILE: ${tf} (NOT FOUND in projectFiles) ===`)
    }
  }
}

main().catch(console.error)

import { db } from "@/lib/db/client"
import { projects, projectFiles, generationHistory, generationJobs } from "@/lib/db/schema"
import { eq, desc } from "drizzle-orm"

async function main() {
  const projectId = "prj_ms8re9qotmnr4ig7"

  console.log("=== JOBS FOR PROJECT ===")
  const jobs = await db
    .select()
    .from(generationJobs)
    .where(eq(generationJobs.projectId, projectId))
    .orderBy(desc(generationJobs.createdAt))

  for (const j of jobs) {
    console.log({
      id: j.id,
      prompt: j.prompt,
      status: j.status,
      stage: j.stage,
      previewUrl: j.previewUrl,
      createdAt: j.createdAt,
      completedAt: j.completedAt,
    })
  }

  console.log("\n=== GENERATION HISTORY FOR PROJECT ===")
  const history = await db
    .select()
    .from(generationHistory)
    .where(eq(generationHistory.projectId, projectId))
    .orderBy(desc(generationHistory.createdAt))

  for (const h of history) {
    console.log({
      id: h.id,
      prompt: h.prompt,
      createdAt: h.createdAt,
    })
  }

  console.log("\n=== PROJECT FILES IN DB ===")
  const files = await db
    .select()
    .from(projectFiles)
    .where(eq(projectFiles.projectId, projectId))

  console.log(`Total project files: ${files.length}`)
  for (const f of files) {
    if (f.path === "app/page.tsx") {
      console.log("--- app/page.tsx content ---")
      console.log(f.content)
    }
  }
}

main().catch(console.error)

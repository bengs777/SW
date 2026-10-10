import { db } from "@/lib/db/client"
import { projects, projectFiles, generationJobs } from "@/lib/db/schema"
import { eq, desc } from "drizzle-orm"
import { ProjectFilesystemService } from "@/lib/services/project-filesystem.service"
import fs from "node:fs"
import path from "node:path"

async function main() {
  const [proj1] = await db.select().from(projects).where(eq(projects.id, "prj_ms8re9qotmnr4ig7"))
  console.log("=== PROJECT prj_ms8re9qotmnr4ig7 ===", proj1)
  const [proj2] = await db.select().from(projects).where(eq(projects.id, "prj_mtpa508yu8nn9n9p"))
  console.log("=== PROJECT prj_mtpa508yu8nn9n9p ===", proj2)

  console.log("proj1 prompt:", proj1?.prompt)
  console.log("proj2 prompt:", proj2?.prompt)

  const files1 = await ProjectFilesystemService.readFiles("prj_ms8re9qotmnr4ig7")
  console.log(`\n=== PERSISTED FILES FOR prj_ms8re9qotmnr4ig7 (${files1.length}) ===`)
  for (const f of files1) {
    if (f.path.includes("page.tsx")) {
      console.log(`--- ${f.path} ---`)
      console.log(f.content.slice(0, 300))
    }
  }

  const files2 = await ProjectFilesystemService.readFiles("prj_mtpa508yu8nn9n9p")
  console.log(`\n=== PERSISTED FILES FOR prj_mtpa508yu8nn9n9p (${files2.length}) ===`)
  for (const f of files2) {
    if (f.path.includes("page.tsx") || f.path.includes("data.ts")) {
      console.log(`--- ${f.path} ---`)
      console.log(f.content.slice(0, 300))
    }
  }


  // Check sandbox on disk
  const sandboxDir = path.resolve(process.cwd(), ".swift-sandboxes")
  if (fs.existsSync(sandboxDir)) {
    const entries = fs.readdirSync(sandboxDir)
    console.log(`\n=== SANDBOX DIRECTORIES ===`, entries)
    for (const entry of entries) {
      const pageFile = path.join(sandboxDir, entry, "app", "page.tsx")
      if (fs.existsSync(pageFile)) {
        console.log(`--- Sandbox ${entry}/app/page.tsx ---`)
        console.log(fs.readFileSync(pageFile, "utf-8").slice(0, 300))
      }
    }
  }
}

main().catch(console.error)

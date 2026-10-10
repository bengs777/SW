import { db } from "@/lib/db/client"
import { projectFiles } from "@/lib/db/schema"
import { eq } from "drizzle-orm"

async function main() {
  const projectId = "prj_ms8re9qotmnr4ig7"
  const files = await db
    .select()
    .from(projectFiles)
    .where(eq(projectFiles.projectId, projectId))

  console.log(`=== 24 FILES IN DB FOR ${projectId} ===`)
  for (const f of files) {
    console.log(`\n================ FILE: ${f.path} ================`)
    console.log(f.content.slice(0, 400))
  }
}

main().catch(console.error)

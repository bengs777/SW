import { db } from "@/lib/db/client"
import { projects, projectFiles } from "@/lib/db/schema"
import { like, or } from "drizzle-orm"

async function main() {
  const allProjects = await db.select().from(projects)
  console.log("=== ALL PROJECTS IN DB ===")
  for (const p of allProjects) {
    console.log(`Project ID: ${p.id}, Name: ${p.name}, Prompt: ${p.prompt}`)
  }

  const aboutMeFiles = await db.select().from(projectFiles).where(
    or(
      like(projectFiles.content, "%About Me%"),
      like(projectFiles.content, "%portfolio%")
    )
  )
  console.log(`\n=== FILES WITH 'About Me' or 'portfolio' (${aboutMeFiles.length}) ===`)
  for (const f of aboutMeFiles) {
    console.log(`Project: ${f.projectId}, Path: ${f.path}`)
  }
}

main().catch(console.error)

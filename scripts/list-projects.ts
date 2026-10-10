import { db } from "@/lib/db/client"
import { projects } from "@/lib/db/schema"

async function main() {
  const { users } = await import("@/lib/db/schema")
  const allUsers = await db.select().from(users)
  console.log("Users in DB:")
  for (const u of allUsers) {
    console.log(`- ID: ${u.id} | Email: ${u.email} | Name: ${u.name}`)
  }

  const { ProjectFilesystemService } = await import("@/lib/services/project-filesystem.service")
  const files = await ProjectFilesystemService.readFiles("4fd98011-f8af-4e52-97b1-b1da1c417992")
  console.log(`\nFiles in 4fd98011-f8af-4e52-97b1-b1da1c417992: ${files.length}`)
  for (const f of files) {
    if (f.path.includes("page.tsx")) {
      console.log(`--- ${f.path} ---`)
      console.log(f.content.slice(0, 300))
    }
  }
}

main().catch(console.error)

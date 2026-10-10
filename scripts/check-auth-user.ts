import { db } from "@/lib/db/client"
import { users, projects } from "@/lib/db/schema"
import { eq } from "drizzle-orm"

async function main() {
  const allUsers = await db.select().from(users)
  console.log("Users in DB count:", allUsers.length)
  for (const u of allUsers) {
    console.log("User:", { id: u.id, email: u.email, name: u.name })
  }
  const proj = await db.select().from(projects).where(eq(projects.id, "prj_ms8re9qotmnr4ig7"))
  console.log("Project workspaceId:", proj[0]?.workspaceId)
}

main().catch(console.error)

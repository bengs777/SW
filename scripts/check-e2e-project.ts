import { db } from "@/lib/db/client"
import { projects, users } from "@/lib/db/schema"

async function main() {
  const allUsers = await db.select().from(users).limit(3)
  console.log("Users:", allUsers.map(u => ({ id: u.id, email: u.email })))
}

main().catch(console.error)

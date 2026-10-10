import { db } from "@/lib/db/client"
import { generationJobs } from "@/lib/db/schema"
import { eq } from "drizzle-orm"

async function main() {
  await db.update(generationJobs)
    .set({ status: "failed", updatedAt: new Date(), error: "Job timed out" })
    .where(eq(generationJobs.id, "57756d3c-a1ff-4ba6-a8da-d3ff72457cdf"))
  console.log("Stale job marked failed.")
}

main().catch(console.error)

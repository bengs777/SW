import { db } from "@/lib/db/client"
import { generationAttempts } from "@/lib/db/schema"
import { eq } from "drizzle-orm"

async function main() {
  const jobId = "045e1be4-410c-4d61-9b7e-6bbe1239eaa8"
  const attempts = await db.select().from(generationAttempts).where(eq(generationAttempts.jobId, jobId))
  for (const a of attempts) {
    console.log(`=== ATTEMPT ${a.sequence} ===`)
    const meta = JSON.parse(a.metadataJson || "{}")
    console.log("Provider Attempts:", JSON.stringify(meta.providerAttempts, null, 2))
  }
}

main().catch(console.error)

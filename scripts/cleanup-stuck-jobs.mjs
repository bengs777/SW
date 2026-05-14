#!/usr/bin/env node
/**
 * Cleanup stuck generation jobs.
 * 
 * Run this script to mark all stuck jobs (queued/running for >2 minutes) as failed.
 * This unblocks users from submitting new generation requests.
 *
 * Usage:
 *   node scripts/cleanup-stuck-jobs.mjs
 *
 * Requires DATABASE_URL environment variable.
 */

import { PrismaClient } from "@prisma/client"

const prisma = new PrismaClient()

const STUCK_THRESHOLD_MINUTES = 2

async function main() {
  const cutoff = new Date(Date.now() - STUCK_THRESHOLD_MINUTES * 60 * 1000)

  console.log(`[cleanup] Looking for jobs stuck since before ${cutoff.toISOString()}...`)

  const stuckJobs = await prisma.generationJob.findMany({
    where: {
      status: { in: ["queued", "running", "cancelling"] },
      updatedAt: { lt: cutoff },
    },
    select: {
      id: true,
      userId: true,
      status: true,
      createdAt: true,
      updatedAt: true,
    },
  })

  if (stuckJobs.length === 0) {
    console.log("[cleanup] No stuck jobs found. All clear!")
    return
  }

  console.log(`[cleanup] Found ${stuckJobs.length} stuck job(s):`)
  for (const job of stuckJobs) {
    console.log(`  - ${job.id} | status=${job.status} | created=${job.createdAt.toISOString()} | lastUpdate=${job.updatedAt.toISOString()}`)
  }

  const result = await prisma.generationJob.updateMany({
    where: {
      id: { in: stuckJobs.map((j) => j.id) },
      status: { in: ["queued", "running", "cancelling"] },
    },
    data: {
      status: "failed",
      error: "Manual cleanup - stuck job recovery",
      failedAt: new Date(),
      updatedAt: new Date(),
    },
  })

  console.log(`[cleanup] Marked ${result.count} job(s) as failed.`)
  console.log("[cleanup] Users can now submit new generation requests.")
}

main()
  .catch((error) => {
    console.error("[cleanup] Error:", error)
    process.exit(1)
  })
  .finally(() => prisma.$disconnect())

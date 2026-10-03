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
 * Requires TURSO_DATABASE_URL environment variable.
 */

import nextEnv from "@next/env"
import { createClient } from "@libsql/client"

const { loadEnvConfig } = nextEnv

loadEnvConfig(process.cwd())

const databaseUrl = process.env.TURSO_DATABASE_URL

if (!/^(libsql|https?):\/\//i.test(databaseUrl || "")) {
  throw new Error("TURSO_DATABASE_URL must be a libsql:// or https:// connection string")
}

const client = createClient({
  url: databaseUrl,
  authToken: process.env.TURSO_AUTH_TOKEN || undefined,
})

const STUCK_THRESHOLD_MINUTES = 2

async function main() {
  const cutoff = Math.floor(Date.now() / 1000) - STUCK_THRESHOLD_MINUTES * 60

  console.log(`[cleanup] Looking for jobs stuck since before ${new Date(cutoff * 1000).toISOString()}...`)

  const stuckJobs = await client.execute({
    sql: `SELECT id, user_id, status, created_at, updated_at
          FROM generation_jobs
          WHERE status IN ('queued', 'running', 'cancelling') AND updated_at < ?
          ORDER BY updated_at ASC`,
    args: [cutoff],
  })

  if (stuckJobs.rows.length === 0) {
    console.log("[cleanup] No stuck jobs found. All clear!")
    return
  }

  console.log(`[cleanup] Found ${stuckJobs.rows.length} stuck job(s):`)
  for (const job of stuckJobs.rows) {
    console.log(
      `  - ${job.id} | status=${job.status} | created=${new Date(Number(job.created_at) * 1000).toISOString()} | lastUpdate=${new Date(Number(job.updated_at) * 1000).toISOString()}`
    )
  }

  const ids = stuckJobs.rows.map((job) => String(job.id))
  const placeholders = ids.map(() => "?").join(", ")
  const now = Math.floor(Date.now() / 1000)

  const result = await client.execute({
    sql: `UPDATE generation_jobs
          SET status = 'failed',
              error = 'Manual cleanup - stuck job recovery',
              failed_at = ?,
              updated_at = ?
          WHERE id IN (${placeholders}) AND status IN ('queued', 'running', 'cancelling')`,
    args: [now, now, ...ids],
  })

  console.log(`[cleanup] Marked ${result.rowsAffected} job(s) as failed.`)
  console.log("[cleanup] Users can now submit new generation requests.")
}

main()
  .catch((error) => {
    console.error("[cleanup] Error:", error)
    process.exit(1)
  })
  .finally(() => {
    try {
      client.close()
    } catch {
      // ignore close errors
    }
  })

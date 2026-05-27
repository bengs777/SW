import { loadEnvConfig } from "@next/env"
import {
  cleanupReportStorage,
  getReportRetentionPolicy,
  getReportStoragePath,
} from "@/lib/runtime/report-storage"

loadEnvConfig(process.cwd())

async function main() {
  const dryRun = !process.argv.includes("--apply")
  const result = await cleanupReportStorage({ dryRun })

  console.log(JSON.stringify({
    dryRun,
    root: getReportStoragePath(),
    retentionPolicy: getReportRetentionPolicy(),
    cleanup: result,
  }, null, 2))
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})

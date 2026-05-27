import { readFile, readdir, stat } from "node:fs/promises"
import path from "node:path"
import { loadEnvConfig } from "@next/env"
import { getReportStoragePath, safeReportSegment } from "@/lib/runtime/report-storage"

loadEnvConfig(process.cwd())

type MigrationResult = {
  root: string
  bucket: string
  prefix: string
  scanned: number
  uploaded: number
  skipped: number
  errors: Array<{ path: string; message: string }>
}

const CONTENT_TYPES: Record<string, string> = {
  ".json": "application/json",
  ".log": "text/plain",
  ".txt": "text/plain",
  ".md": "text/markdown",
}

async function listFiles(root: string) {
  const files: string[] = []
  const queue = [root]
  const resolvedRoot = path.resolve(root)

  while (queue.length > 0) {
    const current = queue.shift()!
    const children = await readdir(current, { withFileTypes: true }).catch(() => [])

    for (const child of children) {
      const childPath = path.join(current, child.name)
      const resolved = path.resolve(childPath)
      if (!resolved.startsWith(`${resolvedRoot}${path.sep}`)) continue

      if (child.isDirectory()) {
        queue.push(childPath)
      } else if (child.isFile() && !child.name.startsWith(".tmp-")) {
        files.push(childPath)
      }
    }
  }

  return files
}

function contentTypeFor(filePath: string) {
  return CONTENT_TYPES[path.extname(filePath).toLowerCase()] || "application/octet-stream"
}

async function main() {
  const { uploadBufferToStorage } = await import("@/lib/supabase/storage")
  const { env } = await import("@/lib/env")
  const root = path.resolve(String(process.argv[2] || getReportStoragePath()))
  const bucket = String(process.argv[3] || process.env.SWIFT_REPORT_BLOB_BUCKET || env.supabaseStorageBucket || "")
  const prefix = safeReportSegment(String(process.argv[4] || process.env.SWIFT_REPORT_BLOB_PREFIX || "swift-reports"))

  if (!bucket) {
    throw new Error("Missing report blob bucket. Set SWIFT_REPORT_BLOB_BUCKET or SUPABASE_STORAGE_BUCKET.")
  }

  const rootStat = await stat(root).catch(() => null)
  if (!rootStat?.isDirectory()) {
    throw new Error(`Report root does not exist or is not a directory: ${root}`)
  }

  const result: MigrationResult = {
    root,
    bucket,
    prefix,
    scanned: 0,
    uploaded: 0,
    skipped: 0,
    errors: [],
  }

  const files = await listFiles(root)
  for (const filePath of files) {
    result.scanned += 1
    const relative = path.relative(root, filePath).split(path.sep).map(safeReportSegment).join("/")
    const storagePath = `${prefix}/${relative}`

    try {
      const buffer = await readFile(filePath)
      await uploadBufferToStorage({
        bucket,
        storagePath,
        buffer,
        contentType: contentTypeFor(filePath),
        cacheControl: "86400",
      })
      result.uploaded += 1
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (/already exists|duplicate/i.test(message)) {
        result.skipped += 1
      } else {
        result.errors.push({ path: filePath, message })
      }
    }
  }

  console.log(JSON.stringify(result, null, 2))
  if (result.errors.length > 0) {
    process.exitCode = 1
  }
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})

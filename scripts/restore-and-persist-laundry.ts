import fs from "node:fs"
import path from "node:path"
import { db } from "@/lib/db/client"
import { projectFiles, generationJobs } from "@/lib/db/schema"
import { eq } from "drizzle-orm"
import { ProjectFilesystemService } from "@/lib/services/project-filesystem.service"
import type { GeneratedFile } from "@/lib/types"

const PROJECT_ID = "prj_ms8re9qotmnr4ig7"
const SOURCE_DIR = path.resolve(process.cwd(), ".swift-sandboxes", PROJECT_ID)
const USER_DIR = path.resolve(process.cwd(), ".swift-sandboxes", "usr_ms8rdt5x7453pgq6-prj_ms8re9qotmnr4ig7")

function getLanguage(filePath: string): GeneratedFile["language"] {
  const ext = path.extname(filePath).toLowerCase()
  switch (ext) {
    case ".ts":
      return "ts"
    case ".tsx":
      return "tsx"
    case ".css":
      return "css"
    case ".json":
      return "json"
    case ".html":
      return "html"
    case ".md":
      return "md"
    default:
      return "ts"
  }
}

function collectFiles(dir: string, baseDir: string): GeneratedFile[] {
  const results: GeneratedFile[] = []
  const entries = fs.readdirSync(dir, { withFileTypes: true })

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name)
    const relPath = path.relative(baseDir, fullPath).replace(/\\/g, "/")

    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === ".next") {
        continue
      }
      results.push(...collectFiles(fullPath, baseDir))
    } else if (entry.isFile()) {
      if (entry.name.startsWith(".") || entry.name.endsWith(".tsbuildinfo") || entry.name === ".DS_Store") {
        continue
      }
      try {
        const { validateGeneratedPath } = require("@/lib/ai/file-policy")
        validateGeneratedPath(relPath, process.cwd(), {
          allowManagedPackageJson: true,
          allowManagedWorkspaceState: true,
        })
        const content = fs.readFileSync(fullPath, "utf8")
        results.push({
          path: relPath,
          content,
          language: getLanguage(relPath),
        })
      } catch {
        // Skip files that are not valid generated paths (e.g. eslint.config.mjs, next-env.d.ts)
      }
    }
  }

  return results
}

async function main() {
  console.log(`Collecting files from ${SOURCE_DIR}...`)
  const files = collectFiles(SOURCE_DIR, SOURCE_DIR)
  console.log(`Found ${files.length} project files.`)

  for (const f of files) {
    console.log(`  - ${f.path} (${f.content.length} chars)`)
  }

  console.log(`\nPersisting ${files.length} files to database for project ${PROJECT_ID}...`)
  const writeResult = await ProjectFilesystemService.replaceFiles({
    projectId: PROJECT_ID,
    files,
  })

  console.log("Persistence result:", {
    created: writeResult.fileDiff.created,
    updated: writeResult.fileDiff.updated,
    deleted: writeResult.fileDiff.deleted,
    unchanged: writeResult.fileDiff.unchanged,
    finalFileCount: writeResult.fileDiff.finalFileCount,
    manifestHash: writeResult.manifest.sha256,
  })

  // Update latest generation job previewUrl to point to port 4688
  console.log("\nUpdating generationJobs previewUrl to http://127.0.0.1:4688...")
  await db
    .update(generationJobs)
    .set({ previewUrl: "http://127.0.0.1:4688" })
    .where(eq(generationJobs.projectId, PROJECT_ID))

  // Sync to user directory if it exists
  if (fs.existsSync(USER_DIR)) {
    console.log(`\nSyncing restored files to user-scoped directory: ${USER_DIR}`)
    for (const file of files) {
      const destPath = path.join(USER_DIR, file.path)
      fs.mkdirSync(path.dirname(destPath), { recursive: true })
      fs.writeFileSync(destPath, file.content, "utf8")
    }
    console.log("User-scoped directory synced.")
  }

  console.log("\nAll project files restored and persisted successfully!")
}

main().catch((err) => {
  console.error("Failed to restore and persist:", err)
  process.exit(1)
})

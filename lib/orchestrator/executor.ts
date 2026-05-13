import type { GeneratedFile } from "@/lib/types"
import { prisma } from "@/lib/db/client"
import { ProjectFilePersistenceService } from "@/lib/services/project-file-persistence.service"
import { validateFullStackFiles } from "@/lib/ai/fullstack-validator"

type ApplyFilesResult = Awaited<ReturnType<typeof ProjectFilePersistenceService.saveGenerationSnapshot>>

async function sleep(ms: number) {
  return new Promise((res) => setTimeout(res, ms))
}

export async function runWithDatabaseRetry<T>(fn: () => Promise<T>, maxAttempts = 5): Promise<T> {
  let lastError: unknown = null
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    try {
      return await fn()
    } catch (err) {
      lastError = err
      const msg = err && (err instanceof Error ? err.message : String(err))
      if (/SQLITE_BUSY|database is locked|deadlock detected|could not serialize access|connection terminated|ECONNRESET|ETIMEDOUT/i.test(String(msg))) {
        await sleep(120 * (attempt + 1))
        continue
      }
      throw err
    }
  }

  throw lastError
}

export async function applyFiles(
  projectId: string,
  prompt: string,
  files: GeneratedFile[]
): Promise<ApplyFilesResult> {
  const op = async () => {
    const existingFiles = await prisma.projectFile.findMany({
      where: { projectId },
      orderBy: { path: "asc" },
    })
    const merged = new Map<string, GeneratedFile>()

    for (const file of ProjectFilePersistenceService.normalizeFiles(existingFiles as GeneratedFile[])) {
      merged.set(file.path, file)
    }

    for (const file of ProjectFilePersistenceService.normalizeFiles(files)) {
      merged.set(file.path, file)
    }

    return ProjectFilePersistenceService.saveGenerationSnapshot(
      projectId,
      prompt,
      Array.from(merged.values())
    )
  }
  return runWithDatabaseRetry(op)
}

export async function validateFiles(files: GeneratedFile[]) {
  const result = validateFullStackFiles(files)
  return {
    valid: result.missingCategories.length === 0,
    result,
  }
}

const executor = { applyFiles, validateFiles, runWithDatabaseRetry }

export default executor

import type { GeneratedFile } from "@/lib/types"
import { ProjectFilePersistenceService } from "@/lib/services/project-file-persistence.service"
import { validateFullStackFiles } from "@/lib/ai/fullstack-validator"

type ApplyFilesResult = Awaited<ReturnType<typeof ProjectFilePersistenceService.saveGenerationSnapshot>>

async function sleep(ms: number) {
  return new Promise((res) => setTimeout(res, ms))
}

export async function runWithSqliteRetry<T>(fn: () => Promise<T>, maxAttempts = 5): Promise<T> {
  let lastError: unknown = null
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    try {
      return await fn()
    } catch (err) {
      lastError = err
      const msg = err && (err instanceof Error ? err.message : String(err))
      if (/SQLITE_BUSY/i.test(String(msg))) {
        // backoff
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
  const op = () => ProjectFilePersistenceService.saveGenerationSnapshot(projectId, prompt, files)
  // Save with retry to mitigate SQLITE_BUSY on local dev
  return runWithSqliteRetry(op)
}

export async function validateFiles(files: GeneratedFile[]) {
  const result = validateFullStackFiles(files)
  return {
    valid: result.missingCategories.length === 0,
    result,
  }
}

export default { applyFiles, validateFiles, runWithSqliteRetry }

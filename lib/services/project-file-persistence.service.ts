import { db } from "@/lib/db/client"
import { generationHistory, generationJobs, projects } from "@/lib/db/schema"
import { eq, and, desc, notInArray, sql } from "drizzle-orm"
import { withDatabaseWriteRetry } from "@/lib/db/errors"
import { log } from "@/lib/logging"
import {
  ProjectFilesystemService,
  type DbClient,
  type ProjectFileDiff,
  type ProjectFileManifest,
} from "@/lib/services/project-filesystem.service"
import type { GeneratedFile } from "@/lib/types"

type PersistProjectFilesOptions = {
  idempotencyKey?: string | null
  cost?: number | null
  intent?: string | null
  usedAutoRepair?: boolean
  projectMemoryJson?: string | null
  tokensUsed?: number | null
  generationJobId?: string | null
}

export class ProjectFilePersistenceService {
  static normalizeFiles(files: GeneratedFile[]) {
    return ProjectFilesystemService.normalizeFiles(files)
  }

  static async saveGenerationSnapshot(
    projectId: string,
    prompt: string,
    files: GeneratedFile[],
    opts?: PersistProjectFilesOptions
  ): Promise<{
    historyId: string
    files: GeneratedFile[]
    fileDiff: ProjectFileDiff
    integrity: ProjectFileManifest
    manifest: ProjectFileManifest
  }> {
    const normalizedFiles = ProjectFilesystemService.normalizeFiles(files)
    const startedAt = Date.now()

    try {
      return await withDatabaseWriteRetry(() =>
        db.transaction(async (tx) => {
          if (opts?.generationJobId) {
            await assertLatestProjectGeneration(tx, projectId, opts.generationJobId)
          }

          const historyData = {
            prompt,
            result: JSON.stringify(normalizedFiles),
            tokensUsed: opts?.tokensUsed ?? 0,
            cost: opts?.cost ?? 0,
            intent: opts?.intent || null,
            usedAutoRepair: Boolean(opts?.usedAutoRepair),
          }

          let createdHistory
          if (opts?.idempotencyKey) {
            const existing = await tx.select().from(generationHistory)
              .where(and(
                eq(generationHistory.projectId, projectId),
                eq(generationHistory.idempotencyKey, opts.idempotencyKey)
              ))
              .limit(1)

            if (existing.length > 0) {
              const result = await tx.update(generationHistory)
                .set(historyData)
                .where(and(
                  eq(generationHistory.projectId, projectId),
                  eq(generationHistory.idempotencyKey, opts.idempotencyKey)
                ))
                .returning()
              createdHistory = result[0]
            } else {
              const result = await tx.insert(generationHistory)
                .values({
                  id: crypto.randomUUID(),
                  projectId,
                  idempotencyKey: opts.idempotencyKey,
                  ...historyData,
                })
                .returning()
              createdHistory = result[0]
            }
          } else {
            const result = await tx.insert(generationHistory)
              .values({
                id: crypto.randomUUID(),
                projectId,
                ...historyData,
              })
              .returning()
            createdHistory = result[0]
          }

          const filesystemWrite = await ProjectFilesystemService.replaceFiles({
            projectId,
            files: normalizedFiles,
            tx,
          })

          const endedAt = Date.now()
          log("info", "files_written", {
            event: "files_written",
            jobId: opts?.generationJobId || null,
            projectId,
            startedAt: new Date(startedAt).toISOString(),
            endedAt: new Date(endedAt).toISOString(),
            durationMs: endedAt - startedAt,
            historyId: createdHistory.id,
            fileCount: filesystemWrite.files.length,
            fileDiff: filesystemWrite.fileDiff,
            manifest: filesystemWrite.manifest,
          })

          await tx.update(projects)
            .set({
              prompt,
              ...(opts?.projectMemoryJson ? { memoryJson: opts.projectMemoryJson } : {}),
            })
            .where(eq(projects.id, projectId))

          return {
            historyId: createdHistory.id,
            files: filesystemWrite.files,
            fileDiff: filesystemWrite.fileDiff,
            integrity: filesystemWrite.manifest,
            manifest: filesystemWrite.manifest,
          }
        })
      )
    } catch (error) {
      log("error", "project_files_persistence_failed", {
        event: "project_files_persistence_failed",
        jobId: opts?.generationJobId || null,
        projectId,
        generatedFileCount: normalizedFiles.length,
        committedFileCount: 0,
        persistedSnapshotId: null,
        failedWritePaths: normalizedFiles.map((file) => file.path),
        error: error instanceof Error ? error.message : String(error),
      })
      throw error
    }
  }

  static async saveBufferedArtifacts(input: {
    projectId: string
    prompt: string
    files: GeneratedFile[]
    projectMemoryJson?: string | null
    idempotencyKey?: string | null
    cost?: number | null
    intent?: string | null
    usedAutoRepair?: boolean
    tokensUsed?: number | null
    generationJobId?: string | null
  }) {
    return this.saveGenerationSnapshot(input.projectId, input.prompt, input.files, {
      projectMemoryJson: input.projectMemoryJson,
      idempotencyKey: input.idempotencyKey,
      cost: input.cost,
      intent: input.intent,
      usedAutoRepair: input.usedAutoRepair,
      tokensUsed: input.tokensUsed,
      generationJobId: input.generationJobId,
    })
  }
}

async function assertLatestProjectGeneration(
  tx: DbClient,
  projectId: string,
  generationJobId: string
) {
  const currentJobResult = await tx.select({ id: generationJobs.id, createdAt: generationJobs.createdAt })
    .from(generationJobs)
    .where(eq(generationJobs.id, generationJobId))
    .limit(1)

  const currentJob = currentJobResult[0]
  if (!currentJob) {
    throw new Error("Generation job not found for persistence guard.")
  }

  const newerJobResult = await tx.select({
    id: generationJobs.id,
    status: generationJobs.status,
    stage: generationJobs.stage,
    createdAt: generationJobs.createdAt,
  }).from(generationJobs)
    .where(and(
      eq(generationJobs.projectId, projectId),
      sql`${generationJobs.createdAt} > ${currentJob.createdAt}`,
      notInArray(generationJobs.status, ["failed", "cancelled"])
    ))
    .orderBy(desc(generationJobs.createdAt))
    .limit(1)

  const newerJob = newerJobResult[0]

  if (newerJob) {
    throw new Error(`StaleGenerationRejected: newer generation ${newerJob.id} is ${newerJob.status}/${newerJob.stage}.`)
  }
}

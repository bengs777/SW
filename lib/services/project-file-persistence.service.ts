import type { Prisma } from "@prisma/client"
import { prisma } from "@/lib/db/client"
import { withDatabaseWriteRetry } from "@/lib/db/errors"
import { log } from "@/lib/logging"
import {
  ProjectFilesystemService,
  type ProjectFileDiff,
  type ProjectFileManifest,
} from "@/lib/services/project-filesystem.service"
import type { GeneratedFile } from "@/lib/types"

type PersistProjectFilesOptions = {
  idempotencyKey?: string | null
  cost?: number | null
  projectMemoryJson?: string | null
  tokensUsed?: number | null
  generationJobId?: string | null
}

const PERSISTENCE_TRANSACTION_OPTIONS = {
  maxWait: 15_000,
  timeout: 30_000,
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

    return withDatabaseWriteRetry(() =>
      prisma.$transaction(async (tx) => {
        if (opts?.generationJobId) {
          await assertLatestProjectGeneration(tx, projectId, opts.generationJobId)
        }

        const historyData = {
          prompt,
          result: JSON.stringify(normalizedFiles),
          tokensUsed: opts?.tokensUsed ?? 0,
          cost: opts?.cost ?? 0,
        }

        const createdHistory = opts?.idempotencyKey
          ? await tx.generationHistory.upsert({
              where: {
                projectId_idempotencyKey: {
                  projectId,
                  idempotencyKey: opts.idempotencyKey,
                },
              },
              create: {
                projectId,
                idempotencyKey: opts.idempotencyKey,
                ...historyData,
              },
              update: historyData,
            })
          : await tx.generationHistory.create({
              data: {
                projectId,
                ...historyData,
              },
            })

        const filesystemWrite = await ProjectFilesystemService.replaceFiles({
          projectId,
          files: normalizedFiles,
          tx,
        })

        log("info", "files_written", {
          jobId: opts?.generationJobId || null,
          projectId,
          historyId: createdHistory.id,
          fileDiff: filesystemWrite.fileDiff,
          manifest: filesystemWrite.manifest,
        })

        await tx.project.update({
          where: { id: projectId },
          data: {
            prompt,
            ...(opts?.projectMemoryJson ? { memoryJson: opts.projectMemoryJson } : {}),
          },
        })

        return {
          historyId: createdHistory.id,
          files: filesystemWrite.files,
          fileDiff: filesystemWrite.fileDiff,
          integrity: filesystemWrite.manifest,
          manifest: filesystemWrite.manifest,
        }
      }, PERSISTENCE_TRANSACTION_OPTIONS)
    )
  }

  static async saveBufferedArtifacts(input: {
    projectId: string
    prompt: string
    files: GeneratedFile[]
    projectMemoryJson?: string | null
    idempotencyKey?: string | null
    cost?: number | null
    tokensUsed?: number | null
    generationJobId?: string | null
  }) {
    return this.saveGenerationSnapshot(input.projectId, input.prompt, input.files, {
      projectMemoryJson: input.projectMemoryJson,
      idempotencyKey: input.idempotencyKey,
      cost: input.cost,
      tokensUsed: input.tokensUsed,
      generationJobId: input.generationJobId,
    })
  }
}

async function assertLatestProjectGeneration(
  tx: Prisma.TransactionClient,
  projectId: string,
  generationJobId: string
) {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${projectId}))`

  const currentJob = await tx.generationJob.findUnique({
    where: { id: generationJobId },
    select: { id: true, createdAt: true },
  })
  if (!currentJob) {
    throw new Error("Generation job not found for persistence guard.")
  }

  const newerJob = await tx.generationJob.findFirst({
    where: {
      projectId,
      createdAt: { gt: currentJob.createdAt },
      status: { notIn: ["failed", "cancelled"] },
    },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      status: true,
      stage: true,
      createdAt: true,
    },
  })

  if (newerJob) {
    throw new Error(`StaleGenerationRejected: newer generation ${newerJob.id} is ${newerJob.status}/${newerJob.stage}.`)
  }
}

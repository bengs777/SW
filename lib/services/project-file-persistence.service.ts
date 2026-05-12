import type { Prisma } from "@prisma/client"
import { prisma } from "@/lib/db/client"
import { withSqliteBusyRetry } from "@/lib/db/errors"
import type { GeneratedFile } from "@/lib/types"
import { normalizeFileLanguage } from "@/lib/workspace-state"

type PersistProjectFilesOptions = {
  idempotencyKey?: string | null
  cost?: number | null
  projectMemoryJson?: string | null
  tokensUsed?: number | null
}

type ProjectFileDiff = {
  created: number
  updated: number
  deleted: number
  unchanged: number
  finalFileCount: number
}

const normalizeFilePath = (path: string) =>
  path.replace(/\\/g, "/").replace(/^\.\//, "").trim()

const dedupeFilesByPath = (files: GeneratedFile[]) => {
  const fileMap = new Map<string, GeneratedFile>()

  for (const file of files) {
    const path = normalizeFilePath(file.path)
    if (!path) {
      continue
    }

    fileMap.set(path, {
      ...file,
      path,
      language: normalizeFileLanguage(file.language),
      content: String(file.content ?? ""),
    })
  }

  return Array.from(fileMap.values()).sort((left, right) =>
    left.path.localeCompare(right.path)
  )
}

async function syncProjectFiles(
  tx: Prisma.TransactionClient,
  projectId: string,
  files: GeneratedFile[]
): Promise<ProjectFileDiff> {
  const normalizedFiles = dedupeFilesByPath(files)
  const nextPaths = normalizedFiles.map((file) => file.path)
  const existingFiles = await tx.projectFile.findMany({
    where: { projectId },
    select: {
      id: true,
      path: true,
      content: true,
      language: true,
    },
  })
  const existingByPath = new Map(existingFiles.map((file) => [file.path, file]))

  const creates: GeneratedFile[] = []
  const updates: Array<{ id: string; content: string; language: string }> = []
  let created = 0
  let updated = 0
  let unchanged = 0

  for (const file of normalizedFiles) {
    const existing = existingByPath.get(file.path)
    const language = normalizeFileLanguage(file.language)

    if (existing && existing.content === file.content && existing.language === language) {
      unchanged += 1
      continue
    }

    if (existing) {
      updated += 1
    } else {
      created += 1
    }

    if (existing) {
      updates.push({
        id: existing.id,
        content: file.content,
        language,
      })
      continue
    }

    creates.push({
      ...file,
      language,
    })
  }

  if (creates.length > 0) {
    await tx.projectFile.createMany({
      data: creates.map((file) => ({
        id: crypto.randomUUID(),
        projectId,
        path: file.path,
        content: file.content,
        language: normalizeFileLanguage(file.language),
      })),
    })
  }

  for (const item of updates) {
    await tx.projectFile.update({
      where: { id: item.id },
      data: {
        content: item.content,
        language: item.language,
        updatedAt: new Date(),
      },
    })
  }

  const staleFiles = existingFiles.filter((file) => !nextPaths.includes(file.path))
  const deleted = staleFiles.length

  if (deleted > 0) {
    await tx.projectFile.deleteMany({
      where: {
        projectId,
        path: {
          in: staleFiles.map((file) => file.path),
        },
      },
    })
  }

  return {
    created,
    updated,
    deleted,
    unchanged,
    finalFileCount: normalizedFiles.length,
  }
}

export class ProjectFilePersistenceService {
  static normalizeFiles(files: GeneratedFile[]) {
    return dedupeFilesByPath(files)
  }

  static async saveGenerationSnapshot(
    projectId: string,
    prompt: string,
    files: GeneratedFile[],
    opts?: PersistProjectFilesOptions
  ) {
    const normalizedFiles = dedupeFilesByPath(files)

    return withSqliteBusyRetry(() => prisma.$transaction(async (tx) => {
      const createdHistory = await tx.generationHistory.create({
        data: {
          projectId,
          prompt,
          result: JSON.stringify(normalizedFiles),
          tokensUsed: opts?.tokensUsed ?? 0,
          ...(opts?.idempotencyKey ? { idempotencyKey: opts.idempotencyKey } : {}),
          cost: opts?.cost ?? 0,
        },
      })

      const fileDiff = await syncProjectFiles(tx, projectId, normalizedFiles)

      await tx.project.update({
        where: { id: projectId },
        data: {
          prompt,
          ...(opts?.projectMemoryJson ? { memoryJson: opts.projectMemoryJson } : {}),
        },
      })

      return {
        historyId: createdHistory.id,
        files: normalizedFiles,
        fileDiff,
      }
    }))
  }

  static async saveBufferedArtifacts(input: {
    projectId: string
    prompt: string
    files: GeneratedFile[]
    projectMemoryJson?: string | null
    idempotencyKey?: string | null
    cost?: number | null
    tokensUsed?: number | null
  }) {
    return this.saveGenerationSnapshot(input.projectId, input.prompt, input.files, {
      projectMemoryJson: input.projectMemoryJson,
      idempotencyKey: input.idempotencyKey,
      cost: input.cost,
      tokensUsed: input.tokensUsed,
    })
  }
}

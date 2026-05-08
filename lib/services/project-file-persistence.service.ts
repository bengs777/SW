import type { Prisma } from "@prisma/client"
import { prisma } from "@/lib/db/client"
import type { GeneratedFile } from "@/lib/types"

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

const normalizeLanguage = (language: GeneratedFile["language"] | string | null | undefined) =>
  language || "ts"

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
      language: normalizeLanguage(file.language) as GeneratedFile["language"],
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

  let created = 0
  let updated = 0
  let unchanged = 0

  for (const file of normalizedFiles) {
    const existing = existingByPath.get(file.path)
    const language = normalizeLanguage(file.language)

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
      await tx.projectFile.update({
        where: { id: existing.id },
        data: {
          content: file.content,
          language,
          updatedAt: new Date(),
        },
      })
      continue
    }

    await tx.projectFile.create({
      data: {
        id: crypto.randomUUID(),
        projectId,
        path: file.path,
        content: file.content,
        language,
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

    return prisma.$transaction(async (tx) => {
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
    })
  }
}

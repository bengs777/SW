import { db } from "@/lib/db/client"
import { generationHistory } from "@/lib/db/schema"
import { eq, and, inArray, asc } from "drizzle-orm"
import type { GeneratedFile } from "@/lib/types"
import { ProjectFilePersistenceService } from "@/lib/services/project-file-persistence.service"
import { ProjectFilesystemService } from "@/lib/services/project-filesystem.service"

export type ProjectVersionSummary = {
  id: string
  label: string
  version: number
  createdAt: string
  prompt: string
  fileCount: number
}

export async function listProjectVersions(projectId: string): Promise<ProjectVersionSummary[]> {
  const histories = await db.query.generationHistory.findMany({
    where: eq(generationHistory.projectId, projectId),
    orderBy: [asc(generationHistory.createdAt)],
    columns: { id: true, prompt: true, result: true, createdAt: true },
  })

  return histories.map((history, index) => ({
    id: history.id,
    label: `v${index + 1}`,
    version: index + 1,
    createdAt: history.createdAt.toISOString(),
    prompt: history.prompt,
    fileCount: parseVersionFiles(history.result).length,
  }))
}

export async function snapshotProjectVersion(input: {
  projectId: string
  prompt: string
  files: GeneratedFile[]
  intent?: string | null
  idempotencyKey?: string | null
}) {
  const result = await ProjectFilePersistenceService.saveGenerationSnapshot(input.projectId, input.prompt, input.files, {
    intent: input.intent,
    idempotencyKey: input.idempotencyKey,
  })
  const versions = await listProjectVersions(input.projectId)
  const version = versions.find((item) => item.id === result.historyId)
  return {
    ...result,
    version: version?.version || versions.length,
    label: version?.label || `v${versions.length}`,
  }
}

export async function rollbackProjectVersion(input: {
  projectId: string
  historyId: string
  reason: string
}) {
  const target = await db.query.generationHistory.findFirst({
    where: and(
      eq(generationHistory.id, input.historyId),
      eq(generationHistory.projectId, input.projectId)
    ),
    columns: { id: true, prompt: true, result: true, createdAt: true },
  })
  if (!target) throw new Error("Project version not found.")

  const files = parseVersionFiles(target.result)
  if (files.length === 0) throw new Error("Project version snapshot is empty.")

  return ProjectFilePersistenceService.saveGenerationSnapshot(
    input.projectId,
    `Rollback to ${target.createdAt.toISOString()}: ${input.reason || target.prompt}`,
    files,
    { intent: "rollback" }
  )
}

export async function compareProjectVersions(input: {
  projectId: string
  fromHistoryId: string
  toHistoryId: string
}) {
  const versions = await db.query.generationHistory.findMany({
    where: and(
      eq(generationHistory.projectId, input.projectId),
      inArray(generationHistory.id, [input.fromHistoryId, input.toHistoryId])
    ),
    columns: { id: true, result: true },
  })
  const from = versions.find((item) => item.id === input.fromHistoryId)
  const to = versions.find((item) => item.id === input.toHistoryId)
  if (!from || !to) throw new Error("Both project versions are required for compare.")

  return compareFiles(parseVersionFiles(from.result), parseVersionFiles(to.result))
}

export function compareFiles(before: GeneratedFile[], after: GeneratedFile[]) {
  const beforeByPath = new Map(ProjectFilesystemService.normalizeFiles(before).map((file) => [file.path, file]))
  const afterByPath = new Map(ProjectFilesystemService.normalizeFiles(after).map((file) => [file.path, file]))
  const created: string[] = []
  const modified: string[] = []
  const deleted: string[] = []

  for (const [path, file] of afterByPath) {
    const previous = beforeByPath.get(path)
    if (!previous) {
      created.push(path)
    } else if (previous.content !== file.content || previous.language !== file.language) {
      modified.push(path)
    }
  }

  for (const path of beforeByPath.keys()) {
    if (!afterByPath.has(path)) deleted.push(path)
  }

  return {
    created: created.sort(),
    modified: modified.sort(),
    deleted: deleted.sort(),
    changedFileCount: created.length + modified.length + deleted.length,
  }
}

function parseVersionFiles(result: string): GeneratedFile[] {
  const parsed = JSON.parse(result)
  if (!Array.isArray(parsed)) return []
  return ProjectFilePersistenceService.normalizeFiles(parsed as GeneratedFile[])
}

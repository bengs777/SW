import { createHash, randomUUID } from "node:crypto"
import { db } from "@/lib/db/client"
import { projectFiles } from "@/lib/db/schema"
import { eq, and, asc, inArray } from "drizzle-orm"
import { normalizeGeneratedPath, validateGeneratedPath } from "@/lib/ai/file-policy"
import type { GeneratedFile } from "@/lib/types"
import { normalizeFileLanguage } from "@/lib/workspace-state"

export type ProjectFileManifest = {
  count: number
  totalBytes: number
  sha256: string
  paths: string[]
  fileHashes: Record<string, string>
}

export type ProjectFileDiff = {
  created: number
  updated: number
  deleted: number
  unchanged: number
  finalFileCount: number
}

export type ProjectFilesystemOperation = {
  action: "create" | "modify" | "delete"
  path: string
  content?: string
  language?: GeneratedFile["language"] | string | null
}

export type DbClient = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0]
type ProjectFilesystemWriteResult = {
  files: GeneratedFile[]
  fileDiff: ProjectFileDiff
  manifest: ProjectFileManifest
}

const MAX_PROJECT_FILES = 100
const MAX_TOTAL_FILE_BYTES = 5 * 1024 * 1024
const MAX_SINGLE_FILE_BYTES = 200 * 1024

export class PersistenceIntegrityError extends Error {
  constructor(message: string, public expected: ProjectFileManifest, public actual: ProjectFileManifest) {
    super(message)
    this.name = "PersistenceIntegrityError"
  }
}

export class ProjectFilesystemService {
  static normalizeFiles(files: GeneratedFile[]) {
    return normalizeFiles(files)
  }

  static buildManifest(files: GeneratedFile[]): ProjectFileManifest {
    return buildManifest(normalizeFiles(files))
  }

  static async readFiles(projectId: string, tx: DbClient = db): Promise<GeneratedFile[]> {
    const files = await tx.select().from(projectFiles)
      .where(eq(projectFiles.projectId, projectId))
      .orderBy(asc(projectFiles.path))

    return normalizeFiles(
      files.map((file) => ({
        path: file.path,
        content: file.content,
        language: normalizeFileLanguage(file.language),
      }))
    )
  }

  static async readTree(projectId: string, tx: DbClient = db) {
    const files = await this.readFiles(projectId, tx)
    return buildTree(files)
  }

  static async writeBatch(input: {
    projectId: string
    operations: ProjectFilesystemOperation[]
    tx?: DbClient
  }): Promise<ProjectFilesystemWriteResult> {
    if (!input.tx) {
      return db.transaction((tx) =>
        this.writeBatch({
          ...input,
          tx,
        })
      )
    }

    const currentFiles = await this.readFiles(input.projectId, input.tx || db)
    const nextByPath = new Map(currentFiles.map((file) => [normalizeGeneratedPath(file.path), file]))

    for (const operation of input.operations) {
      const path = validateGeneratedPath(operation.path, process.cwd(), {
        allowManagedPackageJson: true,
        allowManagedWorkspaceState: true,
      }).path

      if (operation.action === "delete") {
        nextByPath.delete(path)
        continue
      }

      nextByPath.set(path, {
        path,
        content: String(operation.content ?? ""),
        language: normalizeFileLanguage(operation.language),
      })
    }

    return this.replaceFiles({
      projectId: input.projectId,
      files: Array.from(nextByPath.values()),
      tx: input.tx,
    })
  }

  static async replaceFiles(input: {
    projectId: string
    files: GeneratedFile[]
    tx?: DbClient
  }): Promise<ProjectFilesystemWriteResult> {
    if (!input.tx) {
      return db.transaction((tx) =>
        this.replaceFiles({
          ...input,
          tx,
        })
      )
    }

    const normalizedFiles = normalizeFiles(input.files)
    const expectedManifest = buildManifest(normalizedFiles)
    const tx = input.tx || db

    const fileDiff = await syncProjectFiles(tx, input.projectId, normalizedFiles)
    const actualManifest = await this.verify(input.projectId, expectedManifest, tx)

    return {
      files: normalizedFiles,
      fileDiff,
      manifest: actualManifest,
    }
  }

  static async verify(projectId: string, expectedManifest: ProjectFileManifest, tx: DbClient = db) {
    const persistedFiles = await this.readFiles(projectId, tx)
    const actualManifest = buildManifest(persistedFiles)

    if (actualManifest.sha256 !== expectedManifest.sha256) {
      throw new PersistenceIntegrityError(
        "Project filesystem manifest mismatch after write.",
        expectedManifest,
        actualManifest
      )
    }

    return actualManifest
  }
}

async function syncProjectFiles(
  tx: DbClient,
  projectId: string,
  normalizedFiles: GeneratedFile[]
): Promise<ProjectFileDiff> {
  const nextPaths = normalizedFiles.map((file) => file.path)
  const existingFiles = await tx.select({
    id: projectFiles.id,
    path: projectFiles.path,
    content: projectFiles.content,
    language: projectFiles.language,
  }).from(projectFiles)
    .where(eq(projectFiles.projectId, projectId))

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
      updates.push({
        id: existing.id,
        content: file.content,
        language,
      })
      continue
    }

    created += 1
    creates.push({
      ...file,
      language,
    })
  }

  if (creates.length > 0) {
    await tx.insert(projectFiles).values(
      creates.map((file) => ({
        id: randomUUID(),
        projectId,
        path: file.path,
        content: file.content,
        language: normalizeFileLanguage(file.language),
      }))
    )
  }

  for (const item of updates) {
    await tx.update(projectFiles)
      .set({
        content: item.content,
        language: item.language,
        updatedAt: new Date(),
      })
      .where(eq(projectFiles.id, item.id))
  }

  const staleFiles = existingFiles.filter((file) => !nextPaths.includes(file.path))
  const deleted = staleFiles.length

  if (deleted > 0) {
    await tx.delete(projectFiles)
      .where(and(
        eq(projectFiles.projectId, projectId),
        inArray(projectFiles.path, staleFiles.map((file) => file.path))
      ))
  }

  return {
    created,
    updated,
    deleted,
    unchanged,
    finalFileCount: normalizedFiles.length,
  }
}

function normalizeFiles(files: GeneratedFile[]) {
  if (files.length > MAX_PROJECT_FILES) {
    throw new Error(`Too many generated files. Maximum: ${MAX_PROJECT_FILES}`)
  }

  const fileMap = new Map<string, GeneratedFile>()
  let totalBytes = 0

  for (const file of files) {
    const path = validateGeneratedPath(file.path, process.cwd(), {
      allowManagedPackageJson: true,
      allowManagedWorkspaceState: true,
    }).path
    if (!path) continue

    const content = String(file.content ?? "")
    const size = Buffer.byteLength(content, "utf8")
    if (size > MAX_SINGLE_FILE_BYTES) {
      throw new Error(`Generated file ${path} exceeds the single-file size limit.`)
    }

    totalBytes += size
    if (totalBytes > MAX_TOTAL_FILE_BYTES) {
      throw new Error("Generated files exceed the total size limit.")
    }

    fileMap.set(path, {
      path,
      language: normalizeFileLanguage(file.language),
      content,
    })
  }

  return Array.from(fileMap.values()).sort((left, right) => left.path.localeCompare(right.path))
}

function buildManifest(files: GeneratedFile[]): ProjectFileManifest {
  const normalizedFiles = normalizeFiles(files)
  const hash = createHash("sha256")
  let totalBytes = 0
  const fileHashes: Record<string, string> = {}

  for (const file of normalizedFiles) {
    const content = String(file.content ?? "")
    totalBytes += Buffer.byteLength(content, "utf8")
    const contentHash = createHash("sha256").update(content).digest("hex")
    const fileHash = createHash("sha256")
      .update(file.path)
      .update("\0")
      .update(normalizeFileLanguage(file.language))
      .update("\0")
      .update(contentHash)
      .digest("hex")
    fileHashes[file.path] = fileHash

    hash.update(file.path)
    hash.update("\0")
    hash.update(normalizeFileLanguage(file.language))
    hash.update("\0")
    hash.update(fileHash)
    hash.update("\0")
  }

  return {
    count: normalizedFiles.length,
    totalBytes,
    sha256: hash.digest("hex"),
    paths: normalizedFiles.map((file) => file.path),
    fileHashes,
  }
}

function buildTree(files: GeneratedFile[]) {
  const folders = new Set<string>()

  for (const file of files) {
    const segments = file.path.split("/")
    for (let index = 1; index < segments.length; index += 1) {
      folders.add(segments.slice(0, index).join("/"))
    }
  }

  return {
    folders: Array.from(folders).sort(),
    files: files.map((file) => ({
      path: file.path,
      language: normalizeFileLanguage(file.language),
      bytes: Buffer.byteLength(file.content, "utf8"),
    })),
    manifest: buildManifest(files),
  }
}

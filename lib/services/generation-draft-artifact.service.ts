import { createHash } from "node:crypto"
import { db } from "@/lib/db/client"
import { artifacts, artifactFiles, projects, workspaces, workspaceMembers } from "@/lib/db/schema"
import { eq, and, asc, inArray } from "drizzle-orm"
import { log } from "@/lib/logging"
import { ProjectFilesystemService, type ProjectFileManifest } from "@/lib/services/project-filesystem.service"
import type { GeneratedFile } from "@/lib/types"
import { normalizeFileLanguage } from "@/lib/workspace-state"

export type GenerationDraftArtifact = {
  artifactId: string
  status: "draft"
  files: GeneratedFile[]
  manifest: ProjectFileManifest
  updatedAt: string
}

function contentHash(content: string) {
  return createHash("sha256").update(content).digest("hex")
}

export class GenerationDraftArtifactService {
  static async upsert(input: {
    jobId: string
    projectId: string
    prompt?: string | null
    files: GeneratedFile[]
    source: string
    metadata?: Record<string, unknown> | null
  }): Promise<GenerationDraftArtifact> {
    const files = ProjectFilesystemService.normalizeFiles(input.files)
    const manifest = ProjectFilesystemService.buildManifest(files)
    const metadata = {
      kind: "generation_draft",
      source: input.source,
      manifest,
      updatedAt: new Date().toISOString(),
      ...(input.metadata || {}),
    }

    const artifact = await db.transaction(async (tx) => {
      const existing = await tx.select().from(artifacts)
        .where(eq(artifacts.generationJobId, input.jobId))
        .limit(1)

      let saved
      if (existing.length > 0) {
        const result = await tx.update(artifacts)
          .set({
            source: "generation_draft",
            status: "draft",
            prompt: input.prompt || null,
            metadataJson: JSON.stringify(metadata),
            updatedAt: new Date(),
          })
          .where(eq(artifacts.generationJobId, input.jobId))
          .returning()
        saved = result[0]
      } else {
        const result = await tx.insert(artifacts)
          .values({
            id: crypto.randomUUID(),
            projectId: input.projectId,
            generationJobId: input.jobId,
            source: "generation_draft",
            status: "draft",
            prompt: input.prompt || null,
            metadataJson: JSON.stringify(metadata),
          })
          .returning()
        saved = result[0]
      }

      await tx.delete(artifactFiles)
        .where(eq(artifactFiles.artifactId, saved.id))

      if (files.length > 0) {
        await tx.insert(artifactFiles).values(
          files.map((file) => ({
            id: crypto.randomUUID(),
            artifactId: saved.id,
            path: file.path,
            content: file.content,
            language: normalizeFileLanguage(file.language),
            sizeBytes: Buffer.byteLength(file.content || "", "utf8"),
            contentHash: contentHash(file.content || ""),
          }))
        )
      }

      return saved
    })

    log("info", "generation_draft_artifact_persisted", {
      event: "generation_draft_artifact_persisted",
      jobId: input.jobId,
      projectId: input.projectId,
      artifactId: artifact.id,
      source: input.source,
      fileCount: files.length,
      manifest,
    })

    return {
      artifactId: artifact.id,
      status: "draft",
      files,
      manifest,
      updatedAt: artifact.updatedAt.toISOString(),
    }
  }

  static async readForJob(input: {
    jobId: string
    userId: string
  }): Promise<GenerationDraftArtifact | null> {
    const artifactResult = await db.select().from(artifacts)
      .where(and(
        eq(artifacts.generationJobId, input.jobId),
        eq(artifacts.status, "draft")
      ))
      .limit(1)

    if (artifactResult.length === 0) return null

    const artifact = artifactResult[0]

    const projectResult = await db.select().from(projects)
      .where(eq(projects.id, artifact.projectId))
      .limit(1)

    if (projectResult.length === 0) return null

    const workspaceResult = await db.select().from(workspaces)
      .where(eq(workspaces.id, projectResult[0].workspaceId))
      .limit(1)

    if (workspaceResult.length === 0) return null

    const membershipResult = await db.select().from(workspaceMembers)
      .where(and(
        eq(workspaceMembers.workspaceId, workspaceResult[0].id),
        eq(workspaceMembers.userId, input.userId)
      ))
      .limit(1)

    if (membershipResult.length === 0) return null

    const filesResult = await db.select().from(artifactFiles)
      .where(eq(artifactFiles.artifactId, artifact.id))
      .orderBy(asc(artifactFiles.path))

    const files = ProjectFilesystemService.normalizeFiles(
      filesResult.map((file) => ({
        path: file.path,
        content: file.content,
        language: normalizeFileLanguage(file.language),
      }))
    )

    return {
      artifactId: artifact.id,
      status: "draft",
      files,
      manifest: ProjectFilesystemService.buildManifest(files),
      updatedAt: artifact.updatedAt.toISOString(),
    }
  }
}

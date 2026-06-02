import { createHash } from "node:crypto"
import { prisma } from "@/lib/db/client"
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

    const artifact = await prisma.$transaction(async (tx) => {
      const saved = await tx.artifact.upsert({
        where: { generationJobId: input.jobId },
        create: {
          projectId: input.projectId,
          generationJobId: input.jobId,
          source: "generation_draft",
          status: "draft",
          prompt: input.prompt || null,
          metadataJson: JSON.stringify(metadata),
        },
        update: {
          source: "generation_draft",
          status: "draft",
          prompt: input.prompt || null,
          metadataJson: JSON.stringify(metadata),
          updatedAt: new Date(),
        },
      })

      await tx.artifactFile.deleteMany({
        where: { artifactId: saved.id },
      })

      if (files.length > 0) {
        await tx.artifactFile.createMany({
          data: files.map((file) => ({
            artifactId: saved.id,
            path: file.path,
            content: file.content,
            language: normalizeFileLanguage(file.language),
            sizeBytes: Buffer.byteLength(file.content || "", "utf8"),
            contentHash: contentHash(file.content || ""),
          })),
        })
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
    const artifact = await prisma.artifact.findFirst({
      where: {
        generationJobId: input.jobId,
        status: "draft",
        project: {
          workspace: {
            members: {
              some: { userId: input.userId },
            },
          },
        },
      },
      include: {
        files: {
          orderBy: { path: "asc" },
        },
      },
    })

    if (!artifact) return null

    const files = ProjectFilesystemService.normalizeFiles(
      artifact.files.map((file) => ({
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

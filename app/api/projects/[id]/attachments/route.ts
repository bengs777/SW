import { NextRequest, NextResponse } from "next/server"
import { auth } from "@/auth"
import { prisma } from "@/lib/db/client"
import { env } from "@/lib/env"
import {
  buildProjectAssetStoragePath,
  deleteProjectAssetFromStorage,
  detectAttachmentKind,
  uploadProjectAssetToStorage,
} from "@/lib/supabase/storage"
import type { PromptAttachment, StoredProjectAsset } from "@/lib/types"

export const runtime = "nodejs"

const MAX_ATTACHMENTS = 5
const MAX_ATTACHMENT_SIZE_BYTES = 3 * 1024 * 1024

async function resolveProject(projectId: string, userId: string) {
  return prisma.project.findFirst({
    where: {
      id: projectId,
      workspace: {
        members: {
          some: {
            userId,
          },
        },
      },
    },
    select: {
      id: true,
    },
  })
}

function toAttachmentRecord(asset: StoredProjectAsset): PromptAttachment {
  return {
    id: asset.id,
    name: asset.originalName,
    originalName: asset.originalName,
    mimeType: asset.mimeType,
    size: asset.size,
    kind: asset.kind,
    content: "",
    assetId: asset.id,
    storageBucket: asset.storageBucket,
    storagePath: asset.storagePath,
    uploadedAt: asset.createdAt,
  }
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await auth()
  const userId = session?.user?.id
  const cleanupTargets: Array<{ bucket: string; storagePath: string }> = []
  const uploadedAssetIds: string[] = []

  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  try {
    if (!env.supabaseStorageBucket) {
      return NextResponse.json(
        { error: "Supabase storage bucket is not configured" },
        { status: 500 }
      )
    }

    const { id: projectId } = await params
    const project = await resolveProject(projectId, userId)

    if (!project) {
      return NextResponse.json({ error: "Project not found" }, { status: 404 })
    }

    const formData = await request.formData()
    const files = formData
      .getAll("files")
      .filter((entry): entry is File => entry instanceof File)

    if (files.length === 0) {
      return NextResponse.json({ error: "No files uploaded" }, { status: 400 })
    }

    if (files.length > MAX_ATTACHMENTS) {
      return NextResponse.json(
        { error: `Maximum ${MAX_ATTACHMENTS} files per upload.` },
        { status: 400 }
      )
    }

    const uploadedAssets: StoredProjectAsset[] = []

    for (const file of files) {
      const originalName = (file.name || "attachment").trim().slice(0, 180)

      if (file.size > MAX_ATTACHMENT_SIZE_BYTES) {
        throw new Error(
          `File "${originalName}" exceeds ${Math.floor(MAX_ATTACHMENT_SIZE_BYTES / (1024 * 1024))}MB limit.`
        )
      }

      const storagePath = buildProjectAssetStoragePath(project.id, userId, originalName)
      const kind = detectAttachmentKind(file.type || "application/octet-stream", originalName)

      cleanupTargets.push({ bucket: env.supabaseStorageBucket, storagePath })

      await uploadProjectAssetToStorage({
        bucket: env.supabaseStorageBucket,
        storagePath,
        file,
      })

      const asset = await prisma.projectAsset.create({
        data: {
          projectId: project.id,
          userId,
          originalName,
          mimeType: file.type || "application/octet-stream",
          size: file.size,
          kind,
          storageBucket: env.supabaseStorageBucket,
          storagePath,
        },
      })

      uploadedAssetIds.push(asset.id)

      uploadedAssets.push({
        id: asset.id,
        projectId: asset.projectId,
        userId: asset.userId,
        originalName: asset.originalName,
        mimeType: asset.mimeType,
        size: asset.size,
        kind: asset.kind as StoredProjectAsset["kind"],
        storageBucket: asset.storageBucket,
        storagePath: asset.storagePath,
        createdAt: asset.createdAt.toISOString(),
      })
    }

    return NextResponse.json({
      attachments: uploadedAssets.map(toAttachmentRecord),
    })
  } catch (error) {
    await Promise.allSettled([
      ...cleanupTargets.map((target) => deleteProjectAssetFromStorage(target)),
      ...uploadedAssetIds.map(async (assetId) => {
        await prisma.projectAsset.delete({ where: { id: assetId } }).catch(() => null)
      }),
    ])

    const message = error instanceof Error ? error.message : "Failed to upload project files"

    console.error("[attachments] Upload failed:", error)

    return NextResponse.json({ error: message }, { status: 500 })
  }
}
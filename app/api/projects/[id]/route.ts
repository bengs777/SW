import { NextRequest, NextResponse } from "next/server"
import { revalidatePath } from "next/cache"
import { randomUUID } from "node:crypto"
import { z } from "zod"
import { auth } from "@/auth"
import { prisma } from "@/lib/db/client"
import { ProjectFilePersistenceService } from "@/lib/services/project-file-persistence.service"
import { ProjectFilesystemService } from "@/lib/services/project-filesystem.service"
import type { GeneratedFile } from "@/lib/types"
import { readWorkspaceStateFile, splitWorkspaceStateFiles } from "@/lib/workspace-state"
import { log } from "@/lib/logging"

function historyFileCount(result: string) {
  try {
    const parsed = JSON.parse(result)
    return Array.isArray(parsed) ? parsed.length : 0
  } catch {
    return 0
  }
}

function parseJsonObject(value?: string | null): Record<string, unknown> | null {
  if (!value) return null

  try {
    const parsed = JSON.parse(value)
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null
  } catch {
    return null
  }
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const startedAt = Date.now()
  const requestId = request.headers.get("x-request-id") || request.headers.get("x-vercel-id") || randomUUID()
  const refreshReason = request.nextUrl.searchParams.get("reason") || "project-load"
  const session = await auth()
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  try {
    const { id } = await params

    const project = await prisma.project.findFirst({
      where: {
        id,
        workspace: {
          members: {
            some: {
              userId: session.user.id,
            },
          },
        },
      },
      include: {
        history: {
          orderBy: { createdAt: "desc" },
          take: 10,
        },
        workspace: {
          include: {
            subscription: true,
          },
        },
      },
    })

    if (!project) {
      return NextResponse.json(
        { error: "Project not found" },
        { status: 404 }
      )
    }

    const projectFiles = await ProjectFilesystemService.readFiles(id)
    const manifest = ProjectFilesystemService.buildManifest(projectFiles)
    const { files: visibleFiles, stateFile } = splitWorkspaceStateFiles(projectFiles)
    const workspaceState = readWorkspaceStateFile(stateFile)
    const latestFileUpdatedAt = await prisma.projectFile.findFirst({
      where: {
        projectId: id,
        path: { not: ".swift/workspace-state.json" },
      },
      orderBy: { updatedAt: "desc" },
      select: { updatedAt: true },
    })
    const latestUpdatedAt = latestFileUpdatedAt?.updatedAt.toISOString() || null
    const latestHistoryId = project.history[0]?.id || null
    const latestDraftArtifact = visibleFiles.length === 0
      ? await prisma.artifact.findFirst({
          where: {
            projectId: id,
            source: "generation_draft",
            status: "draft",
            files: { some: {} },
            generationJob: {
              is: {
                userId: session.user.id,
                resultHistoryId: null,
                status: { notIn: ["completed", "cancelled"] },
              },
            },
          },
          orderBy: { updatedAt: "desc" },
          select: {
            id: true,
            updatedAt: true,
            metadataJson: true,
            _count: {
              select: { files: true },
            },
            generationJob: {
              select: {
                id: true,
                status: true,
                stage: true,
                error: true,
                resultHistoryId: true,
              },
            },
          },
        })
      : null
    const latestDraftMetadata = parseJsonObject(latestDraftArtifact?.metadataJson)
    const latestDraftManifest = latestDraftMetadata?.manifest && typeof latestDraftMetadata.manifest === "object"
      ? latestDraftMetadata.manifest
      : null
    const latestDraft = latestDraftArtifact?.generationJob
      ? {
          status: "draft",
          jobId: latestDraftArtifact.generationJob.id,
          artifactId: latestDraftArtifact.id,
          updatedAt: latestDraftArtifact.updatedAt.toISOString(),
          fileCount: latestDraftArtifact._count.files,
          jobStatus: latestDraftArtifact.generationJob.status,
          jobStage: latestDraftArtifact.generationJob.stage,
          jobError: latestDraftArtifact.generationJob.error || null,
          resultHistoryId: latestDraftArtifact.generationJob.resultHistoryId || null,
          manifest: latestDraftManifest,
        }
      : null

    log("info", "project_state_loaded", {
      requestId,
      projectId: id,
      userId: session.user.id,
      fileCount: visibleFiles.length,
      draftFileCount: latestDraft?.fileCount || 0,
      draftJobId: latestDraft?.jobId || null,
      manifest,
      latestHistoryId,
      reason: refreshReason,
      durationMs: Date.now() - startedAt,
    })
    if ((refreshReason === "generation-completed" || refreshReason === "explorer-refresh") && visibleFiles.length === 0) {
      log("error", "project_state_empty_after_generation", {
        requestId,
        projectId: id,
        userId: session.user.id,
        latestHistoryId,
        manifest,
        reason: refreshReason,
        durationMs: Date.now() - startedAt,
      })
    }
    if (refreshReason === "generation-completed" || refreshReason === "explorer-refresh") {
      const endedAt = Date.now()
      log("info", "explorer_refreshed", {
        event: "explorer_refreshed",
        requestId,
        jobId: request.nextUrl.searchParams.get("jobId"),
        projectId: id,
        userId: session.user.id,
        startedAt: new Date(startedAt).toISOString(),
        endedAt: new Date(endedAt).toISOString(),
        durationMs: endedAt - startedAt,
        explorerItemCount: visibleFiles.length,
        fileCount: visibleFiles.length,
        latestHistoryId,
        latestFileUpdatedAt: latestUpdatedAt,
      })
    }

    return NextResponse.json({
      project: {
        ...project,
        history: project.history.map((entry) => ({
          id: entry.id,
          prompt: entry.prompt,
          intent: entry.intent,
          usedAutoRepair: entry.usedAutoRepair,
          createdAt: entry.createdAt.toISOString(),
          fileCount: historyFileCount(entry.result),
        })),
        files: visibleFiles,
        workspaceState,
        fileState: {
          count: visibleFiles.length,
          latestUpdatedAt,
          latestHistoryId,
          manifest,
        },
        draftState: latestDraft,
      },
    }, {
      headers: {
        "Cache-Control": "no-store",
        "X-Request-Id": requestId,
      },
    })
  } catch (error) {
    log("error", "project_state_load_failed", {
      requestId,
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
      durationMs: Date.now() - startedAt,
    })
    return NextResponse.json(
      { error: "Failed to fetch project" },
      { status: 500 }
    )
  }
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await auth()
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  const UpdateProjectSchema = z.object({
    name: z.string().trim().min(1).max(200).optional(),
    description: z.string().trim().max(2000).optional(),
    prompt: z.string().trim().max(12000).optional(),
  }).strict() // SECURITY: reject unknown fields to prevent mass assignment

  try {
    const { id } = await params
    const body = await request.json()
    const parsed = UpdateProjectSchema.safeParse(body)

    if (!parsed.success) {
      return NextResponse.json(
        { error: parsed.error.issues[0]?.message || "Invalid project update payload" },
        { status: 400 }
      )
    }

    const { name, description, prompt } = parsed.data

    // Check if user has access
    const project = await prisma.project.findFirst({
      where: {
        id,
        workspace: {
          members: {
            some: {
              userId: session.user.id,
            },
          },
        },
      },
    })

    if (!project) {
      return NextResponse.json(
        { error: "Project not found" },
        { status: 404 }
      )
    }

    const updatedProject = await prisma.project.update({
      where: { id },
      data: {
        ...(name ? { name } : {}),
        ...(description !== undefined ? { description } : {}),
        ...(prompt !== undefined ? { prompt } : {}),
      },
      include: {
        files: true,
      },
    })

    return NextResponse.json({ project: updatedProject })
  } catch (error) {
    console.error("[v0] Error updating project:", error)
    return NextResponse.json(
      { error: "Failed to update project" },
      { status: 500 }
    )
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await auth()
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  try {
    const { id } = await params

    // Check if user has access and is admin
    const project = await prisma.project.findFirst({
      where: {
        id,
        workspace: {
          members: {
            some: {
              userId: session.user.id,
              role: "admin",
            },
          },
        },
      },
    })

    if (!project) {
      return NextResponse.json(
        { error: "Project not found or unauthorized" },
        { status: 404 }
      )
    }

    await prisma.project.delete({
      where: { id },
    })

    revalidatePath("/dashboard")
    revalidatePath("/dashboard/projects")
    revalidatePath(`/dashboard/workspace/${project.workspaceId}`)

    return NextResponse.json({ success: true })
  } catch (error) {
    console.error("[v0] Error deleting project:", error)
    return NextResponse.json(
      { error: "Failed to delete project" },
      { status: 500 }
    )
  }
}

// Save generation
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await auth()
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  try {
    const { id } = await params
    const body = await request.json()
    const { files, prompt, tokensUsed = 0 } = body as {
      files: GeneratedFile[]
      prompt: string
      tokensUsed?: number
    }

    if (!Array.isArray(files) || typeof prompt !== "string") {
      return NextResponse.json({ error: "Invalid project save payload" }, { status: 400 })
    }

    // Check if user has access
    const project = await prisma.project.findFirst({
      where: {
        id,
        workspace: {
          members: {
            some: {
              userId: session.user.id,
            },
          },
        },
      },
    })

    if (!project) {
      return NextResponse.json(
        { error: "Project not found" },
        { status: 404 }
      )
    }

    const saved = await ProjectFilePersistenceService.saveGenerationSnapshot(
      id,
      prompt,
      files,
      { tokensUsed }
    )

    revalidatePath(`/dashboard/project/${id}`)

    return NextResponse.json({
      success: true,
      historyId: saved.historyId,
      fileDiff: saved.fileDiff,
      manifest: saved.manifest,
    })
  } catch (error) {
    console.error("[v0] Error saving generation:", error)
    const message = error instanceof Error ? error.message : "Failed to save generation"
    const status =
      /generated file|generated files|unsafe|forbidden|too many|size limit/i.test(message)
        ? 400
        : 500
    return NextResponse.json(
      { error: message },
      { status }
    )
  }
}

import { NextRequest, NextResponse } from "next/server"
import { revalidatePath } from "next/cache"
import { randomUUID } from "node:crypto"
import { z } from "zod"
import { getSession } from "@/auth"
import { db } from "@/lib/db/client"
import { projects, projectFiles, generationHistory, artifacts, artifactFiles, generationJobs, workspaces, workspaceMembers } from "@/lib/db/schema"
import { eq, and, desc, lt, notInArray, sql } from "drizzle-orm"
import { ProjectFilePersistenceService } from "@/lib/services/project-file-persistence.service"
import { ProjectFilesystemService } from "@/lib/services/project-filesystem.service"
import type { GeneratedFile } from "@/lib/types"
import { readWorkspaceStateFile, splitWorkspaceStateFiles } from "@/lib/workspace-state"
import { log } from "@/lib/logging"
import { enforceRouteRateLimit } from "@/lib/security/rate-limit"

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
  const session = await getSession()
  if (!session?.userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  try {
    const { id } = await params

    const project = await db.query.projects.findFirst({
      where: eq(projects.id, id),
      with: {
        history: {
          orderBy: desc(generationHistory.createdAt),
          limit: 10,
        },
        workspace: {
          with: {
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

    const projectFilesData = await ProjectFilesystemService.readFiles(id)
    const manifest = ProjectFilesystemService.buildManifest(projectFilesData)
    const { files: visibleFiles, stateFile } = splitWorkspaceStateFiles(projectFilesData)
    const workspaceState = readWorkspaceStateFile(stateFile)
    const latestFileUpdatedAt = await db.query.projectFiles.findFirst({
      where: and(
        eq(projectFiles.projectId, id),
        sql`${projectFiles.path} != '.swift/workspace-state.json'`
      ),
      orderBy: desc(projectFiles.updatedAt),
    })
    const latestUpdatedAt = latestFileUpdatedAt?.updatedAt.toISOString() || null
    const latestHistoryId = (project as unknown as { history: Array<{ id: string }> }).history[0]?.id || null
    const latestDraftArtifact = visibleFiles.length === 0
      ? await db.query.artifacts.findFirst({
          where: and(
            eq(artifacts.projectId, id),
            eq(artifacts.source, "generation_draft"),
            eq(artifacts.status, "draft"),
            sql`exists (select 1 from artifact_files where artifact_files.artifact_id = artifacts.id)`,
            sql`exists (select 1 from generation_jobs where generation_jobs.id = artifacts.generation_job_id and generation_jobs.user_id = ${session.userId} and generation_jobs.result_history_id is null and generation_jobs.status not in ('completed', 'cancelled'))`
          ),
          orderBy: desc(artifacts.updatedAt),
          with: {
            generationJob: true,
          },
        })
      : null
    const latestDraftMetadata = parseJsonObject(latestDraftArtifact?.metadataJson)
    const latestDraftManifest = latestDraftMetadata?.manifest && typeof latestDraftMetadata.manifest === "object"
      ? latestDraftMetadata.manifest
      : null
    const latestDraft = (latestDraftArtifact as unknown as {
      id: string
      updatedAt: Date
      _count?: { files?: number }
      generationJob: {
        id: string
        status: string
        stage: string
        error: string | null
        resultHistoryId: string | null
      }
    } | null | undefined)?.generationJob
      ? {
          status: "draft",
          jobId: (latestDraftArtifact as unknown as { generationJob: { id: string } }).generationJob.id,
          artifactId: (latestDraftArtifact as unknown as { id: string }).id,
          updatedAt: (latestDraftArtifact as unknown as { updatedAt: Date }).updatedAt.toISOString(),
          fileCount: (latestDraftArtifact as unknown as { _count?: { files?: number } })._count?.files || 0,
          jobStatus: (latestDraftArtifact as unknown as { generationJob: { status: string } }).generationJob.status,
          jobStage: (latestDraftArtifact as unknown as { generationJob: { stage: string } }).generationJob.stage,
          jobError: (latestDraftArtifact as unknown as { generationJob: { error: string | null } }).generationJob.error || null,
          resultHistoryId: (latestDraftArtifact as unknown as { generationJob: { resultHistoryId: string | null } }).generationJob.resultHistoryId || null,
          manifest: latestDraftManifest,
        }
      : null

    log("info", "project_state_loaded", {
      requestId,
      projectId: id,
      userId: session.userId,
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
        userId: session.userId,
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
        userId: session.userId,
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
        history: (project.history as unknown as Array<{
          id: string
          prompt: string
          intent: string
          usedAutoRepair: boolean
          createdAt: Date
          result: string | null
        }>).map((entry) => ({
          id: entry.id,
          prompt: entry.prompt,
          intent: entry.intent,
          usedAutoRepair: entry.usedAutoRepair,
          createdAt: entry.createdAt.toISOString(),
          fileCount: historyFileCount(entry.result || ""),
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
  const session = await getSession()
  if (!session?.userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  try {
    await enforceRouteRateLimit(`project-update:${session.userId}`, { maxPerMinute: 30, maxPerHour: 300 })
  } catch {
    return NextResponse.json({ error: "Too many requests. Please try again later." }, { status: 429 })
  }

  const UpdateProjectSchema = z.object({
    name: z.string().trim().min(1).max(200).optional(),
    description: z.string().trim().max(2000).optional(),
    prompt: z.string().trim().max(12000).optional(),
  }).strict()

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

    const project = await db.query.projects.findFirst({
      where: eq(projects.id, id),
    })

    if (!project) {
      return NextResponse.json(
        { error: "Project not found" },
        { status: 404 }
      )
    }

    const updatedProject = await db.update(projects)
      .set({
        ...(name ? { name } : {}),
        ...(description !== undefined ? { description } : {}),
        ...(prompt !== undefined ? { prompt } : {}),
        updatedAt: new Date(),
      })
      .where(eq(projects.id, id))
      .returning()

    return NextResponse.json({ project: updatedProject[0] })
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
  const session = await getSession()
  if (!session?.userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  try {
    await enforceRouteRateLimit(`project-delete:${session.userId}`, { maxPerMinute: 10, maxPerHour: 60 })
  } catch {
    return NextResponse.json({ error: "Too many requests. Please try again later." }, { status: 429 })
  }

  try {
    const { id } = await params

    const project = await db.query.projects.findFirst({
      where: eq(projects.id, id),
    })

    if (!project) {
      return NextResponse.json(
        { error: "Project not found" },
        { status: 404 }
      )
    }

    const projectWithHistory = project as typeof project & {
      history: Array<{ id: string }>
    }

    await db.delete(projects).where(eq(projects.id, id))

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

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await getSession()
  if (!session?.userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  try {
    await enforceRouteRateLimit(`project-save:${session.userId}`, { maxPerMinute: 30, maxPerHour: 300 })
  } catch {
    return NextResponse.json({ error: "Too many requests. Please try again later." }, { status: 429 })
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

    const project = await db.query.projects.findFirst({
      where: eq(projects.id, id),
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

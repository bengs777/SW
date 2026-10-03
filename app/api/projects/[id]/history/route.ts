import { NextRequest, NextResponse } from "next/server"
import { z } from "zod"
import { getSession } from "@/auth"
import { db } from "@/lib/db/client"
import { projects, generationHistory } from "@/lib/db/schema"
import { eq, and, desc } from "drizzle-orm"
import { ProjectFilePersistenceService } from "@/lib/services/project-file-persistence.service"
import type { GeneratedFile } from "@/lib/types"
import { assertFeatureEnabled } from "@/lib/feature-flags"

const RollbackSchema = z.object({
  historyId: z.string().min(1),
}).strict()

function parseHistoryFiles(result: string): GeneratedFile[] {
  const parsed = JSON.parse(result)
  if (!Array.isArray(parsed)) return []
  return ProjectFilePersistenceService.normalizeFiles(parsed as GeneratedFile[])
}

async function getAccessibleProject(projectId: string, userId: string) {
  return db.query.projects.findFirst({
    where: eq(projects.id, projectId),
  })
}

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const featureCheck = assertFeatureEnabled("enableVersionHistory", "Version history")
  if (featureCheck) {
    return NextResponse.json({ error: featureCheck.error }, { status: featureCheck.status })
  }

  const session = await getSession()
  if (!session?.userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  const { id } = await params
  const project = await getAccessibleProject(id, session.userId)
  if (!project) {
    return NextResponse.json({ error: "Project not found" }, { status: 404 })
  }

  const history = await db.query.generationHistory.findMany({
    where: eq(generationHistory.projectId, id),
    orderBy: desc(generationHistory.createdAt),
    limit: 20,
  })

  return NextResponse.json({
    history: history.map((entry) => {
      let fileCount = 0
      try {
        fileCount = parseHistoryFiles(entry.result).length
      } catch {
        fileCount = 0
      }

      return {
        id: entry.id,
        prompt: entry.prompt,
        intent: entry.intent,
        usedAutoRepair: entry.usedAutoRepair,
        createdAt: entry.createdAt.toISOString(),
        fileCount,
      }
    }),
  })
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const featureCheck = assertFeatureEnabled("enableVersionHistory", "Version history")
  if (featureCheck) {
    return NextResponse.json({ error: featureCheck.error }, { status: featureCheck.status })
  }

  const session = await getSession()
  if (!session?.userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  const { id } = await params
  const parsed = RollbackSchema.safeParse(await request.json().catch(() => ({})))
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message || "Invalid rollback payload" },
      { status: 400 }
    )
  }

  const project = await getAccessibleProject(id, session.userId)
  if (!project) {
    return NextResponse.json({ error: "Project not found" }, { status: 404 })
  }

  const target = await db.query.generationHistory.findFirst({
    where: and(
      eq(generationHistory.id, parsed.data.historyId),
      eq(generationHistory.projectId, id)
    ),
  })

  if (!target) {
    return NextResponse.json({ error: "Version not found" }, { status: 404 })
  }

  let files: GeneratedFile[]
  try {
    files = parseHistoryFiles(target.result)
  } catch {
    return NextResponse.json({ error: "Version snapshot is invalid" }, { status: 422 })
  }

  if (files.length === 0) {
    return NextResponse.json({ error: "Version snapshot is empty" }, { status: 422 })
  }

  const saveResult = await ProjectFilePersistenceService.saveGenerationSnapshot(
    id,
    `Rollback to ${target.createdAt.toISOString()}: ${target.prompt}`,
    files,
    {
      intent: "rollback",
      usedAutoRepair: false,
    }
  )

  return NextResponse.json({
    success: true,
    historyId: saveResult.historyId,
    files: saveResult.files,
    rolledBackFrom: target.id,
  })
}

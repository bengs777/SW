import JSZip from "jszip"
import { NextRequest, NextResponse } from "next/server"
import { getSession } from "@/auth"
import { db } from "@/lib/db/client"
import { projects } from "@/lib/db/schema"
import { eq } from "drizzle-orm"
import type { GeneratedFile } from "@/lib/types"
import { splitWorkspaceStateFiles, normalizeFileLanguage } from "@/lib/workspace-state"
import { assertFeatureEnabled } from "@/lib/feature-flags"
import { enforceRouteRateLimit } from "@/lib/security/rate-limit"
import { getProjectAccess } from "@/lib/auth/project-access"

export const runtime = "nodejs"

const MAX_FILE_COUNT = 500

const toSafePath = (input: string) => {
  const normalized = input.replace(/\\/g, "/").replace(/^\/+/, "")
  if (!normalized) return ""

  const safeSegments: string[] = []
  for (const segment of normalized.split("/")) {
    const trimmed = segment.trim()
    if (!trimmed || trimmed === ".") continue
    if (trimmed === "..") return ""
    safeSegments.push(trimmed)
  }

  return safeSegments.join("/")
}

type FileLike = {
  path: string
  content: string
  language?: string | null
}

const normalizeFiles = (raw: unknown, fallback: FileLike[]) => {
  const source = Array.isArray(raw) ? raw : fallback

  const files: GeneratedFile[] = []

  for (const entry of source) {
    const path = typeof entry?.path === "string" ? toSafePath(entry.path) : ""
    const content = typeof entry?.content === "string" ? entry.content : ""
    const language = normalizeFileLanguage(entry?.language)

    if (!path) continue

    files.push({
      path,
      content,
      language,
    })
  }

  return files.slice(0, MAX_FILE_COUNT)
}

const slugify = (value: string) =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "swift-project"

const resolveProjectFiles = async (projectId: string, userId: string) => {
  const access = await getProjectAccess(projectId, { userId })
  if (!access) return null

  const project = await db.query.projects.findFirst({
    where: eq(projects.id, projectId),
    with: {
      files: true,
    },
  })
  return project
}

const buildZip = async (projectName: string, files: GeneratedFile[]) => {
  const zip = new JSZip()

  for (const file of files) {
    const safePath = toSafePath(file.path)
    if (!safePath) continue
    zip.file(safePath, file.content)
  }

  zip.file(
    "swift-export.json",
    JSON.stringify(
      {
        projectName,
        exportedAt: new Date().toISOString(),
        fileCount: files.length,
      },
      null,
      2
    )
  )

  return zip.generateAsync({
    type: "nodebuffer",
    compression: "DEFLATE",
    compressionOptions: { level: 9 },
  })
}

const toDownloadResponse = (zipBuffer: Buffer, projectName: string) => {
  const fileName = `${slugify(projectName)}.zip`

  return new NextResponse(zipBuffer, {
    status: 200,
    headers: {
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename="${fileName}"`,
      "Cache-Control": "no-store",
    },
  })
}

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const featureCheck = assertFeatureEnabled("enableDownloadZip", "ZIP download")
  if (featureCheck) {
    return NextResponse.json({ error: featureCheck.error }, { status: featureCheck.status })
  }

  const session = await getSession()
  if (!session?.userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  try {
    const { id } = await params
    const project = await resolveProjectFiles(id, session.userId)

    if (!project) {
      return NextResponse.json({ error: "Project not found" }, { status: 404 })
    }

    const visibleProjectFiles = splitWorkspaceStateFiles(project.files).files
    const files = normalizeFiles(visibleProjectFiles, [])
    if (files.length === 0) {
      return NextResponse.json(
        { error: "No generated files found to export." },
        { status: 400 }
      )
    }

    const zipBuffer = await buildZip(project.name, files)
    return toDownloadResponse(zipBuffer, project.name)
  } catch (error) {
    console.error("[v0] Error exporting project files:", error)
    return NextResponse.json(
      { error: "Failed to export project files" },
      { status: 500 }
    )
  }
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const featureCheck = assertFeatureEnabled("enableDownloadZip", "ZIP download")
  if (featureCheck) {
    return NextResponse.json({ error: featureCheck.error }, { status: featureCheck.status })
  }

  const session = await getSession()
  if (!session?.userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  try {
    await enforceRouteRateLimit(`project-export:${session.userId}`, { maxPerMinute: 10, maxPerHour: 60 })
  } catch {
    return NextResponse.json({ error: "Too many requests. Please try again later." }, { status: 429 })
  }

  try {
    const { id } = await params
    const project = await resolveProjectFiles(id, session.userId)

    if (!project) {
      return NextResponse.json({ error: "Project not found" }, { status: 404 })
    }

    const body = await request.json().catch(() => ({}))
    const normalizedFiles = normalizeFiles((body as { files?: unknown }).files, project.files)
    const { files: visibleBodyFiles } = splitWorkspaceStateFiles(normalizedFiles)
    const files = visibleBodyFiles
    if (files.length === 0) {
      return NextResponse.json(
        { error: "No generated files found to export." },
        { status: 400 }
      )
    }

    const zipBuffer = await buildZip(project.name, files)
    return toDownloadResponse(zipBuffer, project.name)
  } catch (error) {
    console.error("[v0] Error exporting project files:", error)
    return NextResponse.json(
      { error: "Failed to export project files" },
      { status: 500 }
    )
  }
}

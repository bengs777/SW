import JSZip from "jszip"
import { NextRequest, NextResponse } from "next/server"
import { auth } from "@/auth"
import { prisma } from "@/lib/db/client"
import type { GeneratedFile } from "@/lib/types"

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
    const language = typeof entry?.language === "string" ? entry.language : "ts"

    if (!path) continue

    files.push({
      path,
      content,
      language: language as GeneratedFile["language"],
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
    include: {
      files: true,
    },
  })
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
  const session = await auth()
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  try {
    const { id } = await params
    const project = await resolveProjectFiles(id, session.user.id)

    if (!project) {
      return NextResponse.json({ error: "Project not found" }, { status: 404 })
    }

    const files = normalizeFiles(project.files, [])
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
  const session = await auth()
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  try {
    const { id } = await params
    const project = await resolveProjectFiles(id, session.user.id)

    if (!project) {
      return NextResponse.json({ error: "Project not found" }, { status: 404 })
    }

    const body = await request.json().catch(() => ({}))
    const files = normalizeFiles((body as { files?: unknown }).files, project.files)
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

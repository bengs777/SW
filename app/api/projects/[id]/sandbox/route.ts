import { NextRequest, NextResponse } from "next/server"
import { auth } from "@/auth"
import { prisma } from "@/lib/db/client"
import { getRuntimeSandbox, resetRuntimeSandbox, startRuntimeSandbox } from "@/lib/sandbox/runtime"
import type { GeneratedFile } from "@/lib/types"

export const runtime = "nodejs"
export const maxDuration = 300

async function assertProjectAccess(projectId: string, userId: string) {
  const project = await prisma.project.findFirst({
    where: {
      id: projectId,
      workspace: {
        members: {
          some: { userId },
        },
      },
    },
    include: {
      files: true,
    },
  })

  return project
}

function normalizeLanguage(path: string, language?: string): GeneratedFile["language"] {
  const normalized = (language || "").toLowerCase()
  if (["tsx", "ts", "css", "json", "html", "prisma", "md", "env"].includes(normalized)) {
    return normalized as GeneratedFile["language"]
  }
  if (path.endsWith(".tsx")) return "tsx"
  if (path.endsWith(".ts")) return "ts"
  if (path.endsWith(".css")) return "css"
  if (path.endsWith(".json")) return "json"
  if (path.endsWith(".html")) return "html"
  if (path.endsWith(".prisma")) return "prisma"
  if (path.endsWith(".md")) return "md"
  if (path.includes(".env")) return "env"
  return "ts"
}

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await auth()
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  const { id } = await params
  const project = await assertProjectAccess(id, session.user.id)
  if (!project) {
    return NextResponse.json({ error: "Project not found" }, { status: 404 })
  }

  return NextResponse.json(getRuntimeSandbox(id))
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await auth()
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  const { id } = await params
  const project = await assertProjectAccess(id, session.user.id)
  if (!project) {
    return NextResponse.json({ error: "Project not found" }, { status: 404 })
  }

  const body = (await request.json().catch(() => ({}))) as {
    files?: Array<{ path: string; content: string; language?: string }>
  }

  const files =
    Array.isArray(body.files) && body.files.length > 0
      ? body.files.map((file) => ({
          path: file.path,
          content: String(file.content || ""),
          language: normalizeLanguage(file.path, file.language),
        }))
      : project.files.map((file) => ({
          path: file.path,
          content: file.content,
          language: normalizeLanguage(file.path, file.language),
        }))

  if (files.length === 0) {
    return NextResponse.json(
      {
        status: "idle",
        previewUrl: null,
        logs: [],
        error: "No project files are available for runtime preview.",
      },
      { status: 400 }
    )
  }

  const result = await startRuntimeSandbox(id, files)
  return NextResponse.json(result, { status: result.error ? 500 : 200 })
}

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await auth()
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  const { id } = await params
  const project = await assertProjectAccess(id, session.user.id)
  if (!project) {
    return NextResponse.json({ error: "Project not found" }, { status: 404 })
  }

  await resetRuntimeSandbox(id)
  return NextResponse.json({ success: true })
}

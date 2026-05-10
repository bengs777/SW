import { NextRequest, NextResponse } from "next/server"
import { auth } from "@/auth"
import { prisma } from "@/lib/db/client"
import { getRuntimeSandbox, resetRuntimeSandbox, startRuntimeSandbox } from "@/lib/sandbox/runtime"
import type { GeneratedFile } from "@/lib/types"

export const runtime = "nodejs"
export const maxDuration = 300

const SANDBOX_SERVICE_URL = process.env.SANDBOX_SERVICE_URL?.replace(/\/+$/, "") || ""
const SANDBOX_SERVICE_TOKEN = process.env.SANDBOX_SERVICE_TOKEN || ""
const IS_PRODUCTION = process.env.NODE_ENV === "production"
const IS_VERCEL = Boolean(process.env.VERCEL)
const MAX_SANDBOX_FILES = Number(process.env.SWIFT_SANDBOX_MAX_FILES || 240)
const MAX_SANDBOX_TOTAL_BYTES = Number(process.env.SWIFT_SANDBOX_MAX_TOTAL_BYTES || 6 * 1024 * 1024)
const MAX_SANDBOX_FILE_BYTES = Number(process.env.SWIFT_SANDBOX_MAX_FILE_BYTES || 512 * 1024)

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

function validateSandboxFiles(files: GeneratedFile[]) {
  if (files.length > MAX_SANDBOX_FILES) {
    return `Too many files for live preview. Maximum: ${MAX_SANDBOX_FILES}`
  }

  let totalBytes = 0
  for (const file of files) {
    const size = Buffer.byteLength(String(file.content || ""), "utf8")
    if (size > MAX_SANDBOX_FILE_BYTES) {
      return `File ${file.path} exceeds live preview file size limit.`
    }
    totalBytes += size
  }

  if (totalBytes > MAX_SANDBOX_TOTAL_BYTES) {
    return `Live preview payload exceeds total size limit. Maximum bytes: ${MAX_SANDBOX_TOTAL_BYTES}`
  }

  return null
}

function sandboxDisabledResponse() {
  return NextResponse.json(
    {
      status: "disabled",
      previewUrl: null,
      logs: [],
      error:
        "Live sandbox is disabled on Vercel until SANDBOX_SERVICE_URL points to a dedicated sandbox runtime service.",
    },
    { status: 501 }
  )
}

function sandboxMisconfiguredResponse() {
  return NextResponse.json(
    {
      status: "disabled",
      previewUrl: null,
      logs: [],
      error:
        "Live sandbox is not production-ready until SANDBOX_SERVICE_URL and SANDBOX_SERVICE_TOKEN are both configured.",
    },
    { status: 503 }
  )
}

async function proxySandboxRequest(input: {
  method: "GET" | "POST" | "DELETE"
  projectId: string
  body?: unknown
}) {
  const headers: HeadersInit = {
    Accept: "application/json",
  }

  let body: string | undefined
  if (input.body !== undefined) {
    headers["Content-Type"] = "application/json"
    body = JSON.stringify(input.body)
  }

  if (SANDBOX_SERVICE_TOKEN) {
    headers.Authorization = `Bearer ${SANDBOX_SERVICE_TOKEN}`
  }

  const response = await fetch(`${SANDBOX_SERVICE_URL}/sandbox/${encodeURIComponent(input.projectId)}`, {
    method: input.method,
    headers,
    body,
    cache: "no-store",
  })

  const data = await response.json().catch(() => ({
    status: "error",
    previewUrl: null,
    logs: [],
    error: `Sandbox service returned non-JSON response (${response.status})`,
  }))

  return NextResponse.json(data, { status: response.status })
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

  if (SANDBOX_SERVICE_URL) {
    if (IS_PRODUCTION && !SANDBOX_SERVICE_TOKEN) {
      return sandboxMisconfiguredResponse()
    }
    return proxySandboxRequest({ method: "GET", projectId: id })
  }

  if (IS_VERCEL && IS_PRODUCTION) {
    return sandboxDisabledResponse()
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

  const validationError = validateSandboxFiles(files)
  if (validationError) {
    return NextResponse.json(
      {
        status: "error",
        previewUrl: null,
        logs: [],
        error: validationError,
      },
      { status: 413 }
    )
  }

  if (SANDBOX_SERVICE_URL) {
    if (IS_PRODUCTION && !SANDBOX_SERVICE_TOKEN) {
      return sandboxMisconfiguredResponse()
    }
    return proxySandboxRequest({ method: "POST", projectId: id, body: { files } })
  }

  if (IS_VERCEL && IS_PRODUCTION) {
    return sandboxDisabledResponse()
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

  if (SANDBOX_SERVICE_URL) {
    if (IS_PRODUCTION && !SANDBOX_SERVICE_TOKEN) {
      return sandboxMisconfiguredResponse()
    }
    return proxySandboxRequest({ method: "DELETE", projectId: id })
  }

  if (IS_VERCEL && IS_PRODUCTION) {
    return sandboxDisabledResponse()
  }

  await resetRuntimeSandbox(id)
  return NextResponse.json({ success: true })
}

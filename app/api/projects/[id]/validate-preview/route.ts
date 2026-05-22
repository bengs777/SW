import { NextRequest, NextResponse } from "next/server"
import { auth } from "@/auth"
import { prisma } from "@/lib/db/client"
import { ProjectFilesystemService } from "@/lib/services/project-filesystem.service"
import { compileProject } from "@/lib/preview/module-resolution"
import { validateRuntimeImports, validateRuntimeSyntax } from "@/lib/ai/runtime-tsx-validator"
import { splitWorkspaceStateFiles } from "@/lib/workspace-state"
import type { GeneratedFile } from "@/lib/types"

async function canAccessProject(projectId: string, userId: string) {
  const project = await prisma.project.findFirst({
    where: {
      id: projectId,
      workspace: {
        members: {
          some: { userId },
        },
      },
    },
    select: { id: true },
  })
  return Boolean(project)
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
  if (!(await canAccessProject(id, session.user.id))) {
    return NextResponse.json({ error: "Project not found" }, { status: 404 })
  }

  const body = await request.json().catch(() => ({}))
  const inputFiles = Array.isArray((body as { files?: unknown }).files)
    ? ((body as { files: GeneratedFile[] }).files)
    : await ProjectFilesystemService.readFiles(id)
  const { files } = splitWorkspaceStateFiles(ProjectFilesystemService.normalizeFiles(inputFiles))

  const syntax = validateRuntimeSyntax(files)
  const imports = validateRuntimeImports(files)
  let graphWarnings: string[] = []
  let compileError: string | null = null

  try {
    graphWarnings = compileProject(files).warnings
  } catch (error) {
    compileError = error instanceof Error ? error.message : String(error)
  }

  const diagnostics = [
    ...syntax.diagnostics.map((diagnostic) => ({ ...diagnostic, phase: "syntax" })),
    ...imports.diagnostics.map((diagnostic) => ({ ...diagnostic, phase: "imports" })),
    ...(compileError
      ? [{
          phase: "preview-compile",
          file: "preview",
          line: null,
          column: null,
          message: compileError,
        }]
      : []),
  ]

  return NextResponse.json({
    ok: syntax.ok && imports.ok && !compileError,
    fileCount: files.length,
    diagnostics,
    warnings: graphWarnings,
    checkedAt: new Date().toISOString(),
  })
}

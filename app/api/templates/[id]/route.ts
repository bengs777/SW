import { NextRequest, NextResponse } from "next/server"
import { z } from "zod"
import { auth } from "@/auth"
import { getTemplateById } from "@/lib/templates/catalog"
import { TemplateInstantiationService } from "@/lib/services/template-instantiation.service"

const InstantiateSchema = z.object({
  workspaceId: z.string().trim().optional(),
  projectName: z.string().trim().min(2).max(120).optional(),
  description: z.string().trim().max(240).optional(),
})

function mapTemplateError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error)

  switch (message) {
    case "TEMPLATE_NOT_FOUND":
      return NextResponse.json({ error: "Template not found" }, { status: 404 })
    case "USER_NOT_FOUND":
      return NextResponse.json({ error: "User account not found" }, { status: 404 })
    case "WORKSPACE_FORBIDDEN":
      return NextResponse.json({ error: "Workspace access denied" }, { status: 403 })
    default:
      return NextResponse.json({ error: message || "Template instantiation failed" }, { status: 500 })
  }
}

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  const template = getTemplateById(id)

  if (!template) {
    return NextResponse.json({ error: "Template not found" }, { status: 404 })
  }

  return NextResponse.json({ template })
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
    const body = InstantiateSchema.parse(await request.json())

    const result = await TemplateInstantiationService.instantiateTemplate({
      userId: session.user.id,
      templateId: id,
      workspaceId: body.workspaceId,
      projectName: body.projectName,
      description: body.description,
    })

    return NextResponse.json(
      {
        project: result.project,
        workspace: result.workspace,
        template: result.template,
        createdWorkspace: result.createdWorkspace,
      },
      { status: 201 }
    )
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json(
        { error: error.issues[0]?.message || "Invalid template request" },
        { status: 400 }
      )
    }

    return mapTemplateError(error)
  }
}
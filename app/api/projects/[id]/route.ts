import { NextRequest, NextResponse } from "next/server"
import { auth } from "@/auth"
import { prisma } from "@/lib/db/client"
import { ProjectFilePersistenceService } from "@/lib/services/project-file-persistence.service"
import type { GeneratedFile } from "@/lib/types"

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
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
        files: true,
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

    return NextResponse.json({ project })
  } catch (error) {
    console.error("[v0] Error fetching project:", error)
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

  try {
    const { id } = await params
    const body = await request.json()
    const { name, description, prompt } = body

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
        ...(name && { name }),
        ...(description && { description }),
        ...(prompt && { prompt }),
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

    return NextResponse.json({
      success: true,
      historyId: saved.historyId,
      fileDiff: saved.fileDiff,
    })
  } catch (error) {
    console.error("[v0] Error saving generation:", error)
    return NextResponse.json(
      { error: "Failed to save generation" },
      { status: 500 }
    )
  }
}

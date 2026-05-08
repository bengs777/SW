import { NextRequest, NextResponse } from "next/server"
import { z } from "zod"
import { auth } from "@/auth"
import { prisma } from "@/lib/db/client"
import { WorkspaceService } from "@/lib/services/workspace.service"
import { UserService } from "@/lib/services/user.service"

const CreateProjectSchema = z.object({
  workspaceId: z.string().trim().min(1).max(120),
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(500).optional().nullable(),
  prompt: z.string().trim().max(12000).optional().nullable(),
})

export async function GET(request: NextRequest) {
  const session = await auth()
  if (!session?.user?.email) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  try {
    const user = await UserService.createUserWithWorkspaceIfMissing(
      session.user.email,
      session.user.name ?? null,
      session.user.image ?? null
    )

    if (!user) {
      return NextResponse.json({ error: "User not found" }, { status: 404 })
    }

    const workspaceId = request.nextUrl.searchParams.get("workspaceId")

    if (!workspaceId) {
      return NextResponse.json(
        { error: "workspaceId is required" },
        { status: 400 }
      )
    }

    // Check if user has access to workspace
    const membership = await WorkspaceService.checkMembership(
      workspaceId,
      user.id
    )

    if (!membership) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 })
    }

    const projects = await prisma.project.findMany({
      where: { workspaceId },
      include: {
        files: {
          take: 5, // Get latest 5 files
        },
      },
      orderBy: { updatedAt: "desc" },
    })

    return NextResponse.json({ projects })
  } catch (error) {
    console.error("[v0] Error fetching projects:", error)
    return NextResponse.json(
      { error: "Failed to fetch projects" },
      { status: 500 }
    )
  }
}

export async function POST(request: NextRequest) {
  const session = await auth()
  if (!session?.user?.email) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  try {
    const user = await UserService.createUserWithWorkspaceIfMissing(
      session.user.email,
      session.user.name ?? null,
      session.user.image ?? null
    )

    if (!user) {
      return NextResponse.json({ error: "User not found" }, { status: 404 })
    }

    const { name, description, workspaceId, prompt } = CreateProjectSchema.parse(await request.json())

    // Check if user has access to workspace
    const membership = await WorkspaceService.checkMembership(
      workspaceId,
      user.id
    )

    if (!membership) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 })
    }

    const project = await prisma.project.create({
      data: {
        name,
        description,
        prompt,
        workspaceId,
      },
    })

    return NextResponse.json({ project }, { status: 201 })
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json(
        { error: error.issues[0]?.message || "Invalid project request" },
        { status: 400 }
      )
    }

    console.error("[v0] Error creating project:", error)
    return NextResponse.json(
      { error: "Failed to create project" },
      { status: 500 }
    )
  }
}

import { NextRequest, NextResponse } from "next/server"
import { z } from "zod"
import { auth } from "@/auth"
import { prisma } from "@/lib/db/client"
import { UserService } from "@/lib/services/user.service"

const CreateProjectSchema = z.object({
  workspaceId: z.string().trim().min(1).max(120),
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(500).optional().nullable(),
  prompt: z.string().trim().max(12000).optional().nullable(),
})

/**
 * Checks if a user has access to a workspace.
 * Checks both WorkspaceMember table AND workspace.createdBy for resilience
 * against orphaned membership records.
 */
async function userHasWorkspaceAccess(workspaceId: string, userId: string): Promise<boolean> {
  // First try the fast path: check membership table
  const membership = await prisma.workspaceMember.findUnique({
    where: { workspaceId_userId: { workspaceId, userId } },
    select: { id: true },
  })

  if (membership) return true

  // Fallback: check if user is the workspace creator (handles orphaned membership)
  const workspace = await prisma.workspace.findUnique({
    where: { id: workspaceId },
    select: { createdBy: true },
  })

  if (workspace?.createdBy === userId) {
    // Auto-heal: create the missing membership record
    await prisma.workspaceMember.upsert({
      where: { workspaceId_userId: { workspaceId, userId } },
      create: { workspaceId, userId, role: "admin" },
      update: {},
    }).catch(() => null)
    return true
  }

  return false
}

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

    // Use session.user.id as the authoritative user ID (matches what /api/workspaces uses)
    const userId = session.user.id || user.id
    const hasAccess = await userHasWorkspaceAccess(workspaceId, userId)

    if (!hasAccess) {
      console.warn("[projects:GET] Forbidden", { userId, workspaceId, email: session.user.email, userServiceId: user.id })
      return NextResponse.json({ error: "Forbidden" }, { status: 403 })
    }

    const projects = await prisma.project.findMany({
      where: { workspaceId },
      include: {
        files: {
          take: 5,
        },
      },
      orderBy: { updatedAt: "desc" },
    })

    return NextResponse.json({ projects })
  } catch (error) {
    console.error("[projects:GET] Error:", error)
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

    // Use session.user.id as the authoritative user ID
    const userId = session.user.id || user.id
    const hasAccess = await userHasWorkspaceAccess(workspaceId, userId)

    if (!hasAccess) {
      console.warn("[projects:POST] Forbidden", { userId, workspaceId, email: session.user.email, userServiceId: user.id })
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

    console.error("[projects:POST] Error:", error)
    return NextResponse.json(
      { error: "Failed to create project" },
      { status: 500 }
    )
  }
}

import Link from "next/link"
import { redirect } from "next/navigation"
import { auth } from "@/auth"
import { prisma } from "@/lib/db/client"
import { ProjectList } from "@/components/dashboard/project-list"
import { NewProjectTrigger } from "@/components/dashboard/new-project-trigger"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { ArrowLeftRight, FolderOpen, Sparkles } from "lucide-react"

type WorkspaceOption = {
  id: string
  name: string
}

export default async function ProjectsPage() {
  const session = await auth()

  if (!session?.user?.email) {
    redirect("/login")
  }

  let workspaceOptions: WorkspaceOption[] = []

  try {
    const user = await prisma.user.findUnique({
      where: { email: session.user.email },
      select: {
        id: true,
      },
    })

    if (user) {
      const memberships = await prisma.workspaceMember.findMany({
        where: { userId: user.id },
        include: {
          workspace: {
            select: {
              id: true,
              name: true,
            },
          },
        },
      })

      workspaceOptions = memberships.map((membership) => ({
        id: membership.workspace.id,
        name: membership.workspace.name,
      }))
    }
  } catch (error) {
    console.error("[projects] Failed to load workspace list:", error)
  }

  const defaultWorkspaceId = workspaceOptions[0]?.id

  return (
    <div className="space-y-6 pb-6">
      <section className="relative overflow-hidden rounded-3xl border border-border/70 bg-card/90 p-6 shadow-sm sm:p-8">
        <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_top_right,oklch(0.97_0_0_/_0.4),transparent_28%),radial-gradient(circle_at_bottom_left,oklch(0.985_0_0_/_0.55),transparent_32%)] dark:bg-[radial-gradient(circle_at_top_right,oklch(0.269_0_0_/_0.45),transparent_24%),radial-gradient(circle_at_bottom_left,oklch(0.205_0_0_/_0.34),transparent_30%)]" />
        <div className="relative flex flex-col gap-6 lg:flex-row lg:items-end lg:justify-between">
          <div className="max-w-3xl space-y-4">
            <Badge
              variant="secondary"
              className="w-fit gap-2 rounded-full border border-border/70 bg-background/70 px-3 py-1.5 text-xs font-medium tracking-wide text-foreground"
            >
              <Sparkles className="h-3.5 w-3.5" />
              Projects library
            </Badge>
            <div className="space-y-3">
              <h1 className="max-w-2xl text-3xl font-semibold tracking-tight text-foreground sm:text-4xl">
                Manage every generated project from a single, clean workspace view.
              </h1>
              <p className="max-w-3xl text-sm leading-6 text-muted-foreground sm:text-base">
                Browse generated apps, open previews, and keep production-ready work separated by workspace without bouncing through the main overview.
              </p>
            </div>
            <div className="flex flex-wrap gap-2 text-xs text-muted-foreground">
              <span className="inline-flex items-center gap-2 rounded-full border border-border/70 bg-background/70 px-3 py-2">
                <FolderOpen className="h-3.5 w-3.5" />
                {workspaceOptions.length} active workspaces
              </span>
              <span className="inline-flex items-center gap-2 rounded-full border border-border/70 bg-background/70 px-3 py-2">
                <ArrowLeftRight className="h-3.5 w-3.5" />
                Switch from the sidebar
              </span>
            </div>
          </div>
          <div className="flex flex-wrap gap-3">
            <Button asChild variant="outline" className="rounded-full px-4 shadow-sm">
              <Link href="/dashboard" className="inline-flex items-center gap-2">
                Back to overview
              </Link>
            </Button>
            {workspaceOptions.length > 0 ? (
              <NewProjectTrigger
                workspaces={workspaceOptions}
                defaultWorkspaceId={defaultWorkspaceId}
              />
            ) : (
              <Button variant="outline" className="rounded-full px-4" disabled>
                New Project
              </Button>
            )}
          </div>
        </div>
      </section>

      <Card className="overflow-hidden border-border/70 shadow-sm">
        <CardHeader className="border-b border-border/70 bg-muted/20">
          <CardTitle>Project gallery</CardTitle>
          <CardDescription>
            Search, open, and manage the generated apps in your active workspace.
          </CardDescription>
        </CardHeader>
        <CardContent className="p-6">
          <ProjectList searchQuery="" workspaceId={defaultWorkspaceId} />
        </CardContent>
      </Card>
    </div>
  )
}

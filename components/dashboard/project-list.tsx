"use client"

import { useEffect, useMemo, useState } from "react"
import Link from "next/link"
import { formatDistanceToNow } from "date-fns"
import { FolderOpen, Globe, MoreHorizontal, ExternalLink, Trash2 } from "lucide-react"
import { useRouter } from "next/navigation"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Badge } from "@/components/ui/badge"
import { Alert, AlertDescription } from "@/components/ui/alert"

interface ProjectListProps {
  searchQuery: string
  workspaceId?: string
}

interface ProjectItem {
  id: string
  name: string
  description: string | null
  updatedAt: string
  files: Array<{ id: string }>
}

export function ProjectList({ searchQuery, workspaceId }: ProjectListProps) {
  const router = useRouter()
  const [projects, setProjects] = useState<ProjectItem[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState("")
  const [deletingProjectId, setDeletingProjectId] = useState<string | null>(null)

  useEffect(() => {
    const fetchProjects = async () => {
      if (!workspaceId) {
        setProjects([])
        setError("")
        setIsLoading(false)
        return
      }

      setIsLoading(true)
      setError("")

      try {
        const response = await fetch(`/api/projects?workspaceId=${workspaceId}`)
        const data = await response.json().catch(() => ({}))

        if (!response.ok) {
          setError(data.error || "Failed to load projects")
          setProjects([])
          return
        }

        setProjects(data.projects || [])
      } catch (fetchError) {
        console.error("[v0] Failed to fetch projects:", fetchError)
        setError("Unable to load projects right now.")
        setProjects([])
      } finally {
        setIsLoading(false)
      }
    }

    fetchProjects()
  }, [workspaceId])

  const filteredProjects = useMemo(
    () =>
      projects.filter(
        (project) =>
          project.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
          (project.description || "").toLowerCase().includes(searchQuery.toLowerCase())
      ),
    [projects, searchQuery]
  )

  const handleDelete = async (projectId: string) => {
    setDeletingProjectId(projectId)
    setError("")

    try {
      const response = await fetch(`/api/projects/${projectId}`, {
        method: "DELETE",
      })

      const data = await response.json().catch(() => ({}))

      if (!response.ok) {
        setError(data.error || "Failed to delete project")
        return
      }

      setProjects((currentProjects) =>
        currentProjects.filter((project) => project.id !== projectId)
      )
      router.refresh()
    } catch (deleteError) {
      console.error("[v0] Failed to delete project:", deleteError)
      setError("Unable to delete project right now.")
    } finally {
      setDeletingProjectId(null)
    }
  }

  if (isLoading) {
    return (
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {Array.from({ length: 3 }).map((_, index) => (
          <div
            key={index}
            className="rounded-3xl border border-border/70 bg-card/80 p-5 shadow-sm"
          >
            <div className="animate-pulse space-y-4">
              <div className="flex items-start gap-3">
                <div className="h-10 w-10 rounded-2xl bg-muted" />
                <div className="flex-1 space-y-2">
                  <div className="h-4 w-2/3 rounded-full bg-muted" />
                  <div className="h-3 w-full rounded-full bg-muted/80" />
                  <div className="h-3 w-5/6 rounded-full bg-muted/80" />
                </div>
              </div>
              <div className="flex items-center justify-between">
                <div className="h-6 w-20 rounded-full bg-muted" />
                <div className="h-3 w-24 rounded-full bg-muted/80" />
              </div>
            </div>
          </div>
        ))}
      </div>
    )
  }

  if (error) {
    return (
      <Alert variant="destructive" className="rounded-2xl border-destructive/30 bg-destructive/5">
        <AlertDescription>{error}</AlertDescription>
      </Alert>
    )
  }

  if (filteredProjects.length === 0) {
    const title = workspaceId ? "No projects found" : "Select a workspace"
    const description = workspaceId
      ? searchQuery
        ? "Try a different search term or clear the filter to see more projects."
        : "Create your first project to start building inside this workspace."
      : "Choose a workspace in the sidebar before generating projects."

    return (
      <div className="flex flex-col items-center justify-center rounded-3xl border border-dashed border-border/70 bg-muted/20 px-6 py-16 text-center">
        <div className="mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-background text-muted-foreground shadow-sm">
          <Globe className="h-7 w-7" />
        </div>
        <h3 className="text-lg font-semibold text-foreground">{title}</h3>
        <p className="mt-2 max-w-md text-sm leading-6 text-muted-foreground">{description}</p>
      </div>
    )
  }

  return (
    <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
      {filteredProjects.map((project) => (
        <Link
          key={project.id}
          href={`/dashboard/project/${project.id}`}
          className="group relative flex h-full flex-col overflow-hidden rounded-3xl border border-border/70 bg-card/85 p-5 shadow-sm transition-all duration-300 hover:-translate-y-1 hover:border-border hover:shadow-lg"
        >
          <div className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-primary/50 to-transparent" />
          <div className="flex items-start justify-between gap-3">
            <div className="flex min-w-0 flex-1 gap-3">
              <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl bg-primary/10 text-primary">
                <FolderOpen className="h-5 w-5" />
              </div>
              <div className="min-w-0">
                <h3 className="truncate font-semibold text-foreground group-hover:text-foreground">
                {project.name}
                </h3>
                <p className="mt-1 line-clamp-2 text-sm leading-6 text-muted-foreground">
                  {project.description || "No description yet."}
                </p>
              </div>
            </div>
            <DropdownMenu>
              <DropdownMenuTrigger asChild onClick={(e) => e.preventDefault()}>
                <Button variant="ghost" size="icon" className="h-9 w-9 rounded-full">
                  <MoreHorizontal className="h-4 w-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="rounded-2xl">
                <DropdownMenuItem asChild className="rounded-xl">
                  <Link href={`/dashboard/project/${project.id}`}>
                    <ExternalLink className="mr-2 h-4 w-4" />
                    Open Preview
                  </Link>
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  className="rounded-xl text-destructive"
                  disabled={deletingProjectId === project.id}
                  onClick={(event) => {
                    event.preventDefault()
                    void handleDelete(project.id)
                  }}
                >
                  <Trash2 className="mr-2 h-4 w-4" />
                  {deletingProjectId === project.id ? "Deleting..." : "Delete"}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
          <div className="mt-5 flex items-center justify-between gap-3">
            <Badge variant="secondary" className="rounded-full px-2.5 py-1 text-xs">
              {project.files.length > 0 ? `${project.files.length} files` : "draft"}
            </Badge>
            <span className="text-xs text-muted-foreground">
              {formatDistanceToNow(new Date(project.updatedAt), { addSuffix: true })}
            </span>
          </div>
        </Link>
      ))}
    </div>
  )
}

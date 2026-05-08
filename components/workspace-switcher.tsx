"use client"

import { useState, useEffect } from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { ChevronsUpDown, Plus, Check } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"

interface Workspace {
  workspace: {
    id: string
    name: string
    slug: string
  }
}

export function WorkspaceSwitcher({ currentWorkspaceId }: { currentWorkspaceId?: string }) {
  const router = useRouter()
  const [workspaces, setWorkspaces] = useState<Workspace[]>([])
  const [loading, setLoading] = useState(true)
  const [currentWorkspace, setCurrentWorkspace] = useState<Workspace | null>(null)

  useEffect(() => {
    const fetchWorkspaces = async () => {
      try {
        const response = await fetch("/api/workspaces")
        if (response.ok) {
          const data = await response.json()
          setWorkspaces(data)
          
          if (currentWorkspaceId) {
            const current = data.find(
              (w: Workspace) => w.workspace.id === currentWorkspaceId
            )
            setCurrentWorkspace(current || data[0])
          } else if (data.length > 0) {
            setCurrentWorkspace(data[0])
          }
        }
      } catch (error) {
        console.error("[v0] Failed to fetch workspaces:", error)
      } finally {
        setLoading(false)
      }
    }

    fetchWorkspaces()
  }, [currentWorkspaceId])

  const switchWorkspace = (workspace: Workspace) => {
    setCurrentWorkspace(workspace)
    router.push(`/dashboard/workspace/${workspace.workspace.id}`)
  }

  if (loading) {
    return (
      <Button
        variant="outline"
        className="w-full justify-between rounded-2xl border-sidebar-border bg-background/70 shadow-sm"
        disabled
      >
        Loading workspaces...
      </Button>
    )
  }

  if (!currentWorkspace) {
    return (
      <Button
        variant="outline"
        className="w-full justify-between rounded-2xl border-sidebar-border bg-background/70 shadow-sm"
      >
        Select Workspace
      </Button>
    )
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="outline"
          className="w-full justify-between rounded-2xl border-sidebar-border bg-background/70 px-4 py-6 text-left shadow-sm transition-colors hover:bg-background"
        >
          <span className="truncate">{currentWorkspace.workspace.name}</span>
          <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent className="w-56 rounded-2xl" align="start">
        <DropdownMenuLabel>Workspaces</DropdownMenuLabel>
        <DropdownMenuSeparator />
        {workspaces.map((ws) => (
          <DropdownMenuItem
            key={ws.workspace.id}
            onClick={() => switchWorkspace(ws)}
            className="flex items-center justify-between rounded-xl"
          >
            <span>{ws.workspace.name}</span>
            {ws.workspace.id === currentWorkspace.workspace.id && (
              <Check className="h-4 w-4" />
            )}
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuItem asChild className="rounded-xl">
          <Link href="/dashboard/workspace-settings" className="flex items-center">
            <Plus className="mr-2 h-4 w-4" />
            New Workspace
          </Link>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

"use client"

import { useState, useEffect } from "react"
import { Search } from "lucide-react"
import { Input } from "@/components/ui/input"
import { ProjectList } from "@/components/dashboard/project-list"
import { useWorkspaces } from "@/hooks/use-workspaces"
import { NewProjectTrigger } from "@/components/dashboard/new-project-trigger"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"

export default function ProjectsPage() {
  const [searchQuery, setSearchQuery] = useState("")
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState<string | undefined>()
  const { workspaces, isLoading } = useWorkspaces()

  // Set default workspace on first load
  useEffect(() => {
    if (!selectedWorkspaceId && workspaces.length > 0 && !isLoading) {
      setSelectedWorkspaceId(workspaces[0].id)
    }
  }, [workspaces, isLoading, selectedWorkspaceId])

  return (
    <div className="flex min-h-screen flex-col gap-6">
      {/* Header */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Projects</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            Manage all your AI-generated web projects in one place.
          </p>
        </div>
        <NewProjectTrigger workspaces={workspaces} defaultWorkspaceId={selectedWorkspaceId} />
      </div>

      {/* Search and Filter */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:gap-3">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder="Search projects..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="pl-10"
          />
        </div>
        {workspaces.length > 1 && (
          <Select value={selectedWorkspaceId || ""} onValueChange={setSelectedWorkspaceId}>
            <SelectTrigger className="w-full sm:w-48">
              <SelectValue placeholder="Select workspace" />
            </SelectTrigger>
            <SelectContent>
              {workspaces.map((workspace) => (
                <SelectItem key={workspace.id} value={workspace.id}>
                  {workspace.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
      </div>

      {/* Projects Grid */}
      <ProjectList searchQuery={searchQuery} workspaceId={selectedWorkspaceId} />
    </div>
  )
}

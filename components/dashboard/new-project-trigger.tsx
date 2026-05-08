"use client"

import { useState } from "react"
import { Plus } from "lucide-react"
import { Button } from "@/components/ui/button"
import { NewProjectDialog } from "@/components/dashboard/new-project-dialog"

interface WorkspaceOption {
  id: string
  name: string
}

interface NewProjectTriggerProps {
  workspaces: WorkspaceOption[]
  defaultWorkspaceId?: string
}

export function NewProjectTrigger({
  workspaces,
  defaultWorkspaceId,
}: NewProjectTriggerProps) {
  const [open, setOpen] = useState(false)

  return (
    <>
      <Button onClick={() => setOpen(true)} className="gap-2 rounded-full px-4 shadow-sm shadow-black/10">
        <Plus className="h-4 w-4" />
        New Project
      </Button>
      <NewProjectDialog
        open={open}
        onOpenChange={setOpen}
        workspaces={workspaces}
        defaultWorkspaceId={defaultWorkspaceId}
      />
    </>
  )
}

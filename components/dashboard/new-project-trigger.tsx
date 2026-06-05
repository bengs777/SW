"use client"

import { useEffect, useRef, useState } from "react"
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
  buttonLabel?: string
  initialName?: string
  initialPrompt?: string
  initialDescription?: string
  initialTemplateId?: string | null
  autoOpenKey?: string | null
  onProjectCreated?: (projectId: string) => void
}

export function NewProjectTrigger({
  workspaces,
  defaultWorkspaceId,
  buttonLabel = "New Project",
  initialName = "",
  initialPrompt = "",
  initialDescription = "",
  initialTemplateId = null,
  autoOpenKey = null,
  onProjectCreated,
}: NewProjectTriggerProps) {
  const [open, setOpen] = useState(false)
  const lastAutoOpenKeyRef = useRef<string | null>(null)

  useEffect(() => {
    if (!autoOpenKey || lastAutoOpenKeyRef.current === autoOpenKey) {
      return
    }

    lastAutoOpenKeyRef.current = autoOpenKey
    setOpen(true)
  }, [autoOpenKey])

  return (
    <>
      <Button onClick={() => setOpen(true)} className="gap-2 rounded-full px-4 shadow-sm shadow-black/10">
        <Plus className="h-4 w-4" />
        {buttonLabel}
      </Button>
      <NewProjectDialog
        open={open}
        onOpenChange={setOpen}
        workspaces={workspaces}
        defaultWorkspaceId={defaultWorkspaceId}
        initialName={initialName}
        initialPrompt={initialPrompt}
        initialDescription={initialDescription}
        initialTemplateId={initialTemplateId}
        onProjectCreated={onProjectCreated}
      />
    </>
  )
}

"use client"

import { useEffect, useState } from "react"
import { useRouter } from "next/navigation"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Spinner } from "@/components/ui/spinner"
import { Alert, AlertDescription } from "@/components/ui/alert"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"

interface NewProjectDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  workspaces: Array<{
    id: string
    name: string
  }>
  defaultWorkspaceId?: string
}

export function NewProjectDialog({
  open,
  onOpenChange,
  workspaces,
  defaultWorkspaceId,
}: NewProjectDialogProps) {
  const router = useRouter()
  const [isCreating, setIsCreating] = useState(false)
  const [name, setName] = useState("")
  const [prompt, setPrompt] = useState("")
  const [description, setDescription] = useState("")
  const [workspaceId, setWorkspaceId] = useState(defaultWorkspaceId ?? workspaces[0]?.id ?? "")
  const [error, setError] = useState("")

  useEffect(() => {
    setWorkspaceId(defaultWorkspaceId ?? workspaces[0]?.id ?? "")
  }, [defaultWorkspaceId, workspaces])

  const handleCreate = async () => {
    if (!name.trim() || !workspaceId || !prompt.trim()) return

    setIsCreating(true)
    setError("")

    try {
      const response = await fetch("/api/projects", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          name: name.trim(),
          prompt: prompt.trim(),
          description: description.trim() || undefined,
          workspaceId,
        }),
      })

      const data = await response.json().catch(() => ({}))

      if (!response.ok) {
        setError(data.error || "Failed to create project")
        return
      }

      const projectId = data.project?.id
      if (!projectId) {
        setError("Project was created, but no project id was returned")
        return
      }

      setName("")
      setPrompt("")
      setDescription("")
      setWorkspaceId(defaultWorkspaceId ?? workspaces[0]?.id ?? "")
      onOpenChange(false)
      router.refresh()
      router.push(`/dashboard/project/${projectId}`)
    } catch (createError) {
      console.error("[v0] Failed to create project:", createError)
      setError("Unable to create project right now. Please try again.")
    } finally {
      setIsCreating(false)
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!isCreating) {
          onOpenChange(nextOpen)
          if (!nextOpen) {
            setError("")
            setPrompt("")
            setWorkspaceId(defaultWorkspaceId ?? workspaces[0]?.id ?? "")
          }
        }
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Create new project</DialogTitle>
          <DialogDescription>
            Start a new AI-powered web application project.
          </DialogDescription>
        </DialogHeader>
        <FieldGroup className="py-4">
          {workspaces.length > 1 && (
            <Field>
              <FieldLabel>Workspace</FieldLabel>
              <Select value={workspaceId} onValueChange={setWorkspaceId}>
                <SelectTrigger className="w-full">
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
            </Field>
          )}
          <Field>
            <FieldLabel>Project name</FieldLabel>
            <Input
              placeholder="My awesome project"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </Field>
          <Field>
            <FieldLabel>Prompt</FieldLabel>
            <Textarea
              placeholder="Build a modern dashboard with a sidebar, KPI cards, and a project list."
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              rows={4}
            />
          </Field>
          <Field>
            <FieldLabel>Description (optional)</FieldLabel>
            <Textarea
              placeholder="A brief description of your project..."
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={3}
            />
          </Field>
          {error && (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
        </FieldGroup>
        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => {
              setError("")
              onOpenChange(false)
            }}
            disabled={isCreating}
          >
            Cancel
          </Button>
          <Button
            onClick={handleCreate}
            disabled={!name.trim() || !workspaceId || !prompt.trim() || isCreating}
          >
            {isCreating ? (
              <>
                <Spinner className="mr-2" />
                Creating...
              </>
            ) : (
              "Create Project"
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

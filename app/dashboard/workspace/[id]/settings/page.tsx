"use client"

import { useState } from "react"
import { useParams } from "next/navigation"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field"
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger } from "@/components/ui/alert-dialog"

export default function WorkspaceSettingsPage() {
  const params = useParams() as { id: string }
  const [workspaceName, setWorkspaceName] = useState("")
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState("")
  const [success, setSuccess] = useState("")

  const handleUpdateWorkspace = async (e: React.FormEvent) => {
    e.preventDefault()
    setIsLoading(true)
    setError("")
    setSuccess("")

    try {
      const response = await fetch(`/api/workspaces/${params.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: workspaceName }),
      })

      if (response.ok) {
        setSuccess("Workspace updated successfully")
        setWorkspaceName("")
      } else {
        setError("Failed to update workspace")
      }
    } catch {
      setError("An error occurred")
    } finally {
      setIsLoading(false)
    }
  }

  const handleDeleteWorkspace = async () => {
    try {
      const response = await fetch(`/api/workspaces/${params.id}`, {
        method: "DELETE",
      })

      if (response.ok) {
        window.location.href = "/dashboard"
      } else {
        setError("Failed to delete workspace")
      }
    } catch {
      setError("An error occurred")
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Workspace Settings</h1>
        <p className="text-muted-foreground mt-2">Manage your workspace settings and preferences</p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Workspace Name</CardTitle>
          <CardDescription>Update your workspace name</CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleUpdateWorkspace}>
            <FieldGroup>
              <Field>
                <FieldLabel>Name</FieldLabel>
                <Input
                  placeholder="Enter workspace name"
                  value={workspaceName}
                  onChange={(e) => setWorkspaceName(e.target.value)}
                  required
                />
              </Field>
            </FieldGroup>
            {error && <p className="text-sm text-red-500 mt-2">{error}</p>}
            {success && <p className="text-sm text-green-500 mt-2">{success}</p>}
            <Button type="submit" disabled={isLoading} className="mt-4">
              {isLoading ? "Updating..." : "Update Workspace"}
            </Button>
          </form>
        </CardContent>
      </Card>

      <Card className="border-red-200">
        <CardHeader>
          <CardTitle className="text-red-600">Delete Workspace</CardTitle>
          <CardDescription>This action cannot be undone</CardDescription>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground mb-4">
            Deleting a workspace will permanently remove all projects and data associated with it.
          </p>
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button variant="destructive">Delete Workspace</Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Delete Workspace</AlertDialogTitle>
                <AlertDialogDescription>
                  This will permanently delete this workspace and all its data. This action cannot be undone.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <div className="flex gap-3 justify-end">
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <AlertDialogAction
                  onClick={handleDeleteWorkspace}
                  className="bg-red-600 hover:bg-red-700"
                >
                  Delete
                </AlertDialogAction>
              </div>
            </AlertDialogContent>
          </AlertDialog>
        </CardContent>
      </Card>
    </div>
  )
}

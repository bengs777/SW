"use client"

import { useState, useEffect } from "react"
import { useParams } from "next/navigation"
import { Users, Settings, Trash2, Plus, Copy, Check } from "lucide-react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Spinner } from "@/components/ui/spinner"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field"

interface WorkspaceData {
  id: string
  name: string
  slug: string
  image?: string | null
  members: Array<{
    id: string
    userId: string
    role: string
    user: {
      name?: string | null
      email: string
      image?: string | null
    }
  }>
}

export default function WorkspacePage() {
  const params = useParams()
  const workspaceId = params.id as string
  const [workspace, setWorkspace] = useState<WorkspaceData | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState("")
  const [showInviteDialog, setShowInviteDialog] = useState(false)
  const [inviteEmail, setInviteEmail] = useState("")
  const [isSendingInvite, setIsSendingInvite] = useState(false)
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    const fetchWorkspace = async () => {
      setIsLoading(true)
      setError("")

      try {
        const response = await fetch(`/api/workspaces/${workspaceId}`)
        const data = await response.json().catch(() => ({}))

        if (!response.ok) {
          setError(data.error || "Failed to load workspace")
          return
        }

        setWorkspace(data)
      } catch (err) {
        console.error("[v0] Failed to fetch workspace:", err)
        setError("Unable to load workspace right now.")
      } finally {
        setIsLoading(false)
      }
    }

    if (workspaceId) {
      fetchWorkspace()
    }
  }, [workspaceId])

  const handleSendInvite = async () => {
    if (!inviteEmail.trim() || isSendingInvite) return // Guard against re-entry

    setIsSendingInvite(true)
    setError("")

    try {
      const response = await fetch(`/api/workspaces/${workspaceId}/members`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ email: inviteEmail.trim() }),
      })

      const data = await response.json().catch(() => ({}))

      if (!response.ok) {
        setError(data.error || "Failed to send invite")
        return
      }

      setInviteEmail("")
      setShowInviteDialog(false)
      // Refresh workspace data
      if (workspace) {
        setWorkspace({
          ...workspace,
          members: [...workspace.members, data.member],
        })
      }
    } catch (err) {
      console.error("[v0] Failed to send invite:", err)
      setError("Unable to send invite right now.")
    } finally {
      setIsSendingInvite(false)
    }
  }

  const handleCopyLink = () => {
    const inviteLink = `${window.location.origin}/join-workspace/${workspaceId}`
    navigator.clipboard.writeText(inviteLink)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  const getInitials = (name?: string | null) => {
    if (!name) return "U"
    return name
      .split(" ")
      .map((n) => n[0])
      .join("")
      .toUpperCase()
      .slice(0, 2)
  }

  if (isLoading) {
    return (
      <Card>
        <CardContent className="flex items-center justify-center py-12">
          <Spinner className="mr-2" />
          Loading workspace...
        </CardContent>
      </Card>
    )
  }

  if (error || !workspace) {
    return (
      <Alert variant="destructive">
        <AlertDescription>{error || "Workspace not found"}</AlertDescription>
      </Alert>
    )
  }

  return (
    <div className="flex min-h-screen flex-col gap-6">
      {/* Header */}
      <div>
        <h1 className="text-3xl font-bold tracking-tight">{workspace.name}</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Manage workspace members, settings, and collaboration.
        </p>
      </div>

      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      <Tabs defaultValue="members" className="w-full">
        <TabsList className="grid w-full grid-cols-2 md:w-auto">
          <TabsTrigger value="members" className="gap-2">
            <Users className="h-4 w-4" />
            <span className="hidden sm:inline">Members</span>
          </TabsTrigger>
          <TabsTrigger value="settings" className="gap-2">
            <Settings className="h-4 w-4" />
            <span className="hidden sm:inline">Settings</span>
          </TabsTrigger>
        </TabsList>

        {/* Members Tab */}
        <TabsContent value="members" className="mt-6">
          <Card>
            <CardHeader className="flex flex-row items-center justify-between">
              <div>
                <CardTitle>Members</CardTitle>
                <CardDescription>Manage your workspace members and permissions</CardDescription>
              </div>
              <Button onClick={() => setShowInviteDialog(true)} className="gap-2 rounded-full">
                <Plus className="h-4 w-4" />
                Invite Member
              </Button>
            </CardHeader>
            <CardContent>
              <div className="space-y-3">
                {workspace.members.map((member) => (
                  <div
                    key={member.id}
                    className="flex items-center justify-between rounded-lg border border-border/70 bg-card/50 p-4"
                  >
                    <div className="flex items-center gap-3">
                      <Avatar className="h-10 w-10">
                        <AvatarImage src={member.user.image || ""} />
                        <AvatarFallback>{getInitials(member.user.name)}</AvatarFallback>
                      </Avatar>
                      <div>
                        <p className="font-medium text-sm">{member.user.name || "Unknown"}</p>
                        <p className="text-xs text-muted-foreground">{member.user.email}</p>
                      </div>
                    </div>
                    <Badge variant="secondary" className="rounded-full px-3 py-1 text-xs">
                      {member.role}
                    </Badge>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>

          {/* Invite Link */}
          <Card className="mt-6">
            <CardHeader>
              <CardTitle className="text-lg">Invite Link</CardTitle>
              <CardDescription>Share this link to invite others to your workspace</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="flex gap-2">
                <Input
                  value={`${window.location.origin}/join-workspace/${workspaceId}`}
                  disabled
                  className="font-mono text-sm"
                />
                <Button
                  variant="outline"
                  size="icon"
                  onClick={handleCopyLink}
                  className="shrink-0"
                >
                  {copied ? <Check className="h-4 w-4 text-green-500" /> : <Copy className="h-4 w-4" />}
                </Button>
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        {/* Settings Tab */}
        <TabsContent value="settings" className="mt-6 space-y-6">
          <Card>
            <CardHeader>
              <CardTitle>Workspace Information</CardTitle>
              <CardDescription>Basic information about your workspace</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div>
                <label className="text-sm font-medium">Workspace Name</label>
                <Input value={workspace.name} disabled className="mt-1" />
              </div>
              <div>
                <label className="text-sm font-medium">Workspace Slug</label>
                <Input value={workspace.slug} disabled className="mt-1 font-mono text-sm" />
              </div>
            </CardContent>
          </Card>

          {/* Danger Zone */}
          <Card className="border-destructive/50">
            <CardHeader>
              <CardTitle className="text-lg text-destructive">Danger Zone</CardTitle>
              <CardDescription>Irreversible and destructive actions</CardDescription>
            </CardHeader>
            <CardContent>
              <Button variant="destructive" className="gap-2">
                <Trash2 className="h-4 w-4" />
                Delete Workspace
              </Button>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>

      {/* Invite Dialog */}
      <Dialog open={showInviteDialog} onOpenChange={setShowInviteDialog}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Invite Member</DialogTitle>
            <DialogDescription>
              Send an invitation to join this workspace.
            </DialogDescription>
          </DialogHeader>
          <FieldGroup className="py-4">
            <Field>
              <FieldLabel>Email Address</FieldLabel>
              <Input
                type="email"
                placeholder="user@example.com"
                value={inviteEmail}
                onChange={(e) => setInviteEmail(e.target.value)}
              />
            </Field>
          </FieldGroup>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setShowInviteDialog(false)}
              disabled={isSendingInvite}
            >
              Cancel
            </Button>
            <Button
              onClick={handleSendInvite}
              disabled={!inviteEmail.trim() || isSendingInvite}
            >
              {isSendingInvite ? (
                <>
                  <Spinner className="mr-2" />
                  Sending...
                </>
              ) : (
                "Send Invite"
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

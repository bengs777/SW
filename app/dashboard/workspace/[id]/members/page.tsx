"use client"

import { useCallback, useEffect, useState } from "react"
import { useParams } from "next/navigation"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Trash2 } from "lucide-react"

interface Member {
  id: string
  userId: string
  role: string
  joinedAt: string
  user: {
    id: string
    email: string
    name: string
    image?: string
  }
}

export default function MembersPage() {
  const params = useParams() as { id: string }
  const [members, setMembers] = useState<Member[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState("")
  const [email, setEmail] = useState("")
  const [role, setRole] = useState("member")
  const [isAdding, setIsAdding] = useState(false)

  const fetchMembers = useCallback(async () => {
    try {
      setLoading(true)
      const response = await fetch(`/api/workspaces/${params.id}/members`)
      if (response.ok) {
        const data = await response.json()
        setMembers(data)
      } else {
        setError("Failed to fetch members")
      }
    } catch {
      setError("An error occurred")
    } finally {
      setLoading(false)
    }
  }, [params.id])

  useEffect(() => {
    void fetchMembers()
  }, [fetchMembers])

  const handleAddMember = async (e: React.FormEvent) => {
    e.preventDefault()
    setError("")
    setIsAdding(true)

    try {
      const response = await fetch(`/api/workspaces/${params.id}/members`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, role }),
      })

      if (response.ok) {
        setEmail("")
        setRole("member")
        await fetchMembers()
      } else {
        const data = await response.json()
        setError(data.error || "Failed to add member")
      }
    } catch {
      setError("An error occurred")
    } finally {
      setIsAdding(false)
    }
  }

  const handleRemoveMember = async (userId: string) => {
    if (!confirm("Are you sure you want to remove this member?")) return

    try {
      const response = await fetch(`/api/workspaces/${params.id}/members/${userId}`, {
        method: "DELETE",
      })

      if (response.ok) {
        await fetchMembers()
      } else {
        setError("Failed to remove member")
      }
    } catch {
      setError("An error occurred")
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Members</h1>
        <p className="text-muted-foreground mt-2">Manage workspace members and their roles</p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Add Member</CardTitle>
          <CardDescription>Invite a new member to your workspace</CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleAddMember}>
            <FieldGroup className="flex gap-4">
              <Field className="flex-1">
                <FieldLabel>Email</FieldLabel>
                <Input
                  type="email"
                  placeholder="member@example.com"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  required
                />
              </Field>
              <Field className="w-32">
                <FieldLabel>Role</FieldLabel>
                <Select value={role} onValueChange={setRole}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="viewer">Viewer</SelectItem>
                    <SelectItem value="editor">Editor</SelectItem>
                    <SelectItem value="admin">Admin</SelectItem>
                  </SelectContent>
                </Select>
              </Field>
              <div className="flex items-end">
                <Button type="submit" disabled={isAdding}>
                  {isAdding ? "Adding..." : "Add Member"}
                </Button>
              </div>
            </FieldGroup>
            {error && <p className="text-sm text-red-500 mt-2">{error}</p>}
          </form>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Workspace Members</CardTitle>
          <CardDescription>{members.length} member{members.length !== 1 ? "s" : ""}</CardDescription>
        </CardHeader>
        <CardContent>
          {loading ? (
            <p className="text-muted-foreground">Loading...</p>
          ) : members.length === 0 ? (
            <p className="text-muted-foreground">No members yet</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Email</TableHead>
                  <TableHead>Role</TableHead>
                  <TableHead>Joined</TableHead>
                  <TableHead>Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {members.map((member) => (
                  <TableRow key={member.id}>
                    <TableCell>{member.user.name || "—"}</TableCell>
                    <TableCell>{member.user.email}</TableCell>
                    <TableCell className="capitalize">{member.role}</TableCell>
                    <TableCell>{new Date(member.joinedAt).toLocaleDateString()}</TableCell>
                    <TableCell>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => handleRemoveMember(member.userId)}
                      >
                        <Trash2 className="h-4 w-4 text-red-500" />
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  )
}

"use client"

import { useCallback, useEffect, useState } from "react"
import { useParams } from "next/navigation"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Copy, Trash2, RotateCw } from "lucide-react"
import { toast } from "sonner"

interface ApiKey {
  id: string
  name: string
  createdAt: string
  lastUsed?: string
  expiresAt?: string
}

export default function ApiKeysPage() {
  const params = useParams() as { id: string }
  const [apiKeys, setApiKeys] = useState<ApiKey[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState("")
  const [keyName, setKeyName] = useState("")
  const [isCreating, setIsCreating] = useState(false)
  const [newKey, setNewKey] = useState<string | null>(null)

  const fetchApiKeys = useCallback(async () => {
    try {
      setLoading(true)
      const response = await fetch(
        `/api/api-keys?workspaceId=${params.id}`
      )
      if (response.ok) {
        const data = await response.json()
        setApiKeys(data)
      } else {
        setError("Failed to fetch API keys")
      }
    } catch {
      setError("An error occurred")
    } finally {
      setLoading(false)
    }
  }, [params.id])

  useEffect(() => {
    void fetchApiKeys()
  }, [fetchApiKeys])

  const handleCreateKey = async (e: React.FormEvent) => {
    e.preventDefault()
    setError("")
    setIsCreating(true)

    try {
      const response = await fetch("/api/api-keys", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          workspaceId: params.id,
          name: keyName,
        }),
      })

      if (response.ok) {
        const data = await response.json()
        setNewKey(data.key)
        setKeyName("")
        await fetchApiKeys()
        toast.success("API key created. Copy it now, you won't see it again!")
      } else {
        const data = await response.json()
        setError(data.error || "Failed to create key")
      }
    } catch {
      setError("An error occurred")
    } finally {
      setIsCreating(false)
    }
  }

  const handleDeleteKey = async (keyId: string) => {
    if (!confirm("Are you sure? This cannot be undone.")) return

    try {
      const response = await fetch(`/api/api-keys/${keyId}`, {
        method: "DELETE",
      })

      if (response.ok) {
        await fetchApiKeys()
        toast.success("API key deleted")
      } else {
        setError("Failed to delete key")
      }
    } catch {
      setError("An error occurred")
    }
  }

  const handleRotateKey = async (keyId: string) => {
    if (!confirm("This will invalidate the old key. Continue?")) return

    try {
      const response = await fetch(`/api/api-keys/${keyId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "rotate" }),
      })

      if (response.ok) {
        const data = await response.json()
        setNewKey(data.key)
        await fetchApiKeys()
        toast.success("API key rotated. Copy the new key!")
      } else {
        setError("Failed to rotate key")
      }
    } catch {
      setError("An error occurred")
    }
  }

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text)
    toast.success("Copied to clipboard")
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">API Keys</h1>
        <p className="text-muted-foreground mt-2">Manage API keys for programmatic access</p>
      </div>

      {newKey && (
        <Card className="border-green-200 bg-green-50">
          <CardHeader>
            <CardTitle className="text-green-900">New API Key Created</CardTitle>
            <CardDescription className="text-green-800">
              Copy your API key now. You won&apos;t be able to see it again.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="flex gap-2">
              <Input
                value={newKey}
                readOnly
                className="font-mono text-sm"
              />
              <Button
                variant="outline"
                onClick={() => copyToClipboard(newKey)}
              >
                <Copy className="h-4 w-4" />
              </Button>
            </div>
            <Button
              variant="ghost"
              className="mt-2"
              onClick={() => setNewKey(null)}
            >
              Dismiss
            </Button>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Create API Key</CardTitle>
          <CardDescription>Create a new API key for your applications</CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleCreateKey}>
            <FieldGroup className="flex gap-4">
              <Field className="flex-1">
                <FieldLabel>Key Name</FieldLabel>
                <Input
                  placeholder="Production API Key"
                  value={keyName}
                  onChange={(e) => setKeyName(e.target.value)}
                  required
                />
              </Field>
              <div className="flex items-end">
                <Button type="submit" disabled={isCreating}>
                  {isCreating ? "Creating..." : "Create Key"}
                </Button>
              </div>
            </FieldGroup>
            {error && <p className="text-sm text-red-500 mt-2">{error}</p>}
          </form>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>API Keys</CardTitle>
          <CardDescription>{apiKeys.length} key{apiKeys.length !== 1 ? "s" : ""}</CardDescription>
        </CardHeader>
        <CardContent>
          {loading ? (
            <p className="text-muted-foreground">Loading...</p>
          ) : apiKeys.length === 0 ? (
            <p className="text-muted-foreground">No API keys yet. Create one to get started.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Created</TableHead>
                  <TableHead>Last Used</TableHead>
                  <TableHead>Expires</TableHead>
                  <TableHead>Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {apiKeys.map((key) => (
                  <TableRow key={key.id}>
                    <TableCell className="font-medium">{key.name}</TableCell>
                    <TableCell>{new Date(key.createdAt).toLocaleDateString()}</TableCell>
                    <TableCell>
                      {key.lastUsed ? new Date(key.lastUsed).toLocaleDateString() : "—"}
                    </TableCell>
                    <TableCell>
                      {key.expiresAt ? new Date(key.expiresAt).toLocaleDateString() : "Never"}
                    </TableCell>
                    <TableCell>
                      <div className="flex gap-2">
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => handleRotateKey(key.id)}
                          title="Rotate key"
                        >
                          <RotateCw className="h-4 w-4" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => handleDeleteKey(key.id)}
                        >
                          <Trash2 className="h-4 w-4 text-red-500" />
                        </Button>
                      </div>
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

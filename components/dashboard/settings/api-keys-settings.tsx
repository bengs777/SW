"use client"

import { useState, useEffect } from "react"
import { Copy, Trash2, Plus, Eye, EyeOff, Check } from "lucide-react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Spinner } from "@/components/ui/spinner"
import { Badge } from "@/components/ui/badge"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field"
import { formatDistanceToNow } from "date-fns"

interface ApiKey {
  id: string
  name: string
  key: string
  createdAt: string
  lastUsedAt?: string | null
}

export function ApiKeysSettings() {
  const [apiKeys, setApiKeys] = useState<ApiKey[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState("")
  const [visibleKeys, setVisibleKeys] = useState<Set<string>>(new Set())
  const [copiedKey, setCopiedKey] = useState<string | null>(null)
  const [isCreating, setIsCreating] = useState(false)
  const [showCreateDialog, setShowCreateDialog] = useState(false)
  const [newKeyName, setNewKeyName] = useState("")
  const [createdKey, setCreatedKey] = useState<string | null>(null)

  useEffect(() => {
    fetchApiKeys()
  }, [])

  const fetchApiKeys = async () => {
    setIsLoading(true)
    setError("")

    try {
      const response = await fetch("/api/api-keys")
      const data = await response.json().catch(() => ({}))

      if (!response.ok) {
        setError(data.error || "Failed to load API keys")
        setApiKeys([])
        return
      }

      setApiKeys(data.keys || [])
    } catch (err) {
      console.error("[v0] Failed to fetch API keys:", err)
      setError("Unable to load API keys right now.")
      setApiKeys([])
    } finally {
      setIsLoading(false)
    }
  }

  const handleCreateKey = async () => {
    if (!newKeyName.trim() || isCreating) return // Guard against re-entry

    setIsCreating(true)
    setError("")

    try {
      const response = await fetch("/api/api-keys", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ name: newKeyName.trim() }),
      })

      const data = await response.json().catch(() => ({}))

      if (!response.ok) {
        setError(data.error || "Failed to create API key")
        return
      }

      setCreatedKey(data.key)
      setNewKeyName("")
      await fetchApiKeys()
    } catch (err) {
      console.error("[v0] Failed to create API key:", err)
      setError("Unable to create API key right now.")
    } finally {
      setIsCreating(false)
    }
  }

  const handleDeleteKey = async (keyId: string) => {
    if (!confirm("Are you sure you want to delete this API key? This action cannot be undone.")) {
      return
    }

    try {
      const response = await fetch(`/api/api-keys/${keyId}`, {
        method: "DELETE",
      })

      if (!response.ok) {
        setError("Failed to delete API key")
        return
      }

      setApiKeys((prev) => prev.filter((k) => k.id !== keyId))
    } catch (err) {
      console.error("[v0] Failed to delete API key:", err)
      setError("Unable to delete API key right now.")
    }
  }

  const toggleKeyVisibility = (keyId: string) => {
    setVisibleKeys((prev) => {
      const next = new Set(prev)
      if (next.has(keyId)) {
        next.delete(keyId)
      } else {
        next.add(keyId)
      }
      return next
    })
  }

  const handleCopyKey = (key: string) => {
    navigator.clipboard.writeText(key)
    setCopiedKey(key)
    setTimeout(() => setCopiedKey(null), 2000)
  }

  if (isLoading) {
    return (
      <Card>
        <CardContent className="flex items-center justify-center py-12">
          <Spinner className="mr-2" />
          Loading API keys...
        </CardContent>
      </Card>
    )
  }

  return (
    <div className="space-y-6">
      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      {createdKey && (
        <Alert className="border-green-500/30 bg-green-500/5">
          <AlertDescription className="text-green-700 dark:text-green-400">
            <p className="font-semibold mb-2">API Key Created Successfully</p>
            <p className="text-sm mb-3">Make sure to copy and save this key in a secure place. You won't be able to see it again.</p>
            <div className="flex gap-2 items-center bg-background/50 p-3 rounded-lg">
              <code className="text-xs font-mono flex-1 truncate">{createdKey}</code>
              <Button
                variant="outline"
                size="sm"
                onClick={() => handleCopyKey(createdKey)}
              >
                {copiedKey === createdKey ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
              </Button>
            </div>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setCreatedKey(null)}
              className="mt-3"
            >
              Got it
            </Button>
          </AlertDescription>
        </Alert>
      )}

      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <div>
            <CardTitle>API Keys</CardTitle>
            <CardDescription>Manage your API keys for programmatic access.</CardDescription>
          </div>
          <Button onClick={() => setShowCreateDialog(true)} className="gap-2 rounded-full">
            <Plus className="h-4 w-4" />
            New Key
          </Button>
        </CardHeader>
        <CardContent>
          {apiKeys.length === 0 ? (
            <div className="text-center py-12">
              <p className="text-muted-foreground">No API keys yet. Create one to get started.</p>
            </div>
          ) : (
            <div className="space-y-3">
              {apiKeys.map((apiKey) => (
                <div
                  key={apiKey.id}
                  className="flex items-center justify-between gap-4 rounded-lg border border-border/70 bg-card/50 p-4"
                >
                  <div className="flex-1 min-w-0">
                    <p className="font-medium">{apiKey.name}</p>
                    <div className="flex items-center gap-2 mt-1">
                      <Badge variant="secondary" className="rounded-full text-xs">
                        {visibleKeys.has(apiKey.id) ? apiKey.key : "••••••••••••••••"}
                      </Badge>
                      {apiKey.lastUsedAt && (
                        <span className="text-xs text-muted-foreground">
                          Used {formatDistanceToNow(new Date(apiKey.lastUsedAt), { addSuffix: true })}
                        </span>
                      )}
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => toggleKeyVisibility(apiKey.id)}
                      className="h-9 w-9"
                    >
                      {visibleKeys.has(apiKey.id) ? (
                        <EyeOff className="h-4 w-4" />
                      ) : (
                        <Eye className="h-4 w-4" />
                      )}
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => handleCopyKey(apiKey.key)}
                      className="h-9 w-9"
                    >
                      {copiedKey === apiKey.key ? (
                        <Check className="h-4 w-4 text-green-500" />
                      ) : (
                        <Copy className="h-4 w-4" />
                      )}
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => handleDeleteKey(apiKey.id)}
                      className="h-9 w-9 text-destructive hover:bg-destructive/10"
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Create API Key Dialog */}
      <Dialog open={showCreateDialog} onOpenChange={setShowCreateDialog}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Create API Key</DialogTitle>
            <DialogDescription>
              Create a new API key for programmatic access to your account.
            </DialogDescription>
          </DialogHeader>
          <FieldGroup className="py-4">
            <Field>
              <FieldLabel>Key Name</FieldLabel>
              <Input
                placeholder="e.g., Production API Key"
                value={newKeyName}
                onChange={(e) => setNewKeyName(e.target.value)}
              />
              <p className="mt-1 text-xs text-muted-foreground">
                Give your key a descriptive name to identify its purpose.
              </p>
            </Field>
          </FieldGroup>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setShowCreateDialog(false)}
              disabled={isCreating}
            >
              Cancel
            </Button>
            <Button
              onClick={handleCreateKey}
              disabled={!newKeyName.trim() || isCreating}
            >
              {isCreating ? (
                <>
                  <Spinner className="mr-2" />
                  Creating...
                </>
              ) : (
                "Create Key"
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

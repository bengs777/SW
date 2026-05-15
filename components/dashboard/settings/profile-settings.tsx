"use client"

import { useState, useEffect } from "react"
import { useSession } from "next-auth/react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Spinner } from "@/components/ui/spinner"
import { Avatar, AvatarImage, AvatarFallback } from "@/components/ui/avatar"

export function ProfileSettings() {
  const { data: session } = useSession()
  const [isLoading, setIsLoading] = useState(false)
  const [isSaved, setIsSaved] = useState(false)
  const [error, setError] = useState("")
  const [formData, setFormData] = useState({
    name: session?.user?.name || "",
    email: session?.user?.email || "",
  })

  useEffect(() => {
    if (session?.user) {
      setFormData({
        name: session.user.name || "",
        email: session.user.email || "",
      })
    }
  }, [session])

  const handleSave = async () => {
    if (isLoading) return // Guard against re-entry
    setIsLoading(true)
    setError("")
    setIsSaved(false)

    try {
      const response = await fetch("/api/user/profile", {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(formData),
      })

      const data = await response.json().catch(() => ({}))

      if (!response.ok) {
        setError(data.error || "Failed to update profile")
        return
      }

      setIsSaved(true)
      setTimeout(() => setIsSaved(false), 3000)
    } catch (err) {
      console.error("[v0] Failed to update profile:", err)
      setError("Unable to update profile right now. Please try again.")
    } finally {
      setIsLoading(false)
    }
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

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>Profile Information</CardTitle>
          <CardDescription>Update your personal information and profile settings.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          {/* Avatar */}
          <div className="flex items-center gap-6">
            <Avatar className="h-16 w-16">
              <AvatarImage src={session?.user?.image || ""} />
              <AvatarFallback>{getInitials(session?.user?.name)}</AvatarFallback>
            </Avatar>
            <div>
              <h3 className="font-semibold">{session?.user?.name || "User"}</h3>
              <p className="text-sm text-muted-foreground">{session?.user?.email}</p>
            </div>
          </div>

          {/* Form */}
          <FieldGroup>
            <Field>
              <FieldLabel>Full Name</FieldLabel>
              <Input
                value={formData.name}
                onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                placeholder="Your full name"
              />
            </Field>
            <Field>
              <FieldLabel>Email Address</FieldLabel>
              <Input
                type="email"
                value={formData.email}
                disabled
                placeholder="your@email.com"
              />
              <p className="mt-1 text-xs text-muted-foreground">Your email is managed by your Google account.</p>
            </Field>
          </FieldGroup>

          {error && (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}

          {isSaved && (
            <Alert className="border-green-500/30 bg-green-500/5">
              <AlertDescription className="text-green-700 dark:text-green-400">
                Profile updated successfully!
              </AlertDescription>
            </Alert>
          )}

          <div className="flex justify-end pt-4">
            <Button onClick={handleSave} disabled={isLoading}>
              {isLoading ? (
                <>
                  <Spinner className="mr-2" />
                  Saving...
                </>
              ) : (
                "Save Changes"
              )}
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* Account Information */}
      <Card>
        <CardHeader>
          <CardTitle>Account Information</CardTitle>
          <CardDescription>View your account details and status.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-4 md:grid-cols-2">
            <div>
              <p className="text-sm text-muted-foreground">Account Type</p>
              <p className="font-semibold">Standard User</p>
            </div>
            <div>
              <p className="text-sm text-muted-foreground">Account Created</p>
              <p className="font-semibold">
                {session?.user?.email ? "Google OAuth" : "N/A"}
              </p>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}

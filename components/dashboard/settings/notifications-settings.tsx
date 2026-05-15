"use client"

import { useState } from "react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Switch } from "@/components/ui/switch"
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Button } from "@/components/ui/button"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Bell, Mail, MessageSquare, AlertTriangle } from "lucide-react"
import { Separator } from "@/components/ui/separator"

interface NotificationSettings {
  emailNotifications: boolean
  generationUpdates: boolean
  billingAlerts: boolean
  weeklyDigest: boolean
  newFeatures: boolean
  securityAlerts: boolean
}

export function NotificationsSettings() {
  const [settings, setSettings] = useState<NotificationSettings>({
    emailNotifications: true,
    generationUpdates: true,
    billingAlerts: true,
    weeklyDigest: false,
    newFeatures: false,
    securityAlerts: true,
  })
  const [isSaving, setIsSaving] = useState(false)
  const [isSaved, setIsSaved] = useState(false)

  const handleToggle = (key: keyof NotificationSettings) => {
    setSettings((prev) => ({
      ...prev,
      [key]: !prev[key],
    }))
  }

  const handleSave = async () => {
    if (isSaving) return // Guard against re-entry
    setIsSaving(true)
    setIsSaved(false)

    try {
      // Save notification preferences
      await new Promise((resolve) => setTimeout(resolve, 500))
      setIsSaved(true)
      setTimeout(() => setIsSaved(false), 3000)
    } catch (err) {
      console.error("[v0] Failed to save notification settings:", err)
    } finally {
      setIsSaving(false)
    }
  }

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Bell className="h-5 w-5" />
            Email Notifications
          </CardTitle>
          <CardDescription>
            Manage how and when you receive email notifications about your account and projects.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          <FieldGroup>
            <div className="space-y-4">
              {/* Email Notifications Master Toggle */}
              <div className="flex items-center justify-between rounded-lg border border-border/70 bg-card/50 p-4">
                <div className="flex items-center gap-3">
                  <Mail className="h-5 w-5 text-muted-foreground" />
                  <div>
                    <p className="font-medium">Email Notifications</p>
                    <p className="text-sm text-muted-foreground">Receive email notifications</p>
                  </div>
                </div>
                <Switch
                  checked={settings.emailNotifications}
                  onCheckedChange={() => handleToggle("emailNotifications")}
                />
              </div>

              {settings.emailNotifications && (
                <>
                  <Separator />

                  {/* Generation Updates */}
                  <div className="flex items-center justify-between">
                    <div>
                      <p className="font-medium">Generation Updates</p>
                      <p className="text-sm text-muted-foreground">
                        Get notified when your projects finish generating or encounter errors.
                      </p>
                    </div>
                    <Switch
                      checked={settings.generationUpdates}
                      onCheckedChange={() => handleToggle("generationUpdates")}
                    />
                  </div>

                  {/* Billing Alerts */}
                  <div className="flex items-center justify-between">
                    <div>
                      <p className="font-medium">Billing Alerts</p>
                      <p className="text-sm text-muted-foreground">
                        Receive alerts when your balance is low or top-ups are processed.
                      </p>
                    </div>
                    <Switch
                      checked={settings.billingAlerts}
                      onCheckedChange={() => handleToggle("billingAlerts")}
                    />
                  </div>

                  {/* Weekly Digest */}
                  <div className="flex items-center justify-between">
                    <div>
                      <p className="font-medium">Weekly Digest</p>
                      <p className="text-sm text-muted-foreground">
                        Get a summary of your activity and usage every week.
                      </p>
                    </div>
                    <Switch
                      checked={settings.weeklyDigest}
                      onCheckedChange={() => handleToggle("weeklyDigest")}
                    />
                  </div>

                  {/* New Features */}
                  <div className="flex items-center justify-between">
                    <div>
                      <p className="font-medium">New Features</p>
                      <p className="text-sm text-muted-foreground">
                        Be the first to know about new features and improvements.
                      </p>
                    </div>
                    <Switch
                      checked={settings.newFeatures}
                      onCheckedChange={() => handleToggle("newFeatures")}
                    />
                  </div>

                  {/* Security Alerts */}
                  <div className="flex items-center justify-between">
                    <div className="flex gap-2 items-start">
                      <AlertTriangle className="h-5 w-5 text-red-500 shrink-0 mt-0.5" />
                      <div>
                        <p className="font-medium">Security Alerts</p>
                        <p className="text-sm text-muted-foreground">
                          Critical security notifications (always enabled).
                        </p>
                      </div>
                    </div>
                    <Switch
                      checked={settings.securityAlerts}
                      disabled
                      aria-label="Security alerts cannot be disabled"
                    />
                  </div>
                </>
              )}
            </div>
          </FieldGroup>

          {isSaved && (
            <Alert className="border-green-500/30 bg-green-500/5">
              <AlertDescription className="text-green-700 dark:text-green-400">
                Notification settings saved successfully!
              </AlertDescription>
            </Alert>
          )}

          <div className="flex justify-end pt-4">
            <Button onClick={handleSave} disabled={isSaving}>
              {isSaving ? "Saving..." : "Save Preferences"}
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* Notification Center Info */}
      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Notification Center</CardTitle>
          <CardDescription>
            View all your notifications in one place (coming soon).
          </CardDescription>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">
            The notification center will keep you updated on all important events related to your account,
            projects, and billing.
          </p>
        </CardContent>
      </Card>
    </div>
  )
}

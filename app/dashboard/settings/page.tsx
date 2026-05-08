"use client"

import { useEffect, useState } from "react"
import { useSearchParams } from "next/navigation"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { Switch } from "@/components/ui/switch"
import { Separator } from "@/components/ui/separator"
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Badge } from "@/components/ui/badge"
import { User, Key, Bell, Palette, CreditCard, Shield } from "lucide-react"
import { BillingPanel } from "@/components/dashboard/billing-panel"

export default function SettingsPage() {
  const searchParams = useSearchParams()
  const [notifications, setNotifications] = useState({
    email: true,
    push: false,
    marketing: false,
  })
  const [activeTab, setActiveTab] = useState(() => {
    const tab = searchParams.get("tab")
    return tab === "profile" || tab === "api" || tab === "notifications" || tab === "appearance" || tab === "billing"
      ? tab
      : "profile"
  })

  useEffect(() => {
    const tab = searchParams.get("tab")
    if (tab === "profile" || tab === "api" || tab === "notifications" || tab === "appearance" || tab === "billing") {
      setActiveTab(tab)
    }
  }, [searchParams])

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <div className="border-b border-border px-6 py-4">
        <h1 className="text-xl font-semibold text-foreground">Settings</h1>
        <p className="text-sm text-muted-foreground">
          Manage your account and application preferences
        </p>
      </div>

      <div className="flex-1 overflow-auto">
        <Tabs value={activeTab} onValueChange={setActiveTab} className="p-6">
          <TabsList className="mb-6">
            <TabsTrigger value="profile" className="gap-2">
              <User className="h-4 w-4" />
              Profile
            </TabsTrigger>
            <TabsTrigger value="api" className="gap-2">
              <Key className="h-4 w-4" />
              API Keys
            </TabsTrigger>
            <TabsTrigger value="notifications" className="gap-2">
              <Bell className="h-4 w-4" />
              Notifications
            </TabsTrigger>
            <TabsTrigger value="appearance" className="gap-2">
              <Palette className="h-4 w-4" />
              Appearance
            </TabsTrigger>
            <TabsTrigger value="billing" className="gap-2">
              <CreditCard className="h-4 w-4" />
              Billing
            </TabsTrigger>
          </TabsList>

          <TabsContent value="profile">
            <Card>
              <CardHeader>
                <CardTitle>Profile Information</CardTitle>
                <CardDescription>
                  Update your personal information and profile settings
                </CardDescription>
              </CardHeader>
              <CardContent>
                <FieldGroup>
                  <Field>
                    <FieldLabel>Name</FieldLabel>
                    <Input placeholder="Your name" defaultValue="User" />
                  </Field>
                  <Field>
                    <FieldLabel>Email</FieldLabel>
                    <Input type="email" placeholder="your@email.com" defaultValue="user@example.com" />
                  </Field>
                  <Field>
                    <FieldLabel>Bio</FieldLabel>
                    <Textarea placeholder="Tell us about yourself..." rows={3} />
                  </Field>
                </FieldGroup>
                <div className="mt-6">
                  <Button>Save Changes</Button>
                </div>
              </CardContent>
            </Card>

            <Card className="mt-6">
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-destructive">
                  <Shield className="h-5 w-5" />
                  Danger Zone
                </CardTitle>
                <CardDescription>
                  Irreversible actions for your account
                </CardDescription>
              </CardHeader>
              <CardContent>
                <div className="flex items-center justify-between rounded-lg border border-destructive/20 p-4">
                  <div>
                    <h4 className="font-medium text-foreground">Delete Account</h4>
                    <p className="text-sm text-muted-foreground">
                      Permanently delete your account and all data
                    </p>
                  </div>
                  <Button variant="destructive" size="sm">
                    Delete Account
                  </Button>
                </div>
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="api">
            <Card>
              <CardHeader>
                <CardTitle>API Keys</CardTitle>
                <CardDescription>
                  Manage your API keys for programmatic access
                </CardDescription>
              </CardHeader>
              <CardContent>
                <FieldGroup>
                  <Field>
                    <FieldLabel>OpenRouter API Key</FieldLabel>
                    <div className="flex gap-2">
                      <Input 
                        type="password" 
                        placeholder="sk-..." 
                        className="font-mono"
                      />
                      <Button variant="outline">Save</Button>
                    </div>
                    <p className="mt-1 text-xs text-muted-foreground">
                      Your OpenRouter API key for AI generation. Get one at{" "}
                      <a href="https://openrouter.ai/settings/keys" className="text-foreground underline" target="_blank" rel="noopener noreferrer">
                        openrouter.ai/settings/keys
                      </a>
                    </p>
                  </Field>
                </FieldGroup>

                <Separator className="my-6" />

                <div>
                  <h4 className="mb-4 font-medium text-foreground">Your API Keys</h4>
                  <div className="rounded-lg border border-border p-4 text-center text-sm text-muted-foreground">
                    No API keys created yet
                  </div>
                  <Button className="mt-4" variant="outline">
                    Create New API Key
                  </Button>
                </div>
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="notifications">
            <Card>
              <CardHeader>
                <CardTitle>Notification Preferences</CardTitle>
                <CardDescription>
                  Choose how you want to be notified
                </CardDescription>
              </CardHeader>
              <CardContent>
                <div className="space-y-6">
                  <div className="flex items-center justify-between">
                    <div>
                      <h4 className="font-medium text-foreground">Email Notifications</h4>
                      <p className="text-sm text-muted-foreground">
                        Receive updates about your projects via email
                      </p>
                    </div>
                    <Switch
                      checked={notifications.email}
                      onCheckedChange={(checked) =>
                        setNotifications({ ...notifications, email: checked })
                      }
                    />
                  </div>
                  <Separator />
                  <div className="flex items-center justify-between">
                    <div>
                      <h4 className="font-medium text-foreground">Push Notifications</h4>
                      <p className="text-sm text-muted-foreground">
                        Receive push notifications in your browser
                      </p>
                    </div>
                    <Switch
                      checked={notifications.push}
                      onCheckedChange={(checked) =>
                        setNotifications({ ...notifications, push: checked })
                      }
                    />
                  </div>
                  <Separator />
                  <div className="flex items-center justify-between">
                    <div>
                      <h4 className="font-medium text-foreground">Marketing Emails</h4>
                      <p className="text-sm text-muted-foreground">
                        Receive news, updates, and promotional content
                      </p>
                    </div>
                    <Switch
                      checked={notifications.marketing}
                      onCheckedChange={(checked) =>
                        setNotifications({ ...notifications, marketing: checked })
                      }
                    />
                  </div>
                </div>
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="appearance">
            <Card>
              <CardHeader>
                <CardTitle>Appearance</CardTitle>
                <CardDescription>
                  Customize how Swift looks for you
                </CardDescription>
              </CardHeader>
              <CardContent>
                <div className="space-y-6">
                  <div>
                    <h4 className="mb-3 font-medium text-foreground">Theme</h4>
                    <div className="grid grid-cols-3 gap-4">
                      <button className="rounded-lg border-2 border-primary p-4 text-center">
                        <div className="mb-2 h-8 w-full rounded bg-foreground" />
                        <span className="text-sm">Dark</span>
                      </button>
                      <button className="rounded-lg border border-border p-4 text-center opacity-50">
                        <div className="mb-2 h-8 w-full rounded bg-muted" />
                        <span className="text-sm">Light</span>
                      </button>
                      <button className="rounded-lg border border-border p-4 text-center opacity-50">
                        <div className="mb-2 flex h-8 w-full overflow-hidden rounded">
                          <div className="flex-1 bg-foreground" />
                          <div className="flex-1 bg-muted" />
                        </div>
                        <span className="text-sm">System</span>
                      </button>
                    </div>
                    <p className="mt-2 text-xs text-muted-foreground">
                      Light and system themes coming soon
                    </p>
                  </div>
                </div>
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="billing">
            <BillingPanel />
          </TabsContent>
        </Tabs>
      </div>
    </div>
  )
}

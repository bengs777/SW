"use client"

import { useState } from "react"
import { User, Key, CreditCard, Palette, Bell } from "lucide-react"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { ProfileSettings } from "@/components/dashboard/settings/profile-settings"
import { ApiKeysSettings } from "@/components/dashboard/settings/api-keys-settings"
import { BillingSettings } from "@/components/dashboard/settings/billing-settings"
import { AppearanceSettings } from "@/components/dashboard/settings/appearance-settings"
import { NotificationsSettings } from "@/components/dashboard/settings/notifications-settings"

export default function SettingsPage() {
  const [activeTab, setActiveTab] = useState("profile")

  return (
    <div className="flex min-h-screen flex-col gap-6">
      {/* Header */}
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Settings</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Manage your account preferences and workspace configuration.
        </p>
      </div>

      {/* Settings Tabs */}
      <Tabs value={activeTab} onValueChange={setActiveTab} className="w-full">
        <TabsList className="grid w-full grid-cols-2 rounded-lg md:grid-cols-5 md:w-auto">
          <TabsTrigger value="profile" className="gap-2">
            <User className="h-4 w-4" />
            <span className="hidden sm:inline">Profile</span>
          </TabsTrigger>
          <TabsTrigger value="api-keys" className="gap-2">
            <Key className="h-4 w-4" />
            <span className="hidden sm:inline">API Keys</span>
          </TabsTrigger>
          <TabsTrigger value="billing" className="gap-2">
            <CreditCard className="h-4 w-4" />
            <span className="hidden sm:inline">Billing</span>
          </TabsTrigger>
          <TabsTrigger value="appearance" className="gap-2">
            <Palette className="h-4 w-4" />
            <span className="hidden sm:inline">Appearance</span>
          </TabsTrigger>
          <TabsTrigger value="notifications" className="gap-2">
            <Bell className="h-4 w-4" />
            <span className="hidden sm:inline">Notifications</span>
          </TabsTrigger>
        </TabsList>

        {/* Profile Settings */}
        <TabsContent value="profile" className="mt-6">
          <ProfileSettings />
        </TabsContent>

        {/* API Keys Settings */}
        <TabsContent value="api-keys" className="mt-6">
          <ApiKeysSettings />
        </TabsContent>

        {/* Billing Settings */}
        <TabsContent value="billing" className="mt-6">
          <BillingSettings />
        </TabsContent>

        {/* Appearance Settings */}
        <TabsContent value="appearance" className="mt-6">
          <AppearanceSettings />
        </TabsContent>

        {/* Notifications Settings */}
        <TabsContent value="notifications" className="mt-6">
          <NotificationsSettings />
        </TabsContent>
      </Tabs>
    </div>
  )
}

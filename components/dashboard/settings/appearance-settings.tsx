"use client"

import { useState, useEffect } from "react"
import { useTheme } from "next-themes"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Sun, Moon, Monitor } from "lucide-react"

type Theme = "light" | "dark" | "system"

export function AppearanceSettings() {
  const { theme, setTheme } = useTheme()
  const [mounted, setMounted] = useState(false)

  useEffect(() => {
    setMounted(true)
  }, [])

  if (!mounted) {
    return null
  }

  const currentTheme = (theme as Theme) || "system"
  const themes: Array<{ value: Theme; label: string; icon: React.ComponentType<{ className?: string }> }> = [
    { value: "light", label: "Light", icon: Sun },
    { value: "dark", label: "Dark", icon: Moon },
    { value: "system", label: "System", icon: Monitor },
  ]

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>Theme</CardTitle>
          <CardDescription>Choose how the interface should look.</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid gap-4 md:grid-cols-3">
            {themes.map(({ value, label, icon: Icon }) => (
              <Button
                key={value}
                variant={currentTheme === value ? "default" : "outline"}
                onClick={() => setTheme(value)}
                className="h-auto flex-col gap-3 py-6"
              >
                <Icon className="h-6 w-6" />
                <span>{label}</span>
              </Button>
            ))}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Preferences</CardTitle>
          <CardDescription>Customize your interface experience.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <p className="font-medium">Compact Mode</p>
              <p className="text-sm text-muted-foreground">Reduce spacing for a compact layout.</p>
            </div>
            <Badge variant="secondary" className="rounded-full">
              Coming Soon
            </Badge>
          </div>
          <div className="border-t border-border/70 pt-4">
            <p className="font-medium">Animations</p>
            <p className="text-sm text-muted-foreground">Enable smooth transitions and animations.</p>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Preview</CardTitle>
          <CardDescription>See how your theme looks with sample components.</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="space-y-4">
            <div className="rounded-lg border border-border/70 bg-card/50 p-4">
              <p className="font-semibold">Sample Card</p>
              <p className="text-sm text-muted-foreground mt-2">
                This is how your selected theme will appear across the application.
              </p>
            </div>
            <div className="flex gap-2">
              <Button size="sm">Primary Button</Button>
              <Button variant="outline" size="sm">
                Secondary Button
              </Button>
              <Button variant="ghost" size="sm">
                Ghost Button
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}

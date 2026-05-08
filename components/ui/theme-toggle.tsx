"use client"

import { useEffect, useState } from "react"
import { Button } from "@/components/ui/button"
import { Sun, Moon, Monitor } from "lucide-react"

type ThemeSetting = "system" | "light" | "dark"

const THEME_STORAGE_KEY = "swift-theme"

const getAppliedTheme = (theme: ThemeSetting) => {
  if (theme !== "system") {
    return theme
  }

  if (typeof window === "undefined") {
    return "light"
  }

  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"
}

const applyTheme = (theme: ThemeSetting) => {
  if (typeof document === "undefined") {
    return
  }

  const appliedTheme = getAppliedTheme(theme)
  document.documentElement.classList.toggle("light", appliedTheme === "light")
  document.documentElement.classList.toggle("dark", appliedTheme === "dark")
  document.documentElement.style.colorScheme = appliedTheme
}

export function ThemeToggle() {
  const [theme, setTheme] = useState<ThemeSetting>("system")
  const [mounted, setMounted] = useState(false)

  useEffect(() => {
    const storedTheme = window.localStorage.getItem(THEME_STORAGE_KEY)
    if (storedTheme === "light" || storedTheme === "dark" || storedTheme === "system") {
      setTheme(storedTheme)
      applyTheme(storedTheme)
    } else {
      applyTheme("system")
    }

    const mediaQuery = window.matchMedia("(prefers-color-scheme: dark)")
    const handleChange = () => {
      if ((window.localStorage.getItem(THEME_STORAGE_KEY) || "system") === "system") {
        applyTheme("system")
      }
    }

    mediaQuery.addEventListener("change", handleChange)
    setMounted(true)

    return () => mediaQuery.removeEventListener("change", handleChange)
  }, [])

  useEffect(() => {
    if (!mounted) {
      return
    }

    window.localStorage.setItem(THEME_STORAGE_KEY, theme)
    applyTheme(theme)
  }, [mounted, theme])

  if (!mounted) {
    return (
      <Button variant="ghost" size="icon" aria-label="Toggle theme">
        <Monitor className="h-4 w-4" />
      </Button>
    )
  }

  const current: ThemeSetting = theme || "system"
  const order: ThemeSetting[] = ["system", "light", "dark"]
  const idx = order.indexOf(current)
  const next = order[(idx + 1) % order.length]

  const icon =
    getAppliedTheme(current) === "light" ? (
      <Sun className="h-4 w-4" />
    ) : getAppliedTheme(current) === "dark" ? (
      <Moon className="h-4 w-4" />
    ) : (
      <Monitor className="h-4 w-4" />
    )

  return (
    <Button
      variant="ghost"
      size="icon"
      aria-label={`Theme: ${current}. Click to switch to ${next}`}
      onClick={() => setTheme(next)}
    >
      {icon}
    </Button>
  )
}

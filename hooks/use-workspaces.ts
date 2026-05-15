"use client"

import { useEffect, useState } from "react"

interface Workspace {
  id: string
  name: string
  slug: string
  image?: string | null
}

export function useWorkspaces() {
  const [workspaces, setWorkspaces] = useState<Workspace[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState("")

  useEffect(() => {
    const fetchWorkspaces = async () => {
      setIsLoading(true)
      setError("")

      try {
        const response = await fetch("/api/workspaces")
        const data = await response.json().catch(() => [])

        if (!response.ok) {
          setError("Failed to load workspaces")
          setWorkspaces([])
          return
        }

        setWorkspaces(Array.isArray(data) ? data : [])
      } catch (fetchError) {
        console.error("[v0] Failed to fetch workspaces:", fetchError)
        setError("Unable to load workspaces right now.")
        setWorkspaces([])
      } finally {
        setIsLoading(false)
      }
    }

    fetchWorkspaces()
  }, [])

  return { workspaces, isLoading, error }
}

"use client"

import { useEffect, useRef, useState } from "react"
import { useSession } from "next-auth/react"

interface Workspace {
  id: string
  name: string
  slug: string
  image?: string | null
}

type WorkspaceApiItem = Partial<Workspace> & {
  workspace?: Partial<Workspace> | null
}

function normalizeWorkspace(item: unknown): Workspace | null {
  if (!item || typeof item !== "object") {
    return null
  }

  const apiItem = item as WorkspaceApiItem
  const workspace = apiItem.workspace && typeof apiItem.workspace === "object"
    ? apiItem.workspace
    : apiItem

  if (
    typeof workspace.id !== "string" ||
    typeof workspace.name !== "string" ||
    typeof workspace.slug !== "string"
  ) {
    return null
  }

  return {
    id: workspace.id,
    name: workspace.name,
    slug: workspace.slug,
    image: workspace.image ?? null,
  }
}

export function useWorkspaces() {
  const { status: sessionStatus } = useSession()
  const [workspaces, setWorkspaces] = useState<Workspace[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState("")
  const abortControllerRef = useRef<AbortController | null>(null)

  useEffect(() => {
    // Delay fetch until session is fully authenticated
    if (sessionStatus !== "authenticated") {
      setIsLoading(true)
      return
    }

    const controller = new AbortController()
    abortControllerRef.current = controller

    const fetchWorkspaces = async () => {
      setIsLoading(true)
      setError("")

      try {
        const response = await fetch("/api/workspaces", {
          signal: controller.signal,
        })

        if (controller.signal.aborted) return

        const data = await response.json().catch(() => [])

        if (!response.ok) {
          setError("Failed to load workspaces")
          setWorkspaces([])
          return
        }

        const nextWorkspaces = Array.isArray(data)
          ? data
              .map((item) => normalizeWorkspace(item))
              .filter((workspace): workspace is Workspace => Boolean(workspace))
          : []

        setWorkspaces(nextWorkspaces)
      } catch (fetchError) {
        if (fetchError instanceof DOMException && fetchError.name === "AbortError") return
        console.error("[workspaces] Failed to fetch workspaces:", fetchError)
        setError("Unable to load workspaces right now.")
        setWorkspaces([])
      } finally {
        if (!controller.signal.aborted) {
          setIsLoading(false)
        }
      }
    }

    fetchWorkspaces()

    return () => {
      controller.abort()
      abortControllerRef.current = null
    }
  }, [sessionStatus])

  return { workspaces, isLoading, error }
}

"use client"

import { useCallback, useEffect, useMemo, useState } from "react"
import { AlertCircle, RefreshCw, TerminalSquare } from "lucide-react"
import type { GeneratedFile } from "@/lib/types"

type SandboxStatus = {
  status: "idle" | "installing" | "building" | "running" | "error"
  previewUrl: string | null
  logs: string[]
  error: string | null
}

interface SandboxPreviewProps {
  files: GeneratedFile[]
  className?: string
  onError?: (error: string) => void
  projectId?: string
}

export function SandboxPreview({ files, className = "", onError, projectId }: SandboxPreviewProps) {
  const [status, setStatus] = useState<SandboxStatus>({
    status: "idle",
    previewUrl: null,
    logs: [],
    error: null,
  })
  const [isBooting, setIsBooting] = useState(false)
  const [iframeKey, setIframeKey] = useState(0)

  const fileFingerprint = useMemo(() => {
    return files
      .map((file) => `${file.path}:${file.content.length}:${file.content.slice(0, 80)}`)
      .join("|")
  }, [files])

  const refreshStatus = useCallback(async () => {
    if (!projectId) return
    const response = await fetch(`/api/projects/${projectId}/sandbox`, { cache: "no-store" })
    if (!response.ok) return
    const data = (await response.json()) as SandboxStatus
    setStatus(data)
    if (data.error) onError?.(data.error)
  }, [onError, projectId])

  const startRuntime = useCallback(async () => {
    if (!projectId || files.length === 0) {
      return
    }

    setIsBooting(true)
    setStatus((current) => ({
      ...current,
      status: current.status === "idle" ? "installing" : current.status,
      error: null,
    }))

    try {
      const response = await fetch(`/api/projects/${projectId}/sandbox`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ files }),
      })
      const data = (await response.json().catch(() => ({}))) as Partial<SandboxStatus> & { error?: string }

      setStatus({
        status: data.status || (response.ok ? "running" : "error"),
        previewUrl: data.previewUrl || null,
        logs: Array.isArray(data.logs) ? data.logs : [],
        error: data.error || null,
      })

      if (!response.ok || data.error) {
        onError?.(data.error || `Runtime sandbox failed (${response.status})`)
      } else {
        setIframeKey((current) => current + 1)
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to start runtime sandbox"
      setStatus((current) => ({ ...current, status: "error", error: message }))
      onError?.(message)
    } finally {
      setIsBooting(false)
    }
  }, [files, onError, projectId])

  useEffect(() => {
    void startRuntime()
  }, [fileFingerprint, startRuntime])

  useEffect(() => {
    if (!projectId) return
    const interval = window.setInterval(() => {
      void refreshStatus()
    }, status.status === "running" ? 5000 : 1500)

    return () => window.clearInterval(interval)
  }, [projectId, refreshStatus, status.status])

  if (!projectId) {
    return (
      <div className={`flex h-full w-full items-center justify-center bg-background p-6 text-center ${className}`}>
        <div className="max-w-sm text-sm text-muted-foreground">
          Runtime preview needs a project id before it can start the sandbox.
        </div>
      </div>
    )
  }

  const showOverlay = isBooting || status.status === "installing" || status.status === "building" || !status.previewUrl
  const latestLogs = status.logs.slice(-10)

  return (
    <div className={`relative h-full w-full bg-background ${className}`}>
      {status.previewUrl && (
        <iframe
          key={iframeKey}
          className="h-full w-full border-0 bg-background"
          title="Live runtime preview"
          src={status.previewUrl}
          sandbox="allow-forms allow-modals allow-popups allow-same-origin allow-scripts"
        />
      )}

      {showOverlay && (
        <div className="absolute inset-0 z-10 flex flex-col bg-background">
          <div className="flex items-center justify-between border-b border-border px-4 py-3">
            <div className="flex items-center gap-2 text-sm font-medium">
              <RefreshCw className="h-4 w-4 animate-spin text-sky-500" />
              {status.status === "building"
                ? "Running production build"
                : status.status === "installing"
                  ? "Installing dependencies"
                  : "Starting runtime sandbox"}
            </div>
            <button
              type="button"
              className="rounded-md border border-border px-2 py-1 text-xs text-muted-foreground hover:bg-muted"
              onClick={() => void startRuntime()}
            >
              Restart
            </button>
          </div>
          <RuntimeLogView logs={latestLogs} />
        </div>
      )}

      {status.error && (
        <div className="absolute bottom-3 left-3 right-3 z-20 rounded-md border border-destructive/30 bg-background/95 p-3 text-xs shadow-lg backdrop-blur">
          <div className="mb-2 flex items-center gap-2 font-medium text-destructive">
            <AlertCircle className="h-4 w-4" />
            Runtime preview error
          </div>
          <pre className="max-h-28 overflow-auto whitespace-pre-wrap text-muted-foreground">{status.error}</pre>
        </div>
      )}
    </div>
  )
}

function RuntimeLogView({ logs }: { logs: string[] }) {
  return (
    <div className="min-h-0 flex-1 bg-zinc-950 p-4 font-mono text-xs text-zinc-200">
      <div className="mb-3 flex items-center gap-2 text-zinc-400">
        <TerminalSquare className="h-4 w-4" />
        Terminal log
      </div>
      <div className="h-full overflow-auto whitespace-pre-wrap leading-relaxed">
        {logs.length > 0 ? logs.join("\n") : "Waiting for sandbox output..."}
      </div>
    </div>
  )
}

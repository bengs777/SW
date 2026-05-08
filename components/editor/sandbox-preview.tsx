"use client"

import { useEffect, useRef, useState, useMemo } from "react"
import { generateSandboxHtml, generateErrorPreview } from "@/lib/sandbox/engine"
import type { GeneratedFile } from "@/lib/types"

interface SandboxPreviewProps {
  files: GeneratedFile[]
  className?: string
  onError?: (error: string) => void
}

export function SandboxPreview({ files, className = "", onError }: SandboxPreviewProps) {
  const iframeRef = useRef<HTMLIFrameElement>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const formatError = (message: string, details?: { filename?: string; lineno?: number; colno?: number; source?: string; stack?: string | null }) => {
    const segments = [message]

    if (details?.filename) {
      const line = typeof details.lineno === "number" ? details.lineno : null
      const col = typeof details.colno === "number" ? details.colno : null
      const location = line != null ? `${details.filename}${line ? `:${line}` : ""}${col ? `:${col}` : ""}` : details.filename
      segments.push(`at ${location}`)
    }

    if (details?.source && details.source !== details.filename) {
      segments.push(`source: ${details.source}`)
    }

    if (details?.stack) {
      segments.push(details.stack)
    }

    return segments.join("\n")
  }

  // Generate HTML for preview
  const previewHtml = useMemo(() => {
    if (files.length === 0) {
      return generateSandboxHtml([])
    }
    
    try {
      return generateSandboxHtml(files)
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : "Unknown error"
      setError(errorMessage)
      onError?.(errorMessage)
      return generateErrorPreview(errorMessage)
    }
  }, [files, onError])

  useEffect(() => {
    setIsLoading(true)
    setError(null)

    const handleMessage = (ev: MessageEvent) => {
      try {
        const data = ev?.data
        if (!data || typeof data !== "object") return
        if (data.type === "swift-preview-error") {
          const msg = formatError(data.message || JSON.stringify(data), {
            filename: typeof data.filename === "string" ? data.filename : undefined,
            lineno: typeof data.lineno === "number" ? data.lineno : undefined,
            colno: typeof data.colno === "number" ? data.colno : undefined,
            source: typeof data.source === "string" ? data.source : undefined,
            stack: typeof data.stack === "string" ? data.stack : null,
          })
          setError(msg)
          onError?.(msg)
        }
      } catch (e) {
        // ignore malformed messages
      }
    }

    window.addEventListener("message", handleMessage)
    return () => window.removeEventListener("message", handleMessage)
  }, [previewHtml, onError])

  return (
    <div className={`relative h-full w-full ${className}`}>
      {isLoading && (
        <div className="absolute inset-0 z-10 flex items-center justify-center bg-background">
          <div className="flex flex-col items-center gap-2">
            <div className="h-6 w-6 animate-spin rounded-full border-2 border-muted-foreground border-t-transparent" />
            <span className="text-sm text-muted-foreground">Loading preview...</span>
          </div>
        </div>
      )}
      <iframe
        ref={iframeRef}
        className="h-full w-full border-0 bg-background"
        title="Preview"
        sandbox="allow-scripts"
        srcDoc={previewHtml}
        onLoad={() => setIsLoading(false)}
      />
    </div>
  )
}

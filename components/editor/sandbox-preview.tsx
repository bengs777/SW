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
  const [fallbackDoc, setFallbackDoc] = useState<string | null>(null)

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

      const previewUrl = data.previewUrl || null
      const error = data.error || null

      setStatus({
        status: data.status || (response.ok ? "running" : "error"),
        previewUrl,
        logs: Array.isArray(data.logs) ? data.logs : [],
        error,
      })

      if (!response.ok || error) {
        onError?.(error || `Runtime sandbox failed (${response.status})`)
        setFallbackDoc(buildFallbackSrcDoc(files))
      } else {
        setIframeKey((current) => current + 1)
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to start runtime sandbox"
      setStatus((current) => ({ ...current, status: "error", error: message }))
      setFallbackDoc(buildFallbackSrcDoc(files))
      onError?.(message)
    } finally {
      setIsBooting(false)
    }
  }, [files, onError, projectId])

  useEffect(() => {
    setFallbackDoc(null)
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

  const showOverlay = isBooting || status.status === "installing" || status.status === "building" || (!status.previewUrl && !fallbackDoc)
  const latestLogs = status.logs.slice(-10)

  return (
    <div className={`relative h-full w-full bg-background ${className}`}>
      {(status.previewUrl || fallbackDoc) && (
        <iframe
          key={`${iframeKey}-${fallbackDoc ? "fallback" : "live"}`}
          className="h-full w-full border-0 bg-background"
          title="Live runtime preview"
          src={status.previewUrl ?? undefined}
          srcDoc={fallbackDoc ?? undefined}
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

function buildFallbackSrcDoc(files: GeneratedFile[]) {
  const pageFile = files.find((file) => file.path.toLowerCase().replace(/\\\\/g, "/").endsWith("app/page.tsx"))
  if (pageFile?.content) {
    return buildTsxPreviewSrcDoc(pageFile.content)
  }

  const htmlFile = files.find((file) => file.path.toLowerCase().endsWith(".html"))
  if (htmlFile?.content) {
    return htmlFile.content
  }

  const fileSections = files.slice(0, 5).map((file) => {
    const content = escapeHtml(file.content)
    return `
      <section style="margin-bottom:24px;">
        <h2 style="font-size:18px;margin:0 0 8px 0;color:#111">${escapeHtml(file.path)}</h2>
        <pre style="background:#111;color:#f8f8f2;padding:12px;border-radius:8px;overflow:auto;max-height:240px;">${content}</pre>
      </section>`
  }).join("")

  return `<!DOCTYPE html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>Preview fallback</title>
    <style>
      body { margin:0; font-family:system-ui, sans-serif; background:#f5f7fb; color:#111; padding:24px; }
      h1 { margin:0 0 12px; font-size:24px; }
      p { margin:0 0 18px; color:#555; }
      pre { font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace; font-size:13px; }
    </style>
  </head>
  <body>
    <h1>Local preview fallback</h1>
    <p>Runtime sandbox is unavailable. Showing a local snapshot of your project files.</p>
    ${fileSections}
  </body>
</html>`
}

function buildTsxPreviewSrcDoc(tsxContent: string) {
  const serializedTsx = JSON.stringify(tsxContent)
  
  const head = `<!DOCTYPE html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Local TSX Preview</title>
    <link rel="stylesheet" href="data:text/css,body{margin:0;font-family:system-ui, sans-serif;background:#fff;color:#111;}#root{min-height:100vh;} .error{padding:24px;color:#a00;background:#fee;font-family:ui-monospace,monospace;}" />
    <script src="https://unpkg.com/react@18/umd/react.development.js"></script>
    <script src="https://unpkg.com/react-dom@18/umd/react-dom.development.js"></script>
    <script src="https://unpkg.com/@babel/standalone/babel.min.js"></script>
  </head>
  <body>
    <div id="root"></div>
    <div id="error" class="error" style="display:none;"></div>
    <script>`

  const script = `
      const rawCode = ${serializedTsx};
      const sanitizedCode = rawCode.replace(/\\n/g, "\\n").replace(/\\r/g, "\\r");
      const setupCode = sanitizedCode.replace(/import\\s+React.*from\\s+["']react["'];?/g, "").replace(/export\\s+default\\s+/g, "const __PreviewComponent = ").replace(/export\\s+const\\s+(\\w+)/g, "const $1 = ").replace(/export\\s+\\{([^}]+)\\}/g, "const {$1} = {};");
      try {
        const transformed = Babel.transform(setupCode, {
          presets: [["react", { runtime: "automatic" }], "typescript"],
          sourceType: "script",
        }).code;
        const fnBody = transformed + "\\n return typeof __PreviewComponent !== 'undefined' ? __PreviewComponent : typeof App !== 'undefined' ? App : null;";
        const fn = new Function("React", "ReactDOM", fnBody);
        const Component = fn(window.React, window.ReactDOM);
        if (!Component) {
          throw new Error("No default React component export found in app/page.tsx.");
        }
        const root = ReactDOM.createRoot(document.getElementById("root"));
        root.render(React.createElement(Component));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const errorEl = document.getElementById("error");
        if (errorEl) {
          errorEl.style.display = "block";
          errorEl.textContent = "Local preview compile failed: " + message;
        }
      }
    `

  const tail = `
    </script>
  </body>
</html>`

  return head + script + tail
}

function escapeJs(value: string) {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/`/g, "\\`")
    .replace(/\$/g, "\\$")
    .replace(/\r/g, "\\r")
    .replace(/\n/g, "\\n")
}

function escapeHtml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
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

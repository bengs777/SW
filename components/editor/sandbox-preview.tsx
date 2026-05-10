"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { AlertCircle, RefreshCw, TerminalSquare } from "lucide-react"
import type { GeneratedFile } from "@/lib/types"

const USE_LOCAL_PREVIEW = true

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
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const fileFingerprint = useMemo(() => {
    return files
      .map((file) => `${file.path}:${file.content.length}:${file.content.slice(0, 80)}`)
      .join("|")
  }, [files])

  const refreshStatus = useCallback(async () => {
    if (USE_LOCAL_PREVIEW || !projectId) return
    const response = await fetch(`/api/projects/${projectId}/sandbox`, { cache: "no-store" })
    if (!response.ok) return
    const data = (await response.json()) as SandboxStatus
    setStatus(data)
    if (data.error) onError?.(data.error)
  }, [onError, projectId])

  const startRuntime = useCallback(async () => {
    if (USE_LOCAL_PREVIEW) {
      setFallbackDoc(buildFallbackSrcDoc(files))
      setStatus({ status: "running", previewUrl: null, logs: [], error: null })
      return
    }
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

// Local preview: debounced rebuild when files change
  useEffect(() => {
    if (!USE_LOCAL_PREVIEW) return
    if (debounceRef.current) clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(() => {
      setFallbackDoc(buildFallbackSrcDoc(files))
      setStatus({ status: "running", previewUrl: null, logs: [], error: null })
    }, 400)
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current)
    }
  }, [fileFingerprint, files])

  useEffect(() => {
    if (USE_LOCAL_PREVIEW) {
      return
    }
    setFallbackDoc(null)
    void startRuntime()
  }, [fileFingerprint, startRuntime])

  useEffect(() => {
    if (USE_LOCAL_PREVIEW || !projectId) return
    const interval = window.setInterval(() => {
      void refreshStatus()
    }, status.status === "running" ? 5000 : 1500)

    return () => window.clearInterval(interval)
  }, [projectId, refreshStatus, status.status])

  if (!USE_LOCAL_PREVIEW && !projectId) {
    return (
      <div className={`flex h-full w-full items-center justify-center bg-background p-6 text-center ${className}`}>
        <div className="max-w-sm text-sm text-muted-foreground">
          Runtime preview requires a project id to start the sandbox runtime.
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

      {status.error && !fallbackDoc && (
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
    return buildTsxPreviewSrcDoc(pageFile.content, files)
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

function buildTsxPreviewSrcDoc(pageContent: string, allFiles: GeneratedFile[]) {
  // Build file map: normalized path → content
  const fileMap: Record<string, string> = {}
  for (const file of allFiles) {
    const normalized = file.path.replace(/\\/g, "/").replace(/^\.\//, "")
    fileMap[normalized] = file.content
  }
  // Ensure entry exists at app/page.tsx
  fileMap["app/page.tsx"] = pageContent

  const serializedFiles = JSON.stringify(fileMap)
    .replace(/<\/script>/gi, "<\\/script>")
    .replace(/<!--/g, "<\\!--")

  const head = `<!DOCTYPE html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Preview</title>
    <style>
      * { margin:0; padding:0; box-sizing:border-box; }
      body { font-family:system-ui,sans-serif; background:#fff; color:#111; min-height:100vh; }
      #root { min-height:100vh; }
      .loading { display:flex; align-items:center; justify-content:center; height:100vh; flex-direction:column; gap:12px; color:#888; font-size:14px; }
      .loading .spinner { width:28px; height:28px; border:3px solid #e5e7eb; border-top-color:#3b82f6; border-radius:50%; animation:spin .6s linear infinite; }
      @keyframes spin { to { transform:rotate(360deg); } }
      .error-block { display:none; padding:32px; font-family:ui-monospace,monospace; font-size:13px; line-height:1.5; color:#a00; white-space:pre-wrap; }
      .error-title { font-weight:600; color:#d00; margin-bottom:8px; font-size:14px; }
      .error-stack { color:#555; margin-top:4px; font-size:12px; }
      body.running .loading { display:none; }
      body.running .error-block { display:none; }
      body.error .loading { display:none; }
      body.error #root { display:none; }
      body.error .error-block { display:block; }
      body.compiling .loading { display:flex; }
      body.compiling #root { display:none; }
      body.compiling .error-block { display:none; }
    </style>
    <script src="https://unpkg.com/react@18/umd/react.development.js"></script>
    <script src="https://unpkg.com/react-dom@18/umd/react-dom.development.js"></script>
    <script src="https://unpkg.com/@babel/standalone/babel.min.js"></script>
  </head>
  <body class="compiling">
    <div class="loading">
      <div class="spinner"></div>
      <span>Compiling preview...</span>
    </div>
    <div id="root"></div>
    <div id="error" class="error-block"></div>
    <script>`

  const script = `
(function() {
  'use strict';

  var __files = ${serializedFiles};
  var __cache = {};
  var __exts = ['', '.tsx', '.ts', '.jsx', '.js', '/index.tsx', '/index.ts', '/index.js'];

  function __tryExt(p) {
    for (var i = 0; i < __exts.length; i++) {
      var k = p + __exts[i];
      if (__files[k] !== undefined) return k;
    }
    return p + '.tsx';
  }

  function __resolve(base, source) {
    if (source.startsWith('@/')) return __tryExt(source.slice(2));
    if (source.startsWith('./') || source.startsWith('../')) {
      var dir = base.lastIndexOf('/');
      var dirPath = dir >= 0 ? base.slice(0, dir + 1) : '';
      var parts = dirPath.split('/').filter(Boolean);
      var segs = source.split('/');
      for (var j = 0; j < segs.length; j++) {
        if (segs[j] === '..') parts.pop();
        else if (segs[j] !== '.') parts.push(segs[j]);
      }
      return __tryExt(parts.join('/'));
    }
    return source;
  }

  function __require(base, source) {
    var resolved = __resolve(base, source);
    if (__cache[resolved]) return __cache[resolved];

    var content = __files[resolved];
    if (!content) {
      console.warn('[preview] Module "' + source + '" not found at "' + resolved + '"');
      return {};
    }

    // Pre-process: rewrite import paths to resolved absolute paths
    var processed = content.replace(
      /(?:import|export)\\b[\\s\\S]*?(?:from\\s+)?['"]([^'"]+)['"]|import\\s+['"]([^'"]+)['"]/g,
      function(match, from1, from2) {
        var src = from1 || from2;
        if (!src) return match;
        if (src.startsWith('@/') || src.startsWith('./') || src.startsWith('../')) {
          return match.replace(src, __resolve(resolved, src));
        }
        return match;
      }
    );

    var transformed;
    try {
      var result = Babel.transform(processed, {
        filename: resolved,
        presets: [
          ['react', { runtime: 'automatic' }],
          ['typescript', { isTSX: true, allExtensions: true }],
          ['env', { modules: 'commonjs' }]
        ],
        sourceType: 'module',
        parserOpts: { allowImportExportEverywhere: true, plugins: ['jsx', 'typescript'] }
      });
      transformed = result.code;
    } catch (e) {
      throw new Error('Compile error in ' + resolved + ': ' + e.message);
    }

    var exports = {};
    var module = { exports: exports };

    try {
      var fn = new Function('require', 'exports', 'module', '__dirname', transformed);
      fn(
        function(req) { return __require(resolved, req); },
        exports, module,
        resolved.substring(0, resolved.lastIndexOf('/') + 1)
      );
    } catch (e) {
      throw new Error('Runtime error in ' + resolved + ': ' + e.message);
    }

    __cache[resolved] = module.exports;
    return module.exports;
  }

  var timer = setTimeout(function() {
    var el = document.getElementById('error');
    if (el) {
      document.body.className = 'error';
      el.innerHTML = '<div class="error-title">Preview compilation timed out</div><div class="error-stack">Check for circular dependencies or large files.</div>';
    }
  }, 15000);

  try {
    document.body.className = 'compiling';
    var entry = __require('', 'app/page.tsx');
    var Component = entry.default || entry;
    if (!Component) throw new Error('No default React component found in app/page.tsx.');
    clearTimeout(timer);
    document.body.className = 'running';
    var root = ReactDOM.createRoot(document.getElementById('root'));
    root.render(React.createElement(Component));
  } catch (e) {
    clearTimeout(timer);
    document.body.className = 'error';
    var el = document.getElementById('error');
    if (el) {
      var msg = (e.stack || e.message || String(e))
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      el.innerHTML = '<div class="error-title">Preview Error</div><div class="error-stack">' + msg.replace(/\\n/g, '<br>') + '</div>';
    }
  }
})();`

  const tail = `</script>
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

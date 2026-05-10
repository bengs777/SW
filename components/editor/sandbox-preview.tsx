"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { AlertCircle, Loader2, RefreshCw, TerminalSquare } from "lucide-react"
import { cn } from "@/lib/utils"
import type { GeneratedFile } from "@/lib/types"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type PreviewStatus = "idle" | "loading" | "compiling" | "ready" | "error"

interface PreviewError {
  message: string
  stack?: string
}

interface SandboxPreviewProps {
  files: GeneratedFile[]
  className?: string
  projectId?: string
  onError?: (error: string) => void
}

// ---------------------------------------------------------------------------
// CDN Import Map — resolves bare specifiers to ESM CDN URLs
// ---------------------------------------------------------------------------

const CDN_IMPORTS: Record<string, string> = {
  "react": "https://esm.sh/react@18.3.1",
  "react-dom": "https://esm.sh/react-dom@18.3.1",
  "react-dom/client": "https://esm.sh/react-dom@18.3.1/client",
  "react/jsx-runtime": "https://esm.sh/react@18.3.1/jsx-runtime",
  "react/jsx-dev-runtime": "https://esm.sh/react@18.3.1/jsx-dev-runtime",
  "react-is": "https://esm.sh/react-is@18",
  "scheduler": "https://esm.sh/scheduler@0.23",
  "lucide-react": "https://esm.sh/lucide-react@0.454",
  "clsx": "https://esm.sh/clsx@2",
  "tailwind-merge": "https://esm.sh/tailwind-merge@2",
  "class-variance-authority": "https://esm.sh/class-variance-authority@0.7",
  "zod": "https://esm.sh/zod@3",
  "date-fns": "https://esm.sh/date-fns@3",
  "recharts": "https://esm.sh/recharts@2",
  "framer-motion": "https://esm.sh/framer-motion@11",
  "@radix-ui/react-slot": "https://esm.sh/@radix-ui/react-slot@1",
  "@radix-ui/react-tabs": "https://esm.sh/@radix-ui/react-tabs@1",
  "@radix-ui/react-dialog": "https://esm.sh/@radix-ui/react-dialog@1",
  "@radix-ui/react-dropdown-menu": "https://esm.sh/@radix-ui/react-dropdown-menu@2",
  "@radix-ui/react-select": "https://esm.sh/@radix-ui/react-select@2",
  "@radix-ui/react-popover": "https://esm.sh/@radix-ui/react-popover@1",
  "@radix-ui/react-toast": "https://esm.sh/@radix-ui/react-toast@1",
  "@radix-ui/react-label": "https://esm.sh/@radix-ui/react-label@2",
  "@radix-ui/react-avatar": "https://esm.sh/@radix-ui/react-avatar@1",
  "@radix-ui/react-alert-dialog": "https://esm.sh/@radix-ui/react-alert-dialog@1",
  "@radix-ui/react-checkbox": "https://esm.sh/@radix-ui/react-checkbox@1",
  "@radix-ui/react-collapsible": "https://esm.sh/@radix-ui/react-collapsible@1",
  "@radix-ui/react-context-menu": "https://esm.sh/@radix-ui/react-context-menu@2",
  "@radix-ui/react-hover-card": "https://esm.sh/@radix-ui/react-hover-card@1",
  "@radix-ui/react-menubar": "https://esm.sh/@radix-ui/react-menubar@1",
  "@radix-ui/react-navigation-menu": "https://esm.sh/@radix-ui/react-navigation-menu@1",
  "@radix-ui/react-progress": "https://esm.sh/@radix-ui/react-progress@1",
  "@radix-ui/react-radio-group": "https://esm.sh/@radix-ui/react-radio-group@1",
  "@radix-ui/react-scroll-area": "https://esm.sh/@radix-ui/react-scroll-area@1",
  "@radix-ui/react-separator": "https://esm.sh/@radix-ui/react-separator@1",
  "@radix-ui/react-slider": "https://esm.sh/@radix-ui/react-slider@1",
  "@radix-ui/react-switch": "https://esm.sh/@radix-ui/react-switch@1",
  "@radix-ui/react-toggle": "https://esm.sh/@radix-ui/react-toggle@1",
  "@radix-ui/react-toggle-group": "https://esm.sh/@radix-ui/react-toggle-group@1",
  "@radix-ui/react-tooltip": "https://esm.sh/@radix-ui/react-tooltip@1",
  "@radix-ui/react-popper": "https://esm.sh/@radix-ui/react-popper@1",
  "@radix-ui/react-portal": "https://esm.sh/@radix-ui/react-portal@1",
  "@radix-ui/react-primitive": "https://esm.sh/@radix-ui/react-primitive@1",
  "react-hook-form": "https://esm.sh/react-hook-form@7",
  "@hookform/resolvers": "https://esm.sh/@hookform/resolvers@3",
  "@tanstack/react-table": "https://esm.sh/@tanstack/react-table@8",
  "@tanstack/react-query": "https://esm.sh/@tanstack/react-query@5",
  "sonner": "https://esm.sh/sonner@1",
  "embla-carousel-react": "https://esm.sh/embla-carousel-react@8",
  "embla-carousel": "https://esm.sh/embla-carousel@8",
  "cmdk": "https://esm.sh/cmdk@1",
  "vaul": "https://esm.sh/vaul@0.9",
  "next/link": "https://esm.sh/next@14/link",
  "next/image": "https://esm.sh/next@14/image",
  "next/navigation": "https://esm.sh/next@14/navigation",
}

// ---------------------------------------------------------------------------
// Import Analysis
// ---------------------------------------------------------------------------

function extractImports(content: string): string[] {
  const imports: string[] = []
  const re = /(?:import|export)\b[\s\S]*?(?:from\s+)?['"]([^'"]+)['"]|import\s+['"]([^'"]+)['"]/g
  let match: RegExpExecArray | null
  while ((match = re.exec(content)) !== null) {
    const src = match[1] || match[2]
    if (src) imports.push(src)
  }
  return imports
}

function isExternalPackage(source: string): boolean {
  const first = source.charAt(0)
  return first !== "." && first !== "/" && !source.startsWith("@/")
}

// ---------------------------------------------------------------------------
// Path Resolution
// ---------------------------------------------------------------------------

const EXTENSIONS = ["", ".tsx", ".ts", ".jsx", ".js", "/index.tsx", "/index.ts", "/index.js"]

function tryExtension(basePath: string, fileMap: Record<string, string>): string | null {
  for (const ext of EXTENSIONS) {
    const candidate = basePath + ext
    if (fileMap[candidate] !== undefined) return candidate
  }
  return null
}

function resolveLocalPath(baseFile: string, importSource: string, fileMap: Record<string, string>): string | null {
  if (importSource.startsWith("@/")) {
    const withoutAlias = importSource.slice(2)
    return tryExtension(withoutAlias, fileMap)
  }
  const dir = baseFile.lastIndexOf("/") >= 0 ? baseFile.slice(0, baseFile.lastIndexOf("/") + 1) : ""
  const parts = dir.split("/").filter(Boolean)
  const segs = importSource.split("/")
  for (const seg of segs) {
    if (seg === "..") parts.pop()
    else if (seg !== ".") parts.push(seg)
  }
  const resolved = parts.join("/")
  return tryExtension(resolved, fileMap)
}

// ---------------------------------------------------------------------------
// Rewrite Imports — replaces local import paths with resolved paths
// ---------------------------------------------------------------------------

function rewriteImports(code: string, filePath: string, fileMap: Record<string, string>): string {
  return code.replace(
    /(?:import|export)\b[\s\S]*?(?:from\s+)?['"]([^'"]+)['"]|import\s+['"]([^'"]+)['"]/g,
    (match, src1, src2) => {
      const src = src1 || src2
      if (!src) return match

      // External package — keep as-is, import map will resolve
      if (isExternalPackage(src)) {
        return match
      }

      // Local import — resolve to full path with extension
      const resolved = resolveLocalPath(filePath, src, fileMap)
      if (resolved) {
        // Replace the import path with the resolved path
        const quote = match.includes(`'${src}'`) ? "'" : '"'
        return match.replace(`${quote}${src}${quote}`, `${quote}${resolved}${quote}`)
      }

      return match
    }
  )
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function SandboxPreview({ files, className, onError }: SandboxPreviewProps) {
  const [status, setStatus] = useState<PreviewStatus>("idle")
  const [previewError, setPreviewError] = useState<PreviewError | null>(null)
  const [srcDoc, setSrcDoc] = useState<string | null>(null)
  const iframeRef = useRef<HTMLIFrameElement>(null)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [iframeLoaded, setIframeLoaded] = useState(false)
  const [iframeError, setIframeError] = useState(false)
  const mountedRef = useRef(true)

  // Stable fingerprint for file changes
  const fileFingerprint = useMemo(
    () =>
      files
        .map((f) => `${f.path}:${f.content.length}:${f.content.slice(0, 80)}`)
        .join("|"),
    [files],
  )

  // --- Build preview HTML ---
  const buildPreview = useCallback(() => {
    if (files.length === 0) {
      setSrcDoc(null)
      setStatus("idle")
      return
    }

    setStatus("compiling")
    setIframeLoaded(false)
    setIframeError(false)

    try {
      const html = buildPreviewSrcDoc(files)
      setSrcDoc(html)
      setPreviewError(null)
      setStatus("ready")
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      setPreviewError({ message })
      setStatus("error")
      onError?.(message)
    }
  }, [files, onError])

  // --- Debounced rebuild on file changes ---
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current)

    if (files.length === 0) {
      setSrcDoc(null)
      setStatus("idle")
      return
    }

    setStatus("loading")
    debounceRef.current = setTimeout(() => {
      if (mountedRef.current) buildPreview()
    }, 500)

    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current)
    }
    // Only rebuild when the fingerprint changes
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fileFingerprint])

  // --- Cleanup on unmount ---
  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  // --- Reset on fresh file set ---
  useEffect(() => {
    setPreviewError(null)
    setIframeLoaded(false)
    setIframeError(false)
  }, [fileFingerprint])

  // --- iframe error handler (runtime errors) ---
  const handleIframeError = useCallback(() => {
    setIframeError(true)
    setStatus("error")
    const msg = "The preview iframe failed to load."
    setPreviewError({ message: msg })
    onError?.(msg)
  }, [onError])

  const handleIframeLoad = useCallback(() => {
    setIframeLoaded(true)
    setIframeError(false)
    setStatus("ready")
  }, [])

  // --- Handle refresh ---
  const handleRefresh = useCallback(() => {
    buildPreview()
  }, [buildPreview])

  // --- Render ---
  const showOverlay = status === "loading" || status === "compiling"
  const hasContent = srcDoc !== null

  return (
    <div className={cn("relative h-full w-full bg-background", className)}>
      {/* Iframe */}
      {hasContent ? (
        // Keep preview on an opaque origin; generated code loses same-origin APIs but cannot read app cookies.
        <iframe
          ref={iframeRef}
          srcDoc={srcDoc}
          className="h-full w-full border-0"
          title="AI Preview"
          sandbox="allow-scripts"
          onError={handleIframeError}
          onLoad={handleIframeLoad}
        />
      ) : (
        <div className="flex h-full items-center justify-center px-6 text-center">
          <div className="max-w-sm text-sm text-muted-foreground">
            {files.length === 0
              ? "Generate code to see a live preview"
              : "Building preview..."}
          </div>
        </div>
      )}

      {/* Loading / compiling overlay */}
      {showOverlay && (
        <div className="absolute inset-0 z-10 flex items-center justify-center bg-background/80 backdrop-blur-sm">
          <div className="flex flex-col items-center gap-3">
            <Loader2 className="h-6 w-6 animate-spin text-sky-500" />
            <span className="text-xs text-muted-foreground">
              {status === "loading" ? "Preparing files..." : "Compiling preview..."}
            </span>
          </div>
        </div>
      )}

      {/* Error overlay — never blank white screen */}
      {status === "error" && previewError && (
        <div className="absolute inset-0 z-20 flex flex-col bg-background">
          {/* Error header */}
          <div className="flex items-center justify-between border-b border-destructive/20 bg-destructive/5 px-4 py-2">
            <div className="flex items-center gap-2 text-sm font-medium text-destructive">
              <AlertCircle className="h-4 w-4" />
              <span>Preview Error</span>
            </div>
            <button
              type="button"
              onClick={handleRefresh}
              className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-xs text-muted-foreground hover:bg-muted"
            >
              <RefreshCw className="h-3 w-3" />
              Retry
            </button>
          </div>

          {/* Error body */}
          <div className="flex-1 overflow-auto p-4 font-mono text-xs leading-relaxed">
            <div className="mb-2 text-destructive/80">Error occurred while building the preview:</div>
            <pre className="whitespace-pre-wrap break-all rounded-md bg-black/5 p-3 text-foreground/80 dark:bg-white/5">
              {previewError.message}
            </pre>
            {previewError.stack && (
              <pre className="mt-2 whitespace-pre-wrap break-all text-muted-foreground/60">
                {previewError.stack}
              </pre>
            )}
          </div>

          {/* Fallback: show source files so it's never blank */}
          <div className="max-h-40 overflow-auto border-t border-border bg-muted/30 p-4">
            <div className="mb-2 flex items-center gap-2 text-xs text-muted-foreground">
              <TerminalSquare className="h-3.5 w-3.5" />
              <span>Project files ({files.length})</span>
            </div>
            {files.slice(0, 3).map((file) => (
              <div key={file.path} className="mb-2">
                <div className="text-[11px] font-medium text-foreground/70">{file.path}</div>
                <pre className="mt-0.5 max-h-20 overflow-auto rounded bg-black/[0.04] p-2 text-[11px] leading-relaxed text-muted-foreground/60 dark:bg-white/[0.04]">
                  {file.content.slice(0, 300)}
                  {file.content.length > 300 ? "..." : ""}
                </pre>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Preview HTML builder — ESM + Import Map Architecture
// Uses Babel Standalone for TSX/JSX transformation
// Uses Import Maps for CDN package resolution
// Local file resolution: imports rewritten to resolved paths, handled by
// dynamic import map injection inside the iframe
// ---------------------------------------------------------------------------

function escapeScriptContent(str: string): string {
  return str
    .replace(/<\/script>/gi, "<\\/script>")
    .replace(/<!--/g, "<\\!--")
}

function buildPreviewSrcDoc(files: GeneratedFile[]): string {
  // Build file map with normalized paths
  const fileMap: Record<string, string> = {}
  for (const file of files) {
    const normalized = file.path.replace(/\\/g, "/").replace(/^\.\//, "")
    fileMap[normalized] = file.content
  }

  // Ensure entry exists
  const entryKey = guessEntryFile(files)
  if (!entryKey || !fileMap[entryKey]) {
    throw new Error("No entry file found. Expected app/page.tsx, src/App.tsx, or index.tsx")
  }

  // Detect all external packages used across all files
  const allImports = new Set<string>()
  for (const file of files) {
    const imports = extractImports(file.content)
    for (const imp of imports) {
      if (isExternalPackage(imp)) {
        allImports.add(imp)
      }
    }
  }

  // Build import map for CDN packages
  const importMap: Record<string, string> = {}
  for (const pkg of allImports) {
    if (CDN_IMPORTS[pkg]) {
      importMap[pkg] = CDN_IMPORTS[pkg]
    } else {
      // Auto-resolve via esm.sh
      importMap[pkg] = `https://esm.sh/${pkg}`
    }
  }

  // Rewrite imports in all files — resolve local import paths
  const rewrittenFiles: Record<string, string> = {}
  for (const [path, content] of Object.entries(fileMap)) {
    rewrittenFiles[path] = rewriteImports(content, path, fileMap)
  }

  // Serialize for iframe
  const serializedFiles = escapeScriptContent(JSON.stringify(rewrittenFiles))
  const serializedEntry = JSON.stringify(entryKey)
  const serializedImportMap = escapeScriptContent(JSON.stringify(importMap))

  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline' https://unpkg.com https://esm.sh blob:; connect-src https://esm.sh https://unpkg.com blob: data:; img-src data: blob: https:; style-src 'unsafe-inline'; font-src data: https:; worker-src blob:; base-uri 'none'; form-action 'none'; object-src 'none'">
<title>Preview</title>
<style>
  *{margin:0;padding:0;box-sizing:border-box}
  body{font-family:system-ui,sans-serif;background:#fff;color:#111;min-height:100vh}
  #root{min-height:100vh}
  #error{display:none;padding:32px;font-family:ui-monospace,monospace;font-size:13px;line-height:1.6;color:#a00;white-space:pre-wrap;overflow:auto;max-height:100vh}
  #error .title{font-weight:600;color:#d00;margin-bottom:8px;font-size:14px}
  #error .stack{color:#555;margin-top:4px;font-size:12px;white-space:pre-wrap}
  body.error #root{display:none}
  body.error #error{display:block}
  body.compiling #root{display:none}
  body.compiling #error{display:none}
  body.ready #error{display:none}
  .loader{display:none;align-items:center;justify-content:center;height:100vh;flex-direction:column;gap:12px;color:#888;font-size:14px}
  .loader .spinner{width:28px;height:28px;border:3px solid #e5e7eb;border-top-color:#3b82f6;border-radius:50%;animation:spin .6s linear infinite}
  @keyframes spin{to{transform:rotate(360deg)}}
  body.compiling .loader{display:flex}
  body.ready .loader{display:none}
  body.error .loader{display:none}
</style>
<script src="https://unpkg.com/@babel/standalone/babel.min.js"><\/script>
</head>
<body class="compiling">
<div class="loader"><div class="spinner"></div><span>Compiling preview...</span></div>
<div id="root"></div>
<div id="error"></div>
<script>
(function(){
  'use strict';

  var __files = ${serializedFiles};
  var __entry = ${serializedEntry};
  var __cdnImportMap = ${serializedImportMap};
  var __cache = {};
  var __blobMap = {};
  var __exts = ['','.tsx','.ts','.jsx','.js','/index.tsx','/index.ts','/index.js'];

  var __transformTimeout = setTimeout(function(){
    showError('Preview compilation timed out. Check for circular dependencies or large files.');
  }, 15000);

  function escapeHtml(s){
    return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  }

  function showError(err){
    clearTimeout(__transformTimeout);
    document.body.className='error';
    var el=document.getElementById('error');
    if(!el)return;
    var msg;
    if(typeof err==='string')msg=err;
    else if(err&&err.message)msg=err.message+(err.stack?'\\n\\n'+err.stack:'');
    else msg=String(err);
    msg=escapeHtml(msg).replace(/\\n/g,'<br>');
    el.innerHTML='<div class="title">Preview Error</div><div class="stack">'+msg+'</div>';
  }

  function getFileContent(path){
    if(__files[path]!==void 0) return __files[path];
    for(var i=0;i<__exts.length;i++){
      var candidate=path+__exts[i];
      if(__files[candidate]!==void 0) return __files[candidate];
    }
    return null;
  }

  function transformFile(path){
    if(__cache[path]) return __cache[path];

    var content = getFileContent(path);
    if(!content){
      console.warn('[preview] File not found: '+path);
      __cache[path] = null;
      return null;
    }

    try{
      var result = Babel.transform(content, {
        filename: path,
        presets: [
          ['react', {runtime:'automatic'}],
          ['typescript', {isTSX:true, allExtensions:true}]
        ],
        sourceType: 'module',
        parserOpts: {
          allowImportExportEverywhere: true,
          plugins: ['jsx','typescript']
        }
      });
      __cache[path] = result.code;
      return result.code;
    }catch(e){
      throw new Error('Compile error in '+path+': '+e.message);
    }
  }

  function executeModule(path){
    if(__blobMap[path]) return __blobMap[path];

    var code = transformFile(path);
    if(code === null) return null;

    var blob = new Blob([code], {type:'text/javascript'});
    var url = URL.createObjectURL(blob);
    __blobMap[path] = url;
    return url;
  }

  try{
    clearTimeout(__transformTimeout);
    document.body.className='ready';

    // Step 1: Transform all files and create blob URLs
    var allPaths = Object.keys(__files);
    for(var i=0; i<allPaths.length; i++){
      executeModule(allPaths[i]);
    }

    // Step 2: Build complete import map (CDN + local blob URLs)
    var importMap = { imports: {} };
    // Add CDN packages
    for(var pkg in __cdnImportMap){
      importMap.imports[pkg] = __cdnImportMap[pkg];
    }
    // Add local files (resolved path -> blob URL)
    for(var p in __blobMap){
      importMap.imports[p] = __blobMap[p];
    }

    // Step 3: Inject import map
    var imScript = document.createElement('script');
    imScript.type = 'importmap';
    imScript.textContent = JSON.stringify(importMap);
    document.head.appendChild(imScript);

    // Step 4: Load React, ReactDOM, and entry module
    var entryUrl = __blobMap[__entry];
    if(!entryUrl){
      showError('Entry module not found: '+__entry);
      return;
    }

    Promise.all([
      import('react'),
      import('react-dom/client'),
      import(entryUrl)
    ]).then(function(results){
      var React = results[0].default || results[0];
      var ReactDOMClient = results[1];
      var entryModule = results[2];
      var App = entryModule.default || entryModule;

      if(!App){
        showError('No default export found in '+JSON.stringify(__entry)+'. Make sure your entry file has a default export.');
        return;
      }

      var container = document.getElementById('root');
      if(!container){
        showError('Root element not found');
        return;
      }

      // Error Boundary Component
      var ErrorBoundary = (function(){
        function ErrorBoundary(props){
          this.props = props;
          this.state = {hasError: false, error: null};
        }
        ErrorBoundary.prototype.componentDidCatch = function(error, info){
          console.error("[Preview ErrorBoundary]", error, info);
        };
        ErrorBoundary.getDerivedStateFromError = function(error){
          return {hasError: true, error: error};
        };
        ErrorBoundary.prototype.render = function(){
          if(this.state.hasError){
            return React.createElement("div", {
              style: { padding: "32px", fontFamily: "monospace", fontSize: "13px", color: "#d00", backgroundColor: "#fff5f5", minHeight: "100vh" }
            },
              React.createElement("h2", {style: {margin: "0 0 8px", fontSize: "16px"}}, "Runtime Error"),
              React.createElement("pre", {
                style: {whiteSpace: "pre-wrap", color: "#a00", fontSize: "12px", lineHeight: "1.5"}
              }, String(this.state.error && (this.state.error.message || this.state.error))),
              this.state.error && this.state.error.stack
                ? React.createElement("pre", {
                    style: {whiteSpace: "pre-wrap", color: "#555", fontSize: "11px", marginTop: "8px"}
                  }, this.state.error.stack)
                : null
            );
          }
          return this.props.children;
        };
        return ErrorBoundary;
      })();

      // Render with Error Boundary
      var root = ReactDOMClient.createRoot(container);
      root.render(
        React.createElement(ErrorBoundary, null,
          React.createElement(App)
        )
      );

    }).catch(function(err){
      showError(err);
    });

  }catch(e){
    showError(e);
  }
})();
<\/script>
</body>
</html>`
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function guessEntryFile(files: GeneratedFile[]): string | null {
  const priorities = [
    "app/page.tsx",
    "app/page.jsx",
    "src/App.tsx",
    "src/App.jsx",
    "pages/index.tsx",
    "pages/index.jsx",
    "index.tsx",
    "index.jsx",
  ]
  for (const path of priorities) {
    if (files.some((f) => f.path.replace(/\\/g, "/") === path)) {
      return path
    }
  }
  // Fallback: first tsx/jsx file
  const first = files.find((f) => /\.tsx$|\.jsx$/i.test(f.path))
  return first ? first.path.replace(/\\/g, "/") : null
}

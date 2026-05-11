"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { AlertCircle, Loader2, RefreshCw, TerminalSquare } from "lucide-react"
import { cn } from "@/lib/utils"
import type { GeneratedFile } from "@/lib/types"
import { compileProject, containsUnresolvedAlias } from "@/lib/preview/module-resolution"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type PreviewStatus = "idle" | "loading" | "compiling" | "ready" | "error"

interface PreviewError {
  message: string
  stack?: string
}

type PreviewTelemetryEvent = {
  type?: string
  event?: string
  stage?: string
  message?: string
  stack?: string
  metrics?: Record<string, unknown>
}

interface SandboxPreviewProps {
  files: GeneratedFile[]
  className?: string
  projectId?: string
  onError?: (error: string) => void
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function SandboxPreview({ files, className, onError }: SandboxPreviewProps) {
  const [status, setStatus] = useState<PreviewStatus>("idle")
  const [previewError, setPreviewError] = useState<PreviewError | null>(null)
  const [srcDoc, setSrcDoc] = useState<string | null>(null)
  const [iframeNonce, setIframeNonce] = useState(0)
  const iframeRef = useRef<HTMLIFrameElement>(null)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const bootWatchdogRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const retryCountRef = useRef(0)
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

    try {
      const startedAt = performance.now()
      const html = buildPreviewSrcDoc(files)
      logPreviewTelemetry("compile.complete", {
        compileDurationMs: Math.round(performance.now() - startedAt),
        fileCount: files.length,
        htmlBytes: html.length,
      })
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

  const recoverPreview = useCallback((message: string, stack?: string) => {
    if (retryCountRef.current < 1 && files.length > 0) {
      retryCountRef.current += 1
      logPreviewTelemetry("runtime.retry", {
        reason: message,
        attempt: retryCountRef.current,
      })
      setStatus("loading")
      setPreviewError(null)
      setIframeNonce((value) => value + 1)
      buildPreview()
      return
    }

    setStatus("error")
    setPreviewError({ message, stack })
    onError?.(stack ? `${message}\n\n${stack}` : message)
  }, [buildPreview, files.length, onError])

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
    retryCountRef.current = 0
  }, [fileFingerprint])

  useEffect(() => {
    function handlePreviewMessage(event: MessageEvent) {
      if (event.source !== iframeRef.current?.contentWindow) return
      if (event.origin !== "null") return

      const data = event.data as PreviewTelemetryEvent | null
      if (!data) return

      if (data.type === "swift-preview-telemetry") {
        logPreviewTelemetry(data.event || "runtime.event", data.metrics || {})
        if (data.event === "runtime.ready" && bootWatchdogRef.current) {
          clearTimeout(bootWatchdogRef.current)
          bootWatchdogRef.current = null
        }
        return
      }

      if (data.type !== "swift-preview-error") return

      const message = data.message || "Unknown preview runtime error"
      if (bootWatchdogRef.current) {
        clearTimeout(bootWatchdogRef.current)
        bootWatchdogRef.current = null
      }
      logPreviewTelemetry("runtime.error", { message })
      recoverPreview(message, data.stack)
    }

    window.addEventListener("message", handlePreviewMessage)
    return () => window.removeEventListener("message", handlePreviewMessage)
  }, [recoverPreview])

  useEffect(() => {
    if (!srcDoc) return

    if (bootWatchdogRef.current) {
      clearTimeout(bootWatchdogRef.current)
    }

    const startedAt = performance.now()
    bootWatchdogRef.current = setTimeout(() => {
      logPreviewTelemetry("runtime.boot_timeout", {
        iframeBootTimeMs: Math.round(performance.now() - startedAt),
      })
      recoverPreview("Preview runtime timed out while booting.")
    }, 12_000)

    return () => {
      if (bootWatchdogRef.current) {
        clearTimeout(bootWatchdogRef.current)
        bootWatchdogRef.current = null
      }
    }
  }, [iframeNonce, recoverPreview, srcDoc])

  // --- iframe error handler (runtime errors) ---
  const handleIframeError = useCallback(() => {
    const msg = "The preview iframe failed to load."
    recoverPreview(msg)
  }, [recoverPreview])

  const handleIframeLoad = useCallback(() => {
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
          key={`${fileFingerprint}:${iframeNonce}`}
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

function logPreviewTelemetry(event: string, metrics: Record<string, unknown> = {}) {
  console.info("[swift-preview]", {
    event,
    metrics,
    timestamp: new Date().toISOString(),
  })
}

function buildPreviewSrcDoc(files: GeneratedFile[]): string {
  const graph = compileProject(files)
  assertGraphHasNoUnresolvedAliases(graph)

  // Serialize for iframe
  const serializedFiles = escapeScriptContent(JSON.stringify(graph.files))
  const serializedEntry = JSON.stringify(graph.entry)
  const serializedImportMap = escapeScriptContent(JSON.stringify(graph.importMap))
  const serializedCss = escapeScriptContent(JSON.stringify(graph.css))
  const serializedShims = escapeScriptContent(JSON.stringify(graph.shims))
  const serializedWarnings = escapeScriptContent(JSON.stringify(graph.warnings))

  const html = `<!DOCTYPE html>
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

  var __compiledModules = ${serializedFiles};
  var __entry = ${serializedEntry};
  var __cdnImportMap = ${serializedImportMap};
  var __css = ${serializedCss};
  var __shimModules = ${serializedShims};
  var __warnings = ${serializedWarnings};
  var __cache = {};
  var __blobMap = {};
  var __finalCodeMap = {};
  var __buildingModules = {};
  var __exts = ['','.tsx','.ts','.jsx','.js','/index.tsx','/index.ts','/index.js'];
  var __bootStartedAt = performance.now();

  var __executionTimeout = setTimeout(function(){
    showError('Preview execution timed out. Check for an infinite render loop or a long-running module.');
  }, 12000);

  emitTelemetry('runtime.boot', {
    moduleCount: Object.keys(__compiledModules).length
  });

  function escapeHtml(s){
    return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  }

  function showError(err){
    clearTimeout(__executionTimeout);
    document.body.className='error';
    var el=document.getElementById('error');
    if(!el)return;
    var msg;
    if(typeof err==='string')msg=err;
    else if(err&&err.message)msg=err.message+(err.stack?'\\n\\n'+err.stack:'');
    else msg=String(err);
    try {
      window.parent.postMessage({ type: 'swift-preview-error', message: msg }, '*');
    } catch (postMessageError) {}
    emitTelemetry('runtime.error', { message: msg });
    msg=escapeHtml(msg).replace(/\\n/g,'<br>');
    el.innerHTML='<div class="title">Preview Error</div><div class="stack">'+msg+'</div>';
  }

  function injectCss(){
    if(!__css) return;
    assertNoUnresolvedAlias('css', __css);
    var style = document.createElement('style');
    style.setAttribute('data-preview-css', 'true');
    style.textContent = __css;
    document.head.appendChild(style);
    emitTelemetry('css.injected', {
      cssBytes: __css.length
    });
  }

  function emitTelemetry(event, metrics){
    try {
      window.parent.postMessage({
        type: 'swift-preview-telemetry',
        event: event,
        metrics: metrics || {}
      }, '*');
    } catch (postMessageError) {}
  }

  function containsUnresolvedAlias(code){
    var source = String(code || '');
    var atAlias = String.fromCharCode(64) + '/';
    var tildeAlias = String.fromCharCode(126) + '/';
    return source.indexOf(atAlias) >= 0 || source.indexOf(tildeAlias) >= 0;
  }

  function assertNoUnresolvedAlias(path, code){
    if(containsUnresolvedAlias(code)){
      throw new Error('UNRESOLVED_ALIAS_DETECTED in ' + path);
    }
  }

  function assertCompiledModuleSet(){
    var paths = Object.keys(__compiledModules);
    for(var i=0;i<paths.length;i++){
      assertNoUnresolvedAlias(paths[i], __compiledModules[paths[i]]);
    }
    for(var shim in __shimModules){
      assertNoUnresolvedAlias('shim:' + shim, __shimModules[shim]);
    }
  }

  function getFileContent(path){
    if(__compiledModules[path]!==void 0) return __compiledModules[path];
    for(var i=0;i<__exts.length;i++){
      var candidate=path+__exts[i];
      if(__compiledModules[candidate]!==void 0) return __compiledModules[candidate];
    }
    return null;
  }

  function transformFile(path){
    if(__cache[path]) return __cache[path];

    var content = getFileContent(path);
    if(!content){
      emitTelemetry('compile.missing_file', { path: path });
      __cache[path] = null;
      return null;
    }
    assertNoUnresolvedAlias(path + ' source', content);

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
      assertNoUnresolvedAlias(path + ' compiled', result.code);
      __cache[path] = result.code;
      return result.code;
    }catch(e){
      throw new Error('Compile error in '+path+': '+e.message);
    }
  }

  function executeModule(path){
    if(__blobMap[path]) return __blobMap[path];
    if(__buildingModules[path]){
      throw new Error('CIRCULAR_DEPENDENCY_DETECTED in iframe module loader: ' + path);
    }

    __buildingModules[path] = true;

    var code = transformFile(path);
    if(code === null) {
      delete __buildingModules[path];
      return null;
    }

    code = linkLocalVirtualImports(path, code);
    assertNoUnresolvedAlias(path + ' blob', code);
    __finalCodeMap[path] = code;

    var blob = new Blob([code], {type:'text/javascript'});
    var url = URL.createObjectURL(blob);
    __blobMap[path] = url;
    delete __buildingModules[path];
    return url;
  }

  function linkLocalVirtualImports(path, code){
    var linked = String(code || '');
    var modulePaths = Object.keys(__compiledModules);

    for(var i=0;i<modulePaths.length;i++){
      var depPath = modulePaths[i];
      var specifier = '/@preview/' + depPath;
      if(linked.indexOf(specifier) < 0) continue;

      var depUrl = executeModule(depPath);
      if(!depUrl){
        throw new Error('Missing Blob URL for virtual module ' + specifier + ' imported by ' + path);
      }

      linked = replaceAll(linked, JSON.stringify(specifier), JSON.stringify(depUrl));
      linked = replaceAll(linked, "'" + specifier + "'", JSON.stringify(depUrl));
    }

    if(linked.indexOf('/@preview/') >= 0){
      throw new Error('UNRESOLVED_VIRTUAL_MODULE_DETECTED in ' + path);
    }

    return linked;
  }

  function replaceAll(value, search, replacement){
    return String(value).split(search).join(replacement);
  }

  function createShimModule(specifier, code){
    if(__blobMap[specifier]) return __blobMap[specifier];
    assertNoUnresolvedAlias('shim:' + specifier, code);
    var blob = new Blob([code], {type:'text/javascript'});
    var url = URL.createObjectURL(blob);
    __blobMap[specifier] = url;
    return url;
  }

  try{
    document.body.className='ready';
    assertCompiledModuleSet();
    injectCss();
    for(var warningIndex = 0; warningIndex < __warnings.length; warningIndex++){
      emitTelemetry('compile.warning', { message: __warnings[warningIndex] });
    }

    // Step 1: Transform all files and create blob URLs
    var compileStartedAt = performance.now();
    var allPaths = Object.keys(__compiledModules);
    for(var i=0; i<allPaths.length; i++){
      executeModule(allPaths[i]);
    }
    for(var shim in __shimModules){
      createShimModule(shim, __shimModules[shim]);
    }
    emitTelemetry('compile.complete', {
      compileDurationMs: Math.round(performance.now() - compileStartedAt),
      moduleCount: allPaths.length,
      shimCount: Object.keys(__shimModules).length
    });

    // Step 2: Build complete import map (CDN + local blob URLs)
    var importMap = { imports: {} };
    // Add CDN packages
    for(var pkg in __cdnImportMap){
      importMap.imports[pkg] = __cdnImportMap[pkg];
    }
    // Add local files (virtual preview path -> blob URL)
    for(var p in __blobMap){
      if(p.indexOf('/@preview/') === 0){
        importMap.imports[p] = __blobMap[p];
      } else if(__compiledModules[p] !== void 0) {
        importMap.imports['/@preview/' + p] = __blobMap[p];
      } else {
        importMap.imports[p] = __blobMap[p];
      }
    }

    // Step 3: Inject import map
    var imScript = document.createElement('script');
    imScript.type = 'importmap';
    imScript.textContent = JSON.stringify(importMap);
    assertNoUnresolvedAlias('importmap', imScript.textContent);
    document.head.appendChild(imScript);

    emitTelemetry('runtime.linked', {
      entry: __entry,
      moduleCount: Object.keys(__compiledModules).length,
      blobCount: Object.keys(__blobMap).length,
      importCount: Object.keys(importMap.imports).length
    });

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
          emitTelemetry('runtime.error_boundary', {
            message: error && error.message ? error.message : String(error)
          });
          try {
            window.parent.postMessage({ type: 'swift-preview-error', message: error && error.message ? error.message : String(error), stack: error && error.stack ? error.stack : "" }, '*');
          } catch (postMessageError) {}
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
      clearTimeout(__executionTimeout);
      emitTelemetry('runtime.ready', {
        iframeBootTimeMs: Math.round(performance.now() - __bootStartedAt),
        moduleCount: Object.keys(__compiledModules).length,
        blobCount: Object.keys(__blobMap).length
      });

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

  assertSrcDocHasNoUnresolvedAliases(html)
  return html
}

function assertGraphHasNoUnresolvedAliases(graph: ReturnType<typeof compileProject>) {
  const offenders: string[] = []

  for (const [path, code] of Object.entries(graph.files)) {
    if (containsUnresolvedAlias(code)) {
      offenders.push(path)
    }
  }

  for (const [specifier, code] of Object.entries(graph.shims)) {
    if (containsUnresolvedAlias(code)) {
      offenders.push(`shim:${specifier}`)
    }
  }

  if (containsUnresolvedAlias(graph.css)) {
    offenders.push("css")
  }

  if (offenders.length > 0) {
    throw new Error(`UNRESOLVED_ALIAS_DETECTED\n${offenders.join("\n")}`)
  }
}

function assertSrcDocHasNoUnresolvedAliases(html: string) {
  if (containsUnresolvedAlias(html)) {
    throw new Error("UNRESOLVED_ALIAS_DETECTED in iframe srcDoc")
  }
}

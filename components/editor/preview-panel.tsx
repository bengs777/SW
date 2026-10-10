"use client"

import { useState, useCallback, useEffect, useMemo } from "react"
import dynamic from "next/dynamic"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Button } from "@/components/ui/button"
import { SandboxPreview } from "./sandbox-preview"
import { FileManagerExplorer } from "./file-manager-explorer"
import { TerminalPanel } from "./terminal-panel"
import {
  Smartphone,
  Tablet,
  Monitor,
  RefreshCw,
  ExternalLink,
  Copy,
  Check,
  FileCode,
  AlertCircle,
  Folder,
  Square,
  Terminal as TerminalIcon,
  X,
  Code2,
} from "lucide-react"
import { cn } from "@/lib/utils"
import { buildBrowserPreviewFiles } from "@/lib/preview/sanitizer"
import type { GeneratedFile } from "@/lib/types"
import type { GenerationProgress } from "@/app/dashboard/project/[id]/page"

const MonacoEditor = dynamic(() => import("@monaco-editor/react"), {
  ssr: false,
  loading: () => (
    <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
      Loading editor...
    </div>
  ),
})

const RUNTIME_PREVIEW_SANDBOX = "allow-scripts allow-forms allow-same-origin allow-popups allow-modals"

function resolveRuntimePreviewSandbox(_runtimePreviewUrl: string | null) {
  return RUNTIME_PREVIEW_SANDBOX
}

type ViewportSize = "mobile" | "tablet" | "desktop"

export type PreviewTabType = "preview" | "code" | "terminal" | "explorer"

interface PreviewPanelProps {
  files: GeneratedFile[]
  previewFiles?: GeneratedFile[] | null
  currentVersion: number
  activeFileIndex: number
  onSelectFile?: (index: number) => void
  onViewportChange?: (viewport: ViewportSize) => void
  onUpdateFile?: (index: number, content: string) => void
  onReplaceFiles?: (files: GeneratedFile[]) => void
  onSaveFiles?: () => void
  isSaving?: boolean
  isDirty?: boolean
  activeTab?: PreviewTabType
  onTabChange?: (tab: PreviewTabType) => void
  onPreviewErrorChange?: (error: string | null) => void
  isGenerating?: boolean
  streamLockedPaths?: string[]
  generationProgress?: GenerationProgress | null
  onCancelGeneration?: () => void
  projectId?: string
  runtimePreviewUrl?: string | null
}

export function PreviewPanel({
  files,
  previewFiles = null,
  currentVersion,
  activeFileIndex,
  onSelectFile,
  onViewportChange,
  onUpdateFile,
  onReplaceFiles,
  onSaveFiles,
  isSaving = false,
  isDirty = false,
  activeTab: activeTabProp,
  onTabChange,
  onPreviewErrorChange,
  isGenerating = false,
  streamLockedPaths = [],
  generationProgress = null,
  onCancelGeneration,
  projectId,
  runtimePreviewUrl = null,
}: PreviewPanelProps) {
  const [internalActiveTab, setInternalActiveTab] = useState<PreviewTabType>("preview")
  const [viewport, setViewport] = useState<ViewportSize>("desktop")
  const [copied, setCopied] = useState(false)
  const [previewKey, setPreviewKey] = useState(0)
  const [previewError, setPreviewError] = useState<string | null>(null)
  const [forceBrowserPreview, setForceBrowserPreview] = useState(false)
  const [runtimePreviewError, setRuntimePreviewError] = useState(false)

  // Multi-tab editor tabs
  const [openTabs, setOpenTabs] = useState<string[]>([])

  const activeTab = activeTabProp || internalActiveTab
  const runtimePreviewSandbox = useMemo(
    () => resolveRuntimePreviewSandbox(runtimePreviewUrl),
    [runtimePreviewUrl]
  )
  const isUsingRuntimePreview = Boolean(
    runtimePreviewUrl && !forceBrowserPreview
  )

  const activePath = files[activeFileIndex]?.path || ""

  // Ensure active file is in openTabs
  useEffect(() => {
    if (activePath) {
      setOpenTabs((prev) => {
        if (!prev.includes(activePath)) {
          return [...prev, activePath]
        }
        return prev
      })
    }
  }, [activePath])

  useEffect(() => {
    // If openTabs is empty but files exist, open the first file
    if (openTabs.length === 0 && files.length > 0 && files[0]?.path) {
      setOpenTabs([files[0].path])
    }
  }, [files, openTabs.length])

  useEffect(() => {
    setRuntimePreviewError(false)
  }, [runtimePreviewUrl])

  useEffect(() => {
    setPreviewError(null)
  }, [files, currentVersion])

  useEffect(() => {
    onPreviewErrorChange?.(previewError)
  }, [onPreviewErrorChange, previewError])

  const handleCopy = () => {
    if (files[activeFileIndex]) {
      navigator.clipboard.writeText(files[activeFileIndex].content)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    }
  }

  const handleRefresh = () => {
    setPreviewKey((k) => k + 1)
  }

  const handleOpenPreview = () => {
    if (runtimePreviewUrl) {
      window.open(runtimePreviewUrl, "_blank")
    }
  }

  const handlePreviewError = (error: string) => {
    setPreviewError(error)
  }

  const handleCodeChange = (content: string) => {
    onUpdateFile?.(activeFileIndex, content)
  }

  const handleSelectFilePath = (path: string) => {
    const idx = files.findIndex((f) => normalizePath(f.path) === normalizePath(path))
    if (idx >= 0) {
      onSelectFile?.(idx)
    }
    if (!openTabs.includes(path)) {
      setOpenTabs((prev) => [...prev, path])
    }
  }

  const handleCloseTab = (path: string) => {
    const nextTabs = openTabs.filter((t) => t !== path)
    setOpenTabs(nextTabs)
    if (path === activePath && nextTabs.length > 0) {
      const nextActive = nextTabs[nextTabs.length - 1]
      const idx = files.findIndex((f) => normalizePath(f.path) === normalizePath(nextActive))
      if (idx >= 0) {
        onSelectFile?.(idx)
      }
    }
  }

  const viewportWidths: Record<ViewportSize, string> = {
    mobile: "375px",
    tablet: "768px",
    desktop: "100%",
  }

  const handleTabChange = (tab: PreviewTabType) => {
    if (!activeTabProp) {
      setInternalActiveTab(tab)
    }
    onTabChange?.(tab)
  }

  const isActiveFileLocked = isGenerating && streamLockedPaths.includes(normalizePath(activePath))
  const browserPreviewFiles = useMemo(
    () => buildBrowserPreviewFiles(previewFiles ?? files),
    [files, previewFiles]
  )

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden bg-muted/30">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-border/70 bg-background/80 px-4 py-2 backdrop-blur-xl shrink-0">
        <div className="flex items-center gap-4">
          <Tabs value={activeTab} onValueChange={(v) => handleTabChange(v as PreviewTabType)}>
            <TabsList>
              <TabsTrigger value="preview">Preview</TabsTrigger>
              <TabsTrigger value="code" className="gap-1.5">
                <FileCode className="h-3.5 w-3.5" />
                Code
              </TabsTrigger>
              <TabsTrigger value="terminal" className="gap-1.5">
                <TerminalIcon className="h-3.5 w-3.5 text-emerald-400" />
                Terminal
              </TabsTrigger>
              <TabsTrigger value="explorer" className="gap-1.5">
                <Folder className="h-3.5 w-3.5" />
                Explorer
              </TabsTrigger>
            </TabsList>
          </Tabs>

          {previewError && activeTab === "preview" && (
            <div className="flex items-center gap-2">
              <div className="flex items-center gap-1 text-xs text-destructive">
                <AlertCircle className="h-3.5 w-3.5" />
                <span className="truncate max-w-xs" title={previewError}>Error in preview</span>
              </div>
              <button
                onClick={() => window.alert(previewError)}
                className="text-xs text-destructive underline"
                title="View preview error details"
              >
                View details
              </button>
            </div>
          )}
        </div>

        {activeTab === "preview" && (
          <div className="flex items-center gap-2">
            <div className="flex items-center rounded-full border border-border/70 bg-muted p-1">
              <Button
                variant={viewport === "mobile" ? "secondary" : "ghost"}
                size="icon"
                className="h-7 w-7 rounded-full"
                onClick={() => setViewport("mobile")}
                title="Mobile view"
              >
                <Smartphone className="h-3.5 w-3.5" />
              </Button>
              <Button
                variant={viewport === "tablet" ? "secondary" : "ghost"}
                size="icon"
                className="h-7 w-7 rounded-full"
                onClick={() => setViewport("tablet")}
                title="Tablet view"
              >
                <Tablet className="h-3.5 w-3.5" />
              </Button>
              <Button
                variant={viewport === "desktop" ? "secondary" : "ghost"}
                size="icon"
                className="h-7 w-7 rounded-full"
                onClick={() => setViewport("desktop")}
                title="Desktop view"
              >
                <Monitor className="h-3.5 w-3.5" />
              </Button>
            </div>
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8 rounded-full"
              onClick={handleRefresh}
              title="Refresh preview"
            >
              <RefreshCw className="h-4 w-4" />
            </Button>
            {runtimePreviewUrl && (
              <Button
                variant={isUsingRuntimePreview ? "secondary" : "outline"}
                size="sm"
                className="h-7 text-xs px-2.5 rounded-full font-medium"
                onClick={() => {
                  setForceBrowserPreview((prev) => !prev)
                  setRuntimePreviewError(false)
                }}
                title={
                  isUsingRuntimePreview
                    ? "Beralih ke Browser Sandbox Preview"
                    : "Beralih ke Live Runtime Preview"
                }
              >
                {isUsingRuntimePreview ? "Runtime" : "Browser"}
              </Button>
            )}
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8 rounded-full"
              title="Open in new tab"
              onClick={handleOpenPreview}
              disabled={!runtimePreviewUrl}
            >
              <ExternalLink className="h-4 w-4" />
            </Button>
          </div>
        )}

        {(activeTab === "code" || activeTab === "explorer") && files.length > 0 && (
          <div className="flex items-center gap-2">
            {onSaveFiles && (
              <Button
                size="sm"
                variant={isDirty ? "default" : "outline"}
                onClick={onSaveFiles}
                disabled={!isDirty || isSaving}
              >
                {isSaving ? "Saving..." : isDirty ? "Save Changes" : "Saved"}
              </Button>
            )}
            <Button variant="ghost" size="sm" className="gap-2" onClick={handleCopy}>
              {copied ? (
                <>
                  <Check className="h-4 w-4" />
                  Copied
                </>
              ) : (
                <>
                  <Copy className="h-4 w-4" />
                  Copy
                </>
              )}
            </Button>
          </div>
        )}
      </div>

      {/* Main Content Area */}
      {activeTab === "preview" ? (
        <div className="flex min-h-0 flex-1 items-center justify-center overflow-hidden p-4">
          <div
            className={cn(
              "h-full overflow-hidden rounded-[1.35rem] border border-border/70 bg-background shadow-xl shadow-black/10 transition-all duration-300",
              viewport === "desktop" ? "w-full" : ""
            )}
            style={{ width: viewportWidths[viewport], maxWidth: "100%" }}
          >
            {isUsingRuntimePreview ? (
              <div className="relative h-full w-full">
                {runtimePreviewError && (
                  <div className="absolute top-0 inset-x-0 z-10 bg-amber-500/10 backdrop-blur-sm border-b border-amber-500/20 px-3 py-1.5 text-xs text-amber-500 flex items-center justify-between">
                    <span>Gagal menghubungkan ke runtime sandbox preview.</span>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-6 text-xs px-2 text-amber-400 hover:text-amber-300"
                      onClick={() => {
                        setRuntimePreviewError(false)
                        handleRefresh()
                      }}
                    >
                      Muat Ulang
                    </Button>
                  </div>
                )}
                <iframe
                  key={`${previewKey}:${runtimePreviewUrl}`}
                  src={runtimePreviewUrl || undefined}
                  title="Runtime preview"
                  className="h-full w-full border-0 bg-background"
                  sandbox={runtimePreviewSandbox}
                  referrerPolicy="origin-when-cross-origin"
                  onLoad={() => {
                    setPreviewError(null)
                    setRuntimePreviewError(false)
                  }}
                  onError={() => {
                    setRuntimePreviewError(true)
                  }}
                />
              </div>
            ) : files.length > 0 ? (
              <div className="relative h-full w-full">
                <SandboxPreview
                  key={previewKey}
                  files={browserPreviewFiles}
                  onError={handlePreviewError}
                  projectId={projectId}
                />
              </div>
            ) : isGenerating ? (
              <GeneratingPreview progress={generationProgress} onCancelGeneration={onCancelGeneration} />
            ) : (
              <EmptyPreview />
            )}
          </div>
        </div>
      ) : activeTab === "terminal" ? (
        <div className="flex min-h-0 flex-1 overflow-hidden p-3 bg-background">
          <TerminalPanel
            projectId={projectId || "swift-project"}
            runtimePreviewUrl={runtimePreviewUrl}
            className="w-full h-full"
          />
        </div>
      ) : activeTab === "code" ? (
        <div className="flex min-h-0 flex-1 overflow-hidden bg-background">
          {files.length > 0 ? (
            <div className="flex-1 min-w-0 flex flex-col h-full">
              <MultiTabCodeEditor
                openTabs={openTabs}
                activeFilePath={activePath}
                onSelectTab={handleSelectFilePath}
                onCloseTab={handleCloseTab}
                filePath={activePath}
                code={files[activeFileIndex]?.content || ""}
                onChange={handleCodeChange}
                readOnly={isActiveFileLocked}
                isDirty={isDirty}
              />
            </div>
          ) : (
            <EmptyCode />
          )}
        </div>
      ) : (
        /* Explorer Tab: Full File Manager + Multi-tab Code Editor Side by Side */
        <div className="flex min-h-0 flex-1 overflow-hidden bg-background">
          {files.length > 0 ? (
            <>
              <div className="w-72 shrink-0 border-r border-border h-full">
                <FileManagerExplorer
                  files={files}
                  activeFilePath={activePath}
                  onSelectFile={handleSelectFilePath}
                  onReplaceFiles={onReplaceFiles}
                />
              </div>
              <div className="min-w-0 flex-1 flex flex-col h-full">
                <MultiTabCodeEditor
                  openTabs={openTabs}
                  activeFilePath={activePath}
                  onSelectTab={handleSelectFilePath}
                  onCloseTab={handleCloseTab}
                  filePath={activePath}
                  code={files[activeFileIndex]?.content || ""}
                  onChange={handleCodeChange}
                  readOnly={isActiveFileLocked}
                  isDirty={isDirty}
                />
              </div>
            </>
          ) : (
            <EmptyExplorer />
          )}
        </div>
      )}
    </div>
  )
}

function MultiTabCodeEditor({
  openTabs,
  activeFilePath,
  onSelectTab,
  onCloseTab,
  filePath,
  code,
  onChange,
  readOnly = false,
  isDirty = false,
}: {
  openTabs: string[]
  activeFilePath: string
  onSelectTab: (path: string) => void
  onCloseTab: (path: string) => void
  filePath: string
  code: string
  onChange: (value: string) => void
  readOnly?: boolean
  isDirty?: boolean
}) {
  const language = getMonacoLanguage(filePath)

  return (
    <div className="flex h-full flex-col min-h-0">
      {/* Tab bar */}
      <div className="flex items-center justify-between border-b border-border bg-muted/20 text-xs shrink-0 select-none">
        <div className="flex items-center overflow-x-auto min-w-0 max-w-full divide-x divide-border/60 scrollbar-none">
          {openTabs.map((tabPath) => {
            const isActive = normalizePath(tabPath) === normalizePath(activeFilePath)
            const fileName = tabPath.split("/").pop() || tabPath
            return (
              <div
                key={tabPath}
                onClick={() => onSelectTab(tabPath)}
                className={cn(
                  "group flex items-center gap-2 px-3 py-1.5 cursor-pointer text-xs transition-colors shrink-0",
                  isActive
                    ? "bg-background text-foreground font-medium border-t-2 border-t-primary"
                    : "text-muted-foreground hover:text-foreground hover:bg-muted/40"
                )}
                title={tabPath}
              >
                <FileCode className={cn("h-3.5 w-3.5", isActive ? "text-primary" : "text-muted-foreground")} />
                <span className="truncate max-w-[130px]">{fileName}</span>
                {isActive && isDirty && (
                  <span className="h-1.5 w-1.5 rounded-full bg-amber-400" title="Unsaved changes" />
                )}
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation()
                    onCloseTab(tabPath)
                  }}
                  className="opacity-50 hover:opacity-100 hover:bg-muted p-0.5 rounded transition-opacity"
                  title="Tutup tab"
                >
                  <X className="h-3 w-3" />
                </button>
              </div>
            )
          })}
        </div>

        <div className="flex items-center gap-2 px-3 shrink-0 text-muted-foreground text-[11px] font-mono">
          <span>{filePath}</span>
          {readOnly && <span className="text-amber-500 font-medium">Streaming lock</span>}
        </div>
      </div>

      {/* Editor viewport */}
      <div className="flex-1 min-h-0 relative">
        <MonacoEditor
          key={filePath}
          value={code}
          language={language}
          theme="vs-dark"
          onChange={(value) => onChange(value || "")}
          options={{
            automaticLayout: true,
            minimap: { enabled: false },
            fontSize: 13,
            lineNumbersMinChars: 3,
            scrollBeyondLastLine: false,
            wordWrap: "on",
            tabSize: 2,
            padding: { top: 14, bottom: 14 },
            readOnly,
          }}
        />
      </div>
    </div>
  )
}

function normalizePath(path: string) {
  return path.replace(/\\/g, "/").replace(/^\.\//, "").trim()
}

function getMonacoLanguage(path: string) {
  if (path.endsWith(".tsx") || path.endsWith(".jsx")) return "typescript"
  if (path.endsWith(".ts") || path.endsWith(".js")) return "typescript"
  if (path.endsWith(".py")) return "python"
  if (path.endsWith(".css")) return "css"
  if (path.endsWith(".json")) return "json"
  if (path.endsWith(".html")) return "html"
  if (path.endsWith(".md")) return "markdown"
  if (path.endsWith(".prisma")) return "prisma"
  if (path.includes(".env")) return "shell"
  return "plaintext"
}

function GeneratingPreview({
  progress,
  onCancelGeneration,
}: {
  progress?: GenerationProgress | null
  onCancelGeneration?: () => void
}) {
  const [elapsedMs, setElapsedMs] = useState(() =>
    progress ? Date.now() - progress.startedAt.getTime() : 0
  )

  useEffect(() => {
    if (!progress) return
    const interval = window.setInterval(() => {
      setElapsedMs(Date.now() - progress.startedAt.getTime())
    }, 1000)

    return () => window.clearInterval(interval)
  }, [progress])

  const timeoutSeconds = progress ? Math.ceil(progress.timeoutMs / 1000) : 55
  const displayElapsedMs = progress ? Math.min(elapsedMs, progress.timeoutMs) : elapsedMs
  const elapsedSeconds = Math.max(0, Math.floor(displayElapsedMs / 1000))
  const percent = progress
    ? typeof progress.progressPercent === "number"
      ? Math.max(0, Math.min(100, progress.progressPercent))
      : Math.min(100, Math.round((displayElapsedMs / progress.timeoutMs) * 100))
    : 12

  return (
    <div className="flex h-full flex-col items-center justify-center p-8 text-center">
      <div className="mb-5 flex h-14 w-14 items-center justify-center rounded-2xl border border-sky-500/30 bg-sky-500/10">
        <RefreshCw className="h-7 w-7 animate-spin text-sky-500" />
      </div>
      <h3 className="font-semibold text-foreground">Swift sedang membangun aplikasi</h3>
      <p className="mt-1 max-w-sm text-sm text-muted-foreground">
        {progress?.label || "Menyiapkan request generate..."}
      </p>
      {progress?.statusHint && (
        <p className="mt-2 max-w-sm text-xs leading-relaxed text-muted-foreground">
          {progress.statusHint}
        </p>
      )}
      <div className="mt-5 w-full max-w-sm">
        <div className="mb-2 flex justify-between text-xs text-muted-foreground">
          <span>{progress?.queueState ? progress.queueState.replace(/_/g, " ") : progress?.modelKey || "Swift AI"}</span>
          <span>{percent}%</span>
        </div>
        <div className="h-2 w-full overflow-hidden rounded-full bg-secondary">
          <div
            className="h-full bg-gradient-to-r from-sky-500 to-indigo-500 transition-all duration-300"
            style={{ width: `${percent}%` }}
          />
        </div>
        <div className="mt-2 flex items-center justify-between text-xs text-muted-foreground">
          <span>{elapsedSeconds}s / ~{timeoutSeconds}s</span>
          {onCancelGeneration && (
            <button
              onClick={onCancelGeneration}
              className="text-xs text-muted-foreground hover:text-foreground hover:underline"
            >
              Cancel
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

function EmptyPreview() {
  return (
    <div className="flex h-full w-full flex-col items-center justify-center p-8 text-center">
      <div className="mb-4 flex h-16 w-16 items-center justify-center rounded-2xl border border-border/80 bg-background/50">
        <Monitor className="h-8 w-8 text-muted-foreground" />
      </div>
      <h3 className="font-semibold text-foreground">Preview Belum Tersedia</h3>
      <p className="mt-1 max-w-sm text-sm text-muted-foreground">
        Ketik instruksi di chat untuk menghasilkan aplikasi, atau tulis kode langsung di tab Code/Explorer.
      </p>
    </div>
  )
}

function EmptyCode() {
  return (
    <div className="flex h-full w-full flex-col items-center justify-center p-8 text-center">
      <FileCode className="mb-4 h-12 w-12 text-muted-foreground" />
      <h3 className="font-semibold text-foreground">Belum ada berkas kode</h3>
      <p className="mt-1 max-w-xs text-sm text-muted-foreground">
        Mulai generate kode atau buat berkas baru di tab Explorer.
      </p>
    </div>
  )
}

function EmptyExplorer() {
  return (
    <div className="flex h-full w-full flex-col items-center justify-center p-8 text-center">
      <Folder className="mb-4 h-12 w-12 text-muted-foreground" />
      <h3 className="font-semibold text-foreground">Tidak ada berkas</h3>
      <p className="mt-1 max-w-xs text-sm text-muted-foreground">
        Generate kode atau tambahkan berkas baru dari tombol di atas.
      </p>
    </div>
  )
}

"use client"

import { useState, useCallback, useEffect } from "react"
import dynamic from "next/dynamic"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Button } from "@/components/ui/button"
import { SandboxPreview } from "./sandbox-preview"
import { CodeExplorer } from "./code-explorer"
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
} from "lucide-react"
import { cn } from "@/lib/utils"
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

type ViewportSize = "mobile" | "tablet" | "desktop"

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
  activeTab?: "preview" | "code" | "explorer"
  onTabChange?: (tab: "preview" | "code" | "explorer") => void
  onPreviewErrorChange?: (error: string | null) => void
  isGenerating?: boolean
  generationProgress?: GenerationProgress | null
  onCancelGeneration?: () => void
  projectId?: string
}

export function PreviewPanel({
  files,
  previewFiles = null,
  currentVersion,
  activeFileIndex,
  onSelectFile,
  onViewportChange,
  onUpdateFile,
  onSaveFiles,
  isSaving = false,
  isDirty = false,
  activeTab: activeTabProp,
  onTabChange,
  onPreviewErrorChange,
  isGenerating = false,
  generationProgress = null,
  onCancelGeneration,
  projectId,
}: PreviewPanelProps) {
  const [internalActiveTab, setInternalActiveTab] = useState<"preview" | "code" | "explorer">("preview")
  const [viewport, setViewport] = useState<ViewportSize>("desktop")
  const [activeFile, setActiveFile] = useState(0)
  const [copied, setCopied] = useState(false)
  const [previewKey, setPreviewKey] = useState(0)
  const [previewError, setPreviewError] = useState<string | null>(null)
  const activeTab = activeTabProp || internalActiveTab

  useEffect(() => {
    if (files.length > 0 && activeFile >= files.length) {
      setActiveFile(0)
    }
  }, [activeFile, files.length])

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
    setPreviewError(null)
  }

  const handlePreviewError = useCallback((error: string) => {
    setPreviewError(error)
  }, [])

  useEffect(() => {
    onViewportChange?.(viewport)
  }, [onViewportChange, viewport])

  const handleCodeChange = (content: string) => {
    onUpdateFile?.(activeFileIndex, content)
  }

  const viewportWidths: Record<ViewportSize, string> = {
    mobile: "375px",
    tablet: "768px",
    desktop: "100%",
  }

  const handleTabChange = (tab: "preview" | "code" | "explorer") => {
    if (!activeTabProp) {
      setInternalActiveTab(tab)
    }
    onTabChange?.(tab)
  }

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden bg-muted/30">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-border bg-background px-4 py-2">
        <div className="flex items-center gap-4">
          <Tabs value={activeTab} onValueChange={(v) => handleTabChange(v as "preview" | "code" | "explorer") }>
            <TabsList>
              <TabsTrigger value="preview">Preview</TabsTrigger>
              <TabsTrigger value="code" className="gap-2">
                <FileCode className="h-3.5 w-3.5" />
                Code
              </TabsTrigger>
              <TabsTrigger value="explorer" className="gap-2">
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
            <div className="flex items-center rounded-lg border border-border bg-muted p-1">
              <Button
                variant={viewport === "mobile" ? "secondary" : "ghost"}
                size="icon"
                className="h-7 w-7"
                onClick={() => setViewport("mobile")}
                title="Mobile view"
              >
                <Smartphone className="h-3.5 w-3.5" />
              </Button>
              <Button
                variant={viewport === "tablet" ? "secondary" : "ghost"}
                size="icon"
                className="h-7 w-7"
                onClick={() => setViewport("tablet")}
                title="Tablet view"
              >
                <Tablet className="h-3.5 w-3.5" />
              </Button>
              <Button
                variant={viewport === "desktop" ? "secondary" : "ghost"}
                size="icon"
                className="h-7 w-7"
                onClick={() => setViewport("desktop")}
                title="Desktop view"
              >
                <Monitor className="h-3.5 w-3.5" />
              </Button>
            </div>
            <Button 
              variant="ghost" 
              size="icon" 
              className="h-8 w-8"
              onClick={handleRefresh}
              title="Refresh preview"
            >
              <RefreshCw className="h-4 w-4" />
            </Button>
            <Button variant="ghost" size="icon" className="h-8 w-8" title="Open in new tab">
              <ExternalLink className="h-4 w-4" />
            </Button>
          </div>
        )}

        {activeTab === "code" && files.length > 0 && (
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

      {/* Content */}
      {activeTab === "preview" ? (
        <div className="flex min-h-0 flex-1 items-center justify-center overflow-hidden p-4">
          <div
            className={cn(
              "h-full overflow-hidden rounded-lg border border-border bg-background shadow-lg transition-all duration-300",
              viewport === "desktop" ? "w-full" : ""
            )}
            style={{ width: viewportWidths[viewport], maxWidth: "100%" }}
          >
            {files.length > 0 ? (
              <SandboxPreview 
                key={previewKey}
                files={previewFiles ?? files}
                onError={handlePreviewError}
                projectId={projectId}
              />
            ) : isGenerating ? (
              <GeneratingPreview progress={generationProgress} onCancelGeneration={onCancelGeneration} />
            ) : (
              <EmptyPreview />
            )}
          </div>
        </div>
      ) : activeTab === "code" ? (
        <div className="flex min-h-0 flex-1 overflow-hidden">
          {files.length > 0 ? (
            <div className="flex-1 overflow-auto bg-background">
              <CodeEditor
                filePath={files[activeFileIndex]?.path || ""}
                code={files[activeFileIndex]?.content || ""}
                onChange={handleCodeChange}
              />
            </div>
          ) : (
            <EmptyCode />
          )}
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 overflow-hidden bg-background">
          {files.length > 0 ? (
            <CodeExplorer
              files={files}
              activeFilePath={files[activeFileIndex]?.path}
              onSelectFile={(filePath) => {
                const index = files.findIndex((f) => f.path === filePath)
                if (index >= 0 && onSelectFile) {
                  onSelectFile(index)
                }
              }}
            />
          ) : (
            <EmptyExplorer />
          )}
        </div>
      )}
    </div>
  )
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
      <div className="mt-5 w-full max-w-sm">
        <div className="mb-2 flex justify-between text-xs text-muted-foreground">
          <span>{progress?.modelKey || "Swift AI"}</span>
          <span>{elapsedSeconds}s / {timeoutSeconds}s</span>
        </div>
        <div className="h-2 overflow-hidden rounded-full bg-muted">
          <div className="h-full rounded-full bg-sky-500 transition-all" style={{ width: `${percent}%` }} />
        </div>
      </div>
      {progress?.prompt && (
        <p className="mt-4 line-clamp-2 max-w-md text-xs text-muted-foreground">
          Prompt: {progress.prompt}
        </p>
      )}
      {progress?.workPlan && progress.workPlan.length > 0 && (
        <div className="mt-4 w-full max-w-md rounded-lg border border-border bg-background/70 p-3 text-left">
          <p className="mb-2 text-[11px] font-medium uppercase text-muted-foreground">Rencana Swift</p>
          <div className="grid gap-1.5">
            {progress.workPlan.map((item) => (
              <div key={item} className="flex gap-2 text-xs text-muted-foreground">
                <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-sky-500" />
                <span>{item}</span>
              </div>
            ))}
          </div>
        </div>
      )}
      {onCancelGeneration && progress?.stage !== "cancelled" && (
        <Button
          type="button"
          variant="destructive"
          size="sm"
          className="mt-5 gap-2"
          onClick={onCancelGeneration}
        >
          <Square className="h-4 w-4" />
          Stop generate
        </Button>
      )}
    </div>
  )
}

function EmptyPreview() {
  return (
    <div className="flex h-full flex-col items-center justify-center p-8 text-center">
      <Monitor className="mb-4 h-12 w-12 text-muted-foreground" />
      <h3 className="font-semibold text-foreground">No preview yet</h3>
      <p className="mt-1 max-w-xs text-sm text-muted-foreground">
        Start a conversation to generate your first component
      </p>
    </div>
  )
}

function EmptyCode() {
  return (
    <div className="flex h-full w-full flex-col items-center justify-center p-8 text-center">
      <FileCode className="mb-4 h-12 w-12 text-muted-foreground" />
      <h3 className="font-semibold text-foreground">No code generated</h3>
      <p className="mt-1 max-w-xs text-sm text-muted-foreground">
        Select a file from the explorer to edit it.
      </p>
    </div>
  )
}

function EmptyExplorer() {
  return (
    <div className="flex h-full w-full flex-col items-center justify-center p-8 text-center">
      <Folder className="mb-4 h-12 w-12 text-muted-foreground" />
      <h3 className="font-semibold text-foreground">No files yet</h3>
      <p className="mt-1 max-w-xs text-sm text-muted-foreground">
        Generate code to see files in the explorer
      </p>
    </div>
  )
}

function CodeEditor({
  filePath,
  code,
  onChange,
}: {
  filePath: string
  code: string
  onChange: (value: string) => void
}) {
  const language = getMonacoLanguage(filePath)

  return (
    <div className="flex h-full flex-col">
      <div className="border-b border-border px-4 py-2 text-xs text-muted-foreground">
        {filePath}
      </div>
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
        }}
      />
    </div>
  )
}

function getMonacoLanguage(path: string) {
  if (path.endsWith(".tsx") || path.endsWith(".jsx")) return "typescript"
  if (path.endsWith(".ts") || path.endsWith(".js")) return "typescript"
  if (path.endsWith(".css")) return "css"
  if (path.endsWith(".json")) return "json"
  if (path.endsWith(".html")) return "html"
  if (path.endsWith(".md")) return "markdown"
  if (path.endsWith(".prisma")) return "prisma"
  if (path.includes(".env")) return "shell"
  return "plaintext"
}

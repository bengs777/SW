"use client"

import { useState, useCallback, useEffect } from "react"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Button } from "@/components/ui/button"
import { SandboxPreview } from "./sandbox-preview"
import { FileExplorer } from "./file-explorer"
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
  FilePlus2,
  Trash2,
  ChevronRight,
  ChevronDown,
  Folder,
} from "lucide-react"
import { cn } from "@/lib/utils"
import type { GeneratedFile } from "@/lib/types"
import { buildBrowserPreviewFiles } from "@/lib/preview/sanitizer"

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
}: PreviewPanelProps) {
  const [internalActiveTab, setInternalActiveTab] = useState<"preview" | "code" | "explorer">("preview")
  const [viewport, setViewport] = useState<ViewportSize>("desktop")
  const [activeFile, setActiveFile] = useState(0)
  const [copied, setCopied] = useState(false)
  const [previewKey, setPreviewKey] = useState(0)
  const [previewError, setPreviewError] = useState<string | null>(null)
  const [expandedFolders, setExpandedFolders] = useState<string[]>(["app", "lib", "prisma"])
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

  const handleToggleFolder = (folderPath: string) => {
    setExpandedFolders((current) =>
      current.includes(folderPath)
        ? current.filter((path) => path !== folderPath)
        : [...current, folderPath]
    )
  }

  const handleCreateFile = () => {
    if (!onReplaceFiles) return

    const rawPath = window.prompt("New file path (example: app/about/page.tsx)")
    if (!rawPath) return

    const filePath = rawPath.trim().replace(/\\/g, "/")
    if (!filePath) return

    if (files.some((file) => file.path.toLowerCase() === filePath.toLowerCase())) {
      window.alert("A file with this path already exists.")
      return
    }

    const newFile: GeneratedFile = {
      path: filePath,
      content: getDefaultContentForPath(filePath),
      language: inferLanguageFromPath(filePath),
    }

    const nextFiles = [...files, newFile]
    onReplaceFiles(nextFiles)
    setActiveFile(nextFiles.length - 1)

    const folders = getFolderSegments(filePath)
    if (folders.length > 0) {
      setExpandedFolders((current) => {
        const merged = [...current]
        for (const folderPath of folders) {
          if (!merged.includes(folderPath)) {
            merged.push(folderPath)
          }
        }
        return merged
      })
    }
  }

  const handleDeleteActiveFile = () => {
    if (!onReplaceFiles || files.length === 0 || !files[activeFile]) return

    const fileToDelete = files[activeFile]
    const shouldDelete = window.confirm(`Delete file "${fileToDelete.path}"?`)
    if (!shouldDelete) return

    const nextFiles = files.filter((_, index) => index !== activeFile)
    onReplaceFiles(nextFiles)
    setActiveFile((current) => Math.max(0, Math.min(current, nextFiles.length - 1)))
  }

  const viewportWidths: Record<ViewportSize, string> = {
    mobile: "375px",
    tablet: "768px",
    desktop: "100%",
  }

  const fileTree = buildFileTree(files)

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
                files={previewFiles ?? buildBrowserPreviewFiles(files)} 
                onError={handlePreviewError}
              />
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
  return (
    <div className="flex h-full flex-col">
      <div className="border-b border-border px-4 py-2 text-xs text-muted-foreground">
        {filePath}
      </div>
      <textarea
        value={code}
        onChange={(event) => onChange(event.target.value)}
        spellCheck={false}
        className="h-full w-full resize-none bg-background p-4 font-mono text-sm leading-relaxed text-foreground outline-none"
      />
    </div>
  )
}

type TreeNodeData = {
  path: string
  name: string
  type: "folder" | "file"
  children: TreeNodeData[]
}

function TreeNode({
  node,
  files,
  activeFileIndex,
  expandedFolders,
  onToggleFolder,
  onSelectFile,
  depth = 0,
}: {
  node: TreeNodeData
  files: GeneratedFile[]
  activeFileIndex: number
  expandedFolders: string[]
  onToggleFolder: (folderPath: string) => void
  onSelectFile: (index: number) => void
  depth?: number
}) {
  const isFolder = node.type === "folder"
  const isExpanded = expandedFolders.includes(node.path)
  const fileIndex = files.findIndex((file) => file.path === node.path)
  const isActive = fileIndex === activeFileIndex

  if (isFolder) {
    return (
      <div>
        <button
          onClick={() => onToggleFolder(node.path)}
          className="flex w-full items-center gap-1 rounded-lg px-2 py-1.5 text-left text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          style={{ paddingLeft: `${8 + depth * 14}px` }}
        >
          {isExpanded ? (
            <ChevronDown className="h-3.5 w-3.5 shrink-0" />
          ) : (
            <ChevronRight className="h-3.5 w-3.5 shrink-0" />
          )}
          <Folder className="h-4 w-4 shrink-0" />
          <span className="truncate">{node.name}</span>
        </button>
        {isExpanded &&
          node.children.map((child) => (
            <TreeNode
              key={child.path}
              node={child}
              files={files}
              activeFileIndex={activeFileIndex}
              expandedFolders={expandedFolders}
              onToggleFolder={onToggleFolder}
              onSelectFile={onSelectFile}
              depth={depth + 1}
            />
          ))}
      </div>
    )
  }

  return (
    <button
      onClick={() => onSelectFile(fileIndex)}
      className={cn(
        "flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm transition-colors",
        isActive
          ? "bg-secondary text-secondary-foreground"
          : "text-muted-foreground hover:bg-muted hover:text-foreground"
      )}
      style={{ paddingLeft: `${24 + depth * 14}px` }}
    >
      <FileCode className="h-4 w-4 shrink-0" />
      <span className="truncate">{node.name}</span>
    </button>
  )
}

function buildFileTree(files: GeneratedFile[]): TreeNodeData[] {
  const root: TreeNodeData = {
    path: "__root__",
    name: "__root__",
    type: "folder",
    children: [],
  }

  for (const file of files) {
    const segments = file.path.split("/").filter(Boolean)
    let current = root
    let currentPath = ""

    segments.forEach((segment, index) => {
      currentPath = currentPath ? `${currentPath}/${segment}` : segment
      const isFile = index === segments.length - 1
      const type: "folder" | "file" = isFile ? "file" : "folder"

      let node = current.children.find(
        (child) => child.name === segment && child.type === type
      )

      if (!node) {
        node = {
          path: isFile ? file.path : currentPath,
          name: segment,
          type,
          children: [],
        }
        current.children.push(node)
      }

      current = node
    })
  }

  sortTreeNodes(root.children)
  return root.children
}

function sortTreeNodes(nodes: TreeNodeData[]) {
  nodes.sort((a, b) => {
    if (a.type !== b.type) {
      return a.type === "folder" ? -1 : 1
    }
    return a.name.localeCompare(b.name)
  })

  for (const node of nodes) {
    if (node.children.length > 0) {
      sortTreeNodes(node.children)
    }
  }
}

function inferLanguageFromPath(path: string): GeneratedFile["language"] {
  if (path.endsWith(".tsx")) return "tsx"
  if (path.endsWith(".ts")) return "ts"
  if (path.endsWith(".css")) return "css"
  if (path.endsWith(".json")) return "json"
  if (path.endsWith(".html")) return "html"
  if (path.endsWith(".prisma")) return "prisma"
  if (path.endsWith(".md")) return "md"
  if (path.endsWith(".env")) return "env"
  return "ts"
}

function getDefaultContentForPath(path: string) {
  const fileName = path.split("/").pop() || path

  if (path.endsWith(".tsx")) {
    const componentName = toPascalCase(fileName.replace(/\.tsx$/, "")) || "NewComponent"
    return `export default function ${componentName}() {\n  return (\n    <div className="p-6">\n      <h1 className="text-2xl font-semibold">${componentName}</h1>\n    </div>\n  )\n}\n`
  }

  if (path.endsWith(".ts")) {
    return `export function ${toCamelCase(fileName.replace(/\.ts$/, "")) || "newFunction"}() {\n  return true\n}\n`
  }

  if (path.endsWith(".css")) {
    return `:root {\n  color-scheme: dark;\n}\n`
  }

  if (path.endsWith(".json")) {
    return `{\n  "name": "${fileName.replace(/\.json$/, "")}"\n}\n`
  }

  if (path.endsWith(".md")) {
    return `# ${fileName.replace(/\.md$/, "")}\n\nDocument your module here.\n`
  }

  if (path.endsWith(".prisma")) {
    return `generator client {\n  provider = "prisma-client-js"\n  previewFeatures = ["driverAdapters"]\n}\n\n` +
      `datasource db {\n  provider = "sqlite"\n  url      = env("TURSO_DATABASE_URL")\n}\n`
  }

  if (path.endsWith(".env")) {
    return `NEXT_PUBLIC_APP_NAME=swift\n`
  }

  return ""
}

function getFolderSegments(path: string) {
  const segments = path.split("/").filter(Boolean)
  if (segments.length <= 1) return []

  const folders: string[] = []
  let current = ""
  for (const segment of segments.slice(0, -1)) {
    current = current ? `${current}/${segment}` : segment
    folders.push(current)
  }
  return folders
}

function toPascalCase(value: string) {
  return value
    .split(/[-_\s.]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join("")
}

function toCamelCase(value: string) {
  const pascal = toPascalCase(value)
  return pascal ? pascal.charAt(0).toLowerCase() + pascal.slice(1) : ""
}

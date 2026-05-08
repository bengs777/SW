"use client"

import { useState, useMemo } from "react"
import { ChevronRight, ChevronDown, File, Folder, Search } from "lucide-react"
import { Input } from "@/components/ui/input"
import { ScrollArea } from "@/components/ui/scroll-area"
import { cn } from "@/lib/utils"
import type { GeneratedFile } from "@/lib/types"

interface CodeExplorerProps {
  files: GeneratedFile[]
  activeFilePath?: string
  onSelectFile?: (path: string) => void
}

interface FileNode {
  name: string
  path: string
  type: "file" | "folder"
  children?: FileNode[]
}

export function CodeExplorer({
  files,
  activeFilePath,
  onSelectFile,
}: CodeExplorerProps) {
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(
    new Set(["app", "components", "lib"])
  )
  const [searchQuery, setSearchQuery] = useState("")

  // Build file tree structure
  const fileTree = useMemo(() => {
    const root: FileNode = { name: "root", path: "/", type: "folder", children: [] }

    files.forEach((file) => {
      const parts = file.path.split("/").filter(Boolean)
      let current = root

      parts.forEach((part, index) => {
        const isLast = index === parts.length - 1
        const path = parts.slice(0, index + 1).join("/")

        if (!current.children) {
          current.children = []
        }

        let node = current.children.find((n) => n.path === path)

        if (!node) {
          node = {
            name: part,
            path,
            type: isLast ? "file" : "folder",
            children: isLast ? undefined : [],
          }
          current.children.push(node)
        }

        if (!isLast) {
          current = node
        }
      })
    })

    // Sort children: folders first, then files
    const sortNode = (node: FileNode) => {
      if (node.children) {
        node.children.sort((a, b) => {
          if (a.type === b.type) return a.name.localeCompare(b.name)
          return a.type === "folder" ? -1 : 1
        })
        node.children.forEach(sortNode)
      }
    }

    sortNode(root)
    return root
  }, [files])

  // Filter files by search query
  const filteredFiles = useMemo(() => {
    if (!searchQuery.trim()) return null

    return files.filter((file) =>
      file.path.toLowerCase().includes(searchQuery.toLowerCase())
    )
  }, [files, searchQuery])

  const toggleFolder = (path: string) => {
    setExpandedFolders((prev) => {
      const next = new Set(prev)
      if (next.has(path)) {
        next.delete(path)
      } else {
        next.add(path)
      }
      return next
    })
  }

  const renderNode = (node: FileNode, depth: number = 0) => {
    if (node.type === "folder") {
      const isExpanded = expandedFolders.has(node.path)
      const hasChildren = node.children && node.children.length > 0

      return (
        <div key={node.path}>
          <button
            onClick={() => toggleFolder(node.path)}
            className="w-full flex items-center gap-1 px-2 py-1 text-sm hover:bg-secondary rounded transition-colors text-muted-foreground hover:text-foreground"
            style={{ paddingLeft: `${depth * 16 + 8}px` }}
          >
            {hasChildren ? (
              isExpanded ? (
                <ChevronDown className="h-4 w-4" />
              ) : (
                <ChevronRight className="h-4 w-4" />
              )
            ) : (
              <div className="w-4" />
            )}
            <Folder className="h-4 w-4" />
            <span>{node.name}</span>
          </button>

          {isExpanded && hasChildren && (
            <div>
              {node.children!.map((child) => renderNode(child, depth + 1))}
            </div>
          )}
        </div>
      )
    }

    // File node
    const isActive = activeFilePath === node.path
    const file = files.find((f) => f.path === node.path)
    const lineCount = file ? file.content.split("\n").length : 0

    return (
      <button
        key={node.path}
        onClick={() => onSelectFile?.(node.path)}
        className={cn(
          "w-full flex items-center gap-2 px-2 py-1.5 text-sm rounded transition-colors",
          isActive
            ? "bg-primary text-primary-foreground"
            : "text-foreground hover:bg-secondary"
        )}
        style={{ paddingLeft: `${depth * 16 + 8}px` }}
        title={`${node.path} (${lineCount} lines)`}
      >
        <File className="h-4 w-4 shrink-0" />
        <span className="flex-1 text-left truncate">{node.name}</span>
        <span className="text-xs text-muted-foreground ml-auto">
          {lineCount}
        </span>
      </button>
    )
  }

  return (
    <div className="flex flex-col h-full gap-3 p-4">
      <div>
        <div className="relative">
          <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Cari file..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="pl-8 h-8 text-xs"
          />
        </div>
      </div>

      <ScrollArea className="flex-1">
        <div className="pr-4">
          {filteredFiles ? (
            // Show search results
            <div className="space-y-1">
              {filteredFiles.length === 0 ? (
                <p className="text-xs text-muted-foreground p-2">
                  Tidak ada file yang cocok
                </p>
              ) : (
                filteredFiles.map((file) => {
                  const isActive = activeFilePath === file.path
                  const lineCount = file.content.split("\n").length

                  return (
                    <button
                      key={file.path}
                      onClick={() => onSelectFile?.(file.path)}
                      className={cn(
                        "w-full flex items-center gap-2 px-2 py-1.5 text-xs rounded transition-colors text-left",
                        isActive
                          ? "bg-primary text-primary-foreground"
                          : "text-foreground hover:bg-secondary"
                      )}
                      title={`${file.path} (${lineCount} lines)`}
                    >
                      <File className="h-3 w-3 shrink-0" />
                      <span className="flex-1 truncate">{file.path}</span>
                      <span className="text-muted-foreground ml-auto">
                        {lineCount}
                      </span>
                    </button>
                  )
                })
              )}
            </div>
          ) : (
            // Show tree view
            <div className="space-y-0.5">
              {fileTree.children?.map((node) => renderNode(node))}
            </div>
          )}
        </div>
      </ScrollArea>

      {/* File stats */}
      <div className="text-xs text-muted-foreground border-t border-border pt-2 space-y-1">
        <div>Total files: {files.length}</div>
        <div>
          Total lines:{" "}
          {files.reduce((sum, f) => sum + f.content.split("\n").length, 0)}
        </div>
      </div>
    </div>
  )
}

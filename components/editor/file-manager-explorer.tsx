"use client"

import { useState, useMemo, useRef } from "react"
import {
  ChevronRight,
  ChevronDown,
  File,
  Folder,
  Search,
  Plus,
  Trash2,
  Edit2,
  Upload,
  FolderPlus,
  FilePlus,
  MoreVertical,
} from "lucide-react"
import { Input } from "@/components/ui/input"
import { Button } from "@/components/ui/button"
import { ScrollArea } from "@/components/ui/scroll-area"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu"
import { cn } from "@/lib/utils"
import type { GeneratedFile } from "@/lib/types"

interface FileManagerExplorerProps {
  files: GeneratedFile[]
  activeFilePath?: string
  onSelectFile?: (path: string) => void
  onReplaceFiles?: (files: GeneratedFile[]) => void
}

interface FileNode {
  name: string
  path: string
  type: "file" | "folder"
  children?: FileNode[]
}

function normalizePath(path: string) {
  return path.replace(/\\/g, "/").replace(/^\.\//, "").replace(/^\/+/, "").trim()
}

function inferLanguage(path: string): GeneratedFile["language"] {
  const ext = path.split(".").pop()?.toLowerCase() || ""
  if (ext === "tsx") return "tsx"
  if (ext === "ts" || ext === "js" || ext === "jsx" || ext === "py") return "ts"
  if (ext === "css") return "css"
  if (ext === "html") return "html"
  if (ext === "json") return "json"
  if (ext === "md") return "md"
  if (ext === "prisma") return "prisma"
  if (path.includes(".env")) return "env"
  return "ts"
}

export function FileManagerExplorer({
  files,
  activeFilePath,
  onSelectFile,
  onReplaceFiles,
}: FileManagerExplorerProps) {
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(
    new Set(["app", "components", "lib", "src", "public"])
  )
  const [searchQuery, setSearchQuery] = useState("")
  const fileInputRef = useRef<HTMLInputElement>(null)

  // Build tree structure
  const fileTree = useMemo(() => {
    const root: FileNode = { name: "root", path: "", type: "folder", children: [] }

    files.forEach((file) => {
      const parts = normalizePath(file.path).split("/").filter(Boolean)
      let current = root

      parts.forEach((part, index) => {
        const isLast = index === parts.length - 1
        const currentPath = parts.slice(0, index + 1).join("/")

        if (!current.children) {
          current.children = []
        }

        let node = current.children.find((n) => n.path === currentPath)

        if (!node) {
          node = {
            name: part,
            path: currentPath,
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

  // File CRUD Operations
  const handleCreateFile = (baseFolder = "") => {
    if (!onReplaceFiles) return
    const defaultName = baseFolder ? `${baseFolder}/new-file.tsx` : "app/new-file.tsx"
    const rawPath = window.prompt("Nama berkas baru (contoh: app/about/page.tsx atau main.py):", defaultName)
    if (!rawPath) return

    const filePath = normalizePath(rawPath)
    if (!filePath) return

    if (files.some((f) => normalizePath(f.path).toLowerCase() === filePath.toLowerCase())) {
      window.alert("Berkas dengan nama ini sudah ada.")
      return
    }

    const newFile: GeneratedFile = {
      path: filePath,
      content: filePath.endsWith(".py")
        ? "# Python script\nprint('Hello from Swift!')\n"
        : filePath.endsWith(".json")
        ? "{\n  \n}\n"
        : filePath.endsWith(".html")
        ? "<!DOCTYPE html>\n<html>\n<head><title>App</title></head>\n<body>\n  <h1>Hello</h1>\n</body>\n</html>\n"
        : `export default function ${filePath.split("/").pop()?.replace(/[^a-zA-Z0-9]/g, "") || "Component"}() {\n  return <div>New Component</div>\n}\n`,
      language: inferLanguage(filePath),
    }

    const nextFiles = [...files, newFile]
    onReplaceFiles(nextFiles)
    onSelectFile?.(filePath)
  }

  const handleCreateFolder = (baseFolder = "") => {
    if (!onReplaceFiles) return
    const defaultName = baseFolder ? `${baseFolder}/new-folder` : "components/ui"
    const rawPath = window.prompt("Nama folder baru (contoh: backend atau static):", defaultName)
    if (!rawPath) return

    const folderPath = normalizePath(rawPath)
    if (!folderPath) return

    // Create a .gitkeep or index file inside the folder so it persists
    const placeholderPath = `${folderPath}/.keep`
    if (files.some((f) => normalizePath(f.path) === placeholderPath)) return

    const nextFiles: GeneratedFile[] = [
      ...files,
      {
        path: placeholderPath,
        content: "",
        language: "ts",
      },
    ]

    setExpandedFolders((prev) => new Set([...prev, folderPath]))
    onReplaceFiles(nextFiles)
  }

  const handleRename = (targetPath: string) => {
    if (!onReplaceFiles) return
    const rawPath = window.prompt("Ganti nama path berkas:", targetPath)
    if (!rawPath) return

    const newPath = normalizePath(rawPath)
    if (!newPath || newPath === targetPath) return

    if (files.some((f) => normalizePath(f.path).toLowerCase() === newPath.toLowerCase() && normalizePath(f.path) !== targetPath)) {
      window.alert("Berkas dengan nama tersebut sudah ada.")
      return
    }

    const nextFiles = files.map((f) => {
      const normalized = normalizePath(f.path)
      if (normalized === targetPath) {
        return {
          ...f,
          path: newPath,
          language: inferLanguage(newPath),
        }
      }
      // If it was a folder rename, rename all children
      if (normalized.startsWith(`${targetPath}/`)) {
        const relative = normalized.slice(targetPath.length + 1)
        return {
          ...f,
          path: `${newPath}/${relative}`,
        }
      }
      return f
    })

    onReplaceFiles(nextFiles)
    if (activeFilePath === targetPath) {
      onSelectFile?.(newPath)
    }
  }

  const handleDelete = (targetPath: string, isFolder: boolean) => {
    if (!onReplaceFiles) return
    const confirmed = window.confirm(`Apakah Anda yakin ingin menghapus ${isFolder ? "folder" : "berkas"} "${targetPath}"?`)
    if (!confirmed) return

    const nextFiles = files.filter((f) => {
      const normalized = normalizePath(f.path)
      if (isFolder) {
        return normalized !== targetPath && !normalized.startsWith(`${targetPath}/`)
      }
      return normalized !== targetPath
    })

    onReplaceFiles(nextFiles)
    if (activeFilePath === targetPath && nextFiles.length > 0) {
      onSelectFile?.(nextFiles[0].path)
    }
  }

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const uploadedFiles = e.target.files
    if (!uploadedFiles || uploadedFiles.length === 0 || !onReplaceFiles) return

    Array.from(uploadedFiles).forEach((file) => {
      const reader = new FileReader()
      reader.onload = () => {
        const content = typeof reader.result === "string" ? reader.result : ""
        const filePath = `public/${file.name}`
        const nextFiles: GeneratedFile[] = files.filter((f) => normalizePath(f.path) !== filePath)
        nextFiles.push({
          path: filePath,
          content,
          language: inferLanguage(filePath),
        })
        onReplaceFiles(nextFiles)
        onSelectFile?.(filePath)
      }
      reader.readAsText(file)
    })

    if (fileInputRef.current) {
      fileInputRef.current.value = ""
    }
  }

  // Filtered files for search
  const filteredFiles = useMemo(() => {
    if (!searchQuery.trim()) return null
    return files.filter((f) => normalizePath(f.path).toLowerCase().includes(searchQuery.toLowerCase()))
  }, [files, searchQuery])

  const renderNode = (node: FileNode, depth = 0) => {
    if (node.type === "folder") {
      const isExpanded = expandedFolders.has(node.path)
      const hasChildren = node.children && node.children.length > 0

      return (
        <div key={node.path} className="group/folder select-none">
          <div
            className="flex items-center justify-between py-1 px-1.5 hover:bg-muted/40 rounded transition-colors text-xs text-muted-foreground hover:text-foreground cursor-pointer"
            style={{ paddingLeft: `${depth * 14 + 6}px` }}
            onClick={() => toggleFolder(node.path)}
          >
            <div className="flex items-center gap-1.5 min-w-0 flex-1">
              {hasChildren ? (
                isExpanded ? (
                  <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                ) : (
                  <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                )
              ) : (
                <div className="w-3.5" />
              )}
              <Folder className="h-3.5 w-3.5 shrink-0 text-amber-500/80" />
              <span className="truncate font-medium">{node.name}</span>
            </div>

            {/* Folder Actions */}
            <div className="opacity-0 group-hover/folder:opacity-100 flex items-center gap-0.5 shrink-0" onClick={(e) => e.stopPropagation()}>
              <Button
                size="sm"
                variant="ghost"
                className="h-5 w-5 p-0"
                onClick={() => handleCreateFile(node.path)}
                title="Tambah berkas di folder ini"
              >
                <Plus className="h-3 w-3" />
              </Button>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button size="sm" variant="ghost" className="h-5 w-5 p-0">
                    <MoreVertical className="h-3 w-3" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="text-xs">
                  <DropdownMenuItem onClick={() => handleCreateFile(node.path)}>
                    <FilePlus className="h-3.5 w-3.5 mr-2" /> Buat Berkas
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => handleCreateFolder(node.path)}>
                    <FolderPlus className="h-3.5 w-3.5 mr-2" /> Buat Subfolder
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => handleRename(node.path)}>
                    <Edit2 className="h-3.5 w-3.5 mr-2" /> Ganti Nama
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onClick={() => handleDelete(node.path, true)} className="text-destructive">
                    <Trash2 className="h-3.5 w-3.5 mr-2" /> Hapus Folder
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          </div>

          {isExpanded && hasChildren && (
            <div>
              {node.children!.map((child) => renderNode(child, depth + 1))}
            </div>
          )}
        </div>
      )
    }

    // File node
    const isNodeActive = normalizePath(activeFilePath || "") === normalizePath(node.path)

    return (
      <div
        key={node.path}
        className={cn(
          "group/file flex items-center justify-between py-1 px-1.5 rounded transition-colors text-xs cursor-pointer select-none",
          isNodeActive
            ? "bg-primary text-primary-foreground font-medium"
            : "text-muted-foreground hover:text-foreground hover:bg-muted/40"
        )}
        style={{ paddingLeft: `${depth * 14 + 18}px` }}
        onClick={() => onSelectFile?.(node.path)}
      >
        <div className="flex items-center gap-1.5 min-w-0 flex-1 truncate">
          <File className={cn("h-3.5 w-3.5 shrink-0", isNodeActive ? "text-primary-foreground" : "text-sky-400/80")} />
          <span className="truncate">{node.name}</span>
        </div>

        {/* File Actions */}
        <div className="opacity-0 group-hover/file:opacity-100 flex items-center gap-0.5 shrink-0" onClick={(e) => e.stopPropagation()}>
          <Button
            size="sm"
            variant="ghost"
            className={cn("h-5 w-5 p-0", isNodeActive ? "text-primary-foreground hover:bg-primary/80" : "")}
            onClick={() => handleRename(node.path)}
            title="Ganti nama berkas"
          >
            <Edit2 className="h-3 w-3" />
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className={cn("h-5 w-5 p-0 text-destructive hover:bg-destructive/10", isNodeActive ? "text-white" : "")}
            onClick={() => handleDelete(node.path, false)}
            title="Hapus berkas"
          >
            <Trash2 className="h-3 w-3" />
          </Button>
        </div>
      </div>
    )
  }

  return (
    <div className="flex flex-col h-full bg-card border-r border-border/70 select-none">
      {/* Header with Action Toolbar */}
      <div className="p-2 border-b border-border/70 space-y-2">
        <div className="flex items-center justify-between">
          <span className="text-xs font-semibold text-foreground tracking-wide uppercase">Workspace Files</span>
          <div className="flex items-center gap-1">
            <Button
              size="sm"
              variant="ghost"
              onClick={() => handleCreateFile("")}
              className="h-6 w-6 p-0"
              title="Buat Berkas Baru"
            >
              <FilePlus className="h-3.5 w-3.5" />
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => handleCreateFolder("")}
              className="h-6 w-6 p-0"
              title="Buat Folder Baru"
            >
              <FolderPlus className="h-3.5 w-3.5" />
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => fileInputRef.current?.click()}
              className="h-6 w-6 p-0"
              title="Upload Berkas"
            >
              <Upload className="h-3.5 w-3.5" />
            </Button>
            <input
              type="file"
              ref={fileInputRef}
              onChange={handleFileUpload}
              className="hidden"
              multiple
            />
          </div>
        </div>

        {/* Search input */}
        <div className="relative">
          <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
          <Input
            placeholder="Cari berkas..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="pl-7 h-7 text-xs bg-muted/30 border-border/60"
          />
        </div>
      </div>

      {/* Files List */}
      <ScrollArea className="flex-1 min-h-0">
        <div className="p-1 space-y-0.5">
          {filteredFiles ? (
            filteredFiles.length === 0 ? (
              <div className="p-4 text-center text-xs text-muted-foreground">Tidak ada berkas cocok.</div>
            ) : (
              filteredFiles.map((file) => {
                const isActive = normalizePath(activeFilePath || "") === normalizePath(file.path)
                return (
                  <div
                    key={file.path}
                    onClick={() => onSelectFile?.(file.path)}
                    className={cn(
                      "flex items-center justify-between py-1 px-2 rounded text-xs cursor-pointer truncate",
                      isActive ? "bg-primary text-primary-foreground font-medium" : "text-muted-foreground hover:bg-muted/40"
                    )}
                  >
                    <div className="flex items-center gap-1.5 truncate">
                      <File className="h-3.5 w-3.5 shrink-0" />
                      <span className="truncate">{file.path}</span>
                    </div>
                  </div>
                )
              })
            )
          ) : (
            fileTree.children?.map((node) => renderNode(node))
          )}
        </div>
      </ScrollArea>

      {/* Footer statistics */}
      <div className="p-2 border-t border-border/70 text-[11px] text-muted-foreground flex items-center justify-between">
        <span>{files.length} berkas</span>
        <button
          onClick={() => handleCreateFile("")}
          className="hover:text-foreground hover:underline"
        >
          + Berkas baru
        </button>
      </div>
    </div>
  )
}

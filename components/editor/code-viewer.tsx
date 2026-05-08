"use client"

import { useState } from "react"
import { Copy, Check, Maximize2, X } from "lucide-react"
import { Button } from "@/components/ui/button"
import { ScrollArea } from "@/components/ui/scroll-area"
import { cn } from "@/lib/utils"
import type { GeneratedFile } from "@/lib/types"

interface CodeViewerProps {
  file: GeneratedFile
  onClose?: () => void
  isFullscreen?: boolean
}

export function CodeViewer({
  file,
  onClose,
  isFullscreen = false,
}: CodeViewerProps) {
  const [copied, setCopied] = useState(false)

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(file.content)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch (error) {
      console.error("Failed to copy:", error)
    }
  }

  const lines = file.content.split("\n")
  const lineCount = lines.length

  return (
    <div className={cn(
      "flex flex-col gap-3 p-4 bg-card rounded-lg border border-border",
      isFullscreen && "fixed inset-0 z-50 rounded-none"
    )}>
      {/* Header */}
      <div className="flex items-center justify-between gap-2 border-b border-border pb-3">
        <div className="flex items-center gap-3 flex-1 min-w-0">
          <div className="flex-1 min-w-0">
            <h3 className="font-mono text-sm font-semibold text-foreground truncate">
              {file.path}
            </h3>
            <p className="text-xs text-muted-foreground">
              {file.language.toUpperCase()} • {lineCount} baris
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          <Button
            size="sm"
            variant="ghost"
            onClick={handleCopy}
            title="Salin kode"
            className="gap-1"
          >
            {copied ? (
              <Check className="h-4 w-4 text-green-500" />
            ) : (
              <Copy className="h-4 w-4" />
            )}
            <span className="text-xs">{copied ? "Tersalin" : "Salin"}</span>
          </Button>

          {isFullscreen && onClose && (
            <Button
              size="sm"
              variant="ghost"
              onClick={onClose}
              title="Tutup"
            >
              <X className="h-4 w-4" />
            </Button>
          )}
        </div>
      </div>

      {/* Code */}
      <ScrollArea className="flex-1 overflow-hidden">
        <div className="font-mono text-xs">
          <div className="inline-block min-w-full">
            {lines.map((line, index) => (
              <div
                key={index}
                className="flex gap-3 hover:bg-secondary/50 transition-colors"
              >
                {/* Line number */}
                <div className="flex-shrink-0 w-12 text-right text-muted-foreground select-none bg-secondary/20 px-2 py-0">
                  {index + 1}
                </div>

                {/* Code line */}
                <div className="flex-1 py-0 px-3 text-foreground overflow-x-auto">
                  {line === "" ? "\u00A0" : line}
                </div>
              </div>
            ))}
          </div>
        </div>
      </ScrollArea>
    </div>
  )
}

"use client"

import { AlertTriangle, Trash2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Badge } from "@/components/ui/badge"

type ErrorLogSource = "project" | "provider" | "generate" | "preview" | "save" | "export" | "deploy"

type ErrorLogEntry = {
  id: string
  source: ErrorLogSource
  message: string
  timestamp: Date
}

interface ErrorLogPanelProps {
  logs: ErrorLogEntry[]
  onClear?: () => void
}

const sourceLabel: Record<ErrorLogSource, string> = {
  project: "Project",
  provider: "Provider",
  generate: "Generate",
  preview: "Preview",
  save: "Save",
  export: "Export",
  deploy: "Deploy",
}

export function ErrorLogPanel({ logs, onClear }: ErrorLogPanelProps) {
  return (
    <div className="flex h-full min-h-0 flex-col border-l border-border bg-background">
      <div className="flex items-center justify-between border-b border-border px-3 py-2">
        <div className="flex items-center gap-2">
          <AlertTriangle className="h-4 w-4 text-destructive" />
          <p className="text-sm font-medium">Error Log</p>
          <Badge variant="secondary" className="text-xs">
            {logs.length}
          </Badge>
        </div>
        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8"
          onClick={onClear}
          disabled={logs.length === 0}
          title="Clear logs"
        >
          <Trash2 className="h-4 w-4" />
        </Button>
      </div>

      <ScrollArea className="min-h-0 flex-1">
        {logs.length === 0 ? (
          <div className="p-3 text-xs text-muted-foreground">
            Belum ada error.
          </div>
        ) : (
          <div className="space-y-2 p-3">
            {logs.map((log) => (
              <article key={log.id} className="rounded-md border border-border bg-muted/40 p-2">
                <div className="mb-1 flex items-center justify-between gap-2">
                  <Badge variant="outline" className="text-[10px] uppercase tracking-wide">
                    {sourceLabel[log.source]}
                  </Badge>
                  <span className="text-[10px] text-muted-foreground">
                    {new Date(log.timestamp).toLocaleTimeString("id-ID", {
                      hour: "2-digit",
                      minute: "2-digit",
                      second: "2-digit",
                    })}
                  </span>
                </div>
                <p className="line-clamp-6 whitespace-pre-wrap break-words text-xs text-foreground/90">
                  {log.message}
                </p>
              </article>
            ))}
          </div>
        )}
      </ScrollArea>
    </div>
  )
}

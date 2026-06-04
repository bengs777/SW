"use client"

import { AlertTriangle, RefreshCw, Trash2, Wand2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Badge } from "@/components/ui/badge"

type ErrorLogSource = "project" | "provider" | "generate" | "preview" | "save" | "export" | "deploy" | "github"

type ErrorLogEntry = {
  id: string
  source: ErrorLogSource
  message: string
  timestamp: Date
}

interface ErrorLogPanelProps {
  logs: ErrorLogEntry[]
  onClear?: () => void
  onRetry?: () => void
  onRetryWithRepair?: () => void
  isRetrying?: boolean
}

const sourceLabel: Record<ErrorLogSource, string> = {
  project: "Project",
  provider: "Provider",
  generate: "Generate",
  preview: "Preview",
  save: "Save",
  export: "Export",
  deploy: "Deploy",
  github: "GitHub",
}

function errorAdvice(message: string) {
  if (/failover exhausted|provider.*fallback|Provider AI belum berhasil|model fallback/i.test(message)) {
    return "Cek OPENROUTER_MODEL dan fallback model, lalu retry dengan scope lebih kecil bila provider sedang lambat."
  }
  if (/provider.*timeout|timeout sebelum output|request budget/i.test(message)) {
    return "Provider timeout. Retry dengan prompt lebih kecil atau tunggu model kembali stabil."
  }
  if (/dedicated worker|waiting worker|menunggu worker|worker generation/i.test(message)) {
    return "Cek worker generation dan heartbeat, lalu retry prompt setelah worker sehat."
  }
  if (/worker.*batas waktu|Generation timed out|worker.*timeout/i.test(message)) {
    return "Pastikan worker memakai timeout production terbaru dan tidak stalled sebelum retry."
  }
  if (/queue|Redis|BullMQ|queue_enqueue/i.test(message)) {
    return "Cek Redis/BullMQ dan queue health. Job aman diulang setelah queue menerima request."
  }
  if (/dead[-\s]?letter/i.test(message)) {
    return "Audit dead-letter dulu. Replay hanya job yang masih valid setelah worker dan provider sehat."
  }
  if (/Log generation sempat bentrok|Unique constraint|event.*sequence/i.test(message)) {
    return "Retry aman setelah worker menjalankan patch event sequence terbaru."
  }
  if (/full-stack belum lengkap|full-stack categories|UI, API, data layer/i.test(message)) {
    return "Jalankan perbaikan bertahap: baseline deployable, lalu CRUD/auth/payment di pass lanjutan."
  }
  if (/sandbox|runtime|build failed|preview/i.test(message)) {
    return "Cek sandbox logs untuk membedakan gagal install, build, atau runtime preview."
  }
  if (/saldo|balance|budget token/i.test(message)) {
    return "Cek saldo/budget token atau kurangi scope prompt sebelum retry."
  }
  if (/saturated|penuh sementara/i.test(message)) {
    return "Tunggu backlog turun sebentar, lalu coba ulang prompt."
  }
  return null
}

export function ErrorLogPanel({ logs, onClear, onRetry, onRetryWithRepair, isRetrying = false }: ErrorLogPanelProps) {
  const hasGenerateError = logs.some((log) => log.source === "generate")

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

      {hasGenerateError && (onRetry || onRetryWithRepair) && (
        <div className="grid gap-2 border-b border-border p-3">
          {onRetryWithRepair && (
            <Button
              type="button"
              size="sm"
              className="gap-2"
              onClick={onRetryWithRepair}
              disabled={isRetrying}
            >
              <Wand2 className="h-4 w-4" />
              Retry with repair
            </Button>
          )}
          {onRetry && (
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="gap-2"
              onClick={onRetry}
              disabled={isRetrying}
            >
              <RefreshCw className="h-4 w-4" />
              Retry prompt
            </Button>
          )}
        </div>
      )}

      <ScrollArea className="min-h-0 flex-1">
        {logs.length === 0 ? (
          <div className="p-3 text-xs text-muted-foreground">
            Belum ada error.
          </div>
        ) : (
          <div className="space-y-2 p-3">
            {logs.map((log) => (
              <article key={log.id} className="rounded-md border border-border bg-muted/40 p-2">
                {(() => {
                  const advice = errorAdvice(log.message)
                  return advice ? (
                    <p className="mb-2 rounded border border-border bg-background/70 px-2 py-1 text-[11px] text-muted-foreground">
                      {advice}
                    </p>
                  ) : null
                })()}
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

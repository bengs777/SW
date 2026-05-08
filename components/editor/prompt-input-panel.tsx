"use client"

import { useState, useRef } from "react"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Zap, Send, Loader, AlertCircle } from "lucide-react"
import { cn } from "@/lib/utils"
import type { ModelOption } from "@/lib/types"
import type { GenerationMode } from "@/lib/ai/code-parser"

interface PromptInputPanelProps {
  onSubmit: (prompt: string, model: string) => Promise<void>
  isLoading?: boolean
  modelOptions: ModelOption[]
  defaultModel?: string
  mode?: GenerationMode
  fileCount?: number
  error?: string | null
}

export function PromptInputPanel({
  onSubmit,
  isLoading = false,
  modelOptions,
  defaultModel,
  mode = "CREATE",
  fileCount = 0,
  error,
}: PromptInputPanelProps) {
  const [prompt, setPrompt] = useState("")
  const [selectedModel, setSelectedModel] = useState(defaultModel || "")
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  const handleSubmit = async () => {
    if (!prompt.trim() || !selectedModel || isLoading) return

    try {
      await onSubmit(prompt, selectedModel)
      setPrompt("")
    } catch (err) {
      console.error("Error submitting prompt:", err)
    }
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
      handleSubmit()
    }
  }

  const isDisabled = isLoading || !prompt.trim() || !selectedModel

  return (
    <div className="flex flex-col gap-4 h-full p-4 bg-card border border-border rounded-lg">
      {/* Header */}
      <div>
        <h3 className="font-semibold text-foreground mb-2 flex items-center gap-2">
          <Zap className="h-4 w-4 text-primary" />
          Generator AI
        </h3>
        <p className="text-xs text-muted-foreground">
          Mode: <span className="font-medium text-foreground">{mode}</span>
          {fileCount > 0 && (
            <span> • Files: {fileCount}</span>
          )}
        </p>
      </div>

      {/* Error message */}
      {error && (
        <div className="p-2 bg-destructive/10 border border-destructive/30 rounded text-xs text-destructive flex gap-2">
          <AlertCircle className="h-4 w-4 shrink-0 mt-0.5" />
          <span>{error}</span>
        </div>
      )}

      {/* Model selector */}
      <div className="space-y-2">
        <label className="text-xs font-medium text-foreground">Model</label>
        <Select value={selectedModel} onValueChange={setSelectedModel} disabled={isLoading}>
          <SelectTrigger className="h-9">
            <SelectValue placeholder="Pilih model..." />
          </SelectTrigger>
          <SelectContent>
            {modelOptions.map((option) => (
              <SelectItem key={option.key} value={option.key}>
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {/* Prompt textarea */}
      <div className="flex-1 flex flex-col gap-2 min-h-0">
        <label className="text-xs font-medium text-foreground">Prompt</label>
        <Textarea
          ref={textareaRef}
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={
            mode === "CREATE"
              ? "Jelaskan aplikasi yang ingin Anda buat..."
              : "Apa yang ingin Anda modifikasi atau tambahkan..."
          }
          disabled={isLoading}
          className="flex-1 resize-none text-sm"
        />
        <p className="text-xs text-muted-foreground text-right">
          {prompt.length}/5000
        </p>
      </div>

      {/* Submit button */}
      <Button
        onClick={handleSubmit}
        disabled={isDisabled}
        className="w-full gap-2"
        size="sm"
      >
        {isLoading ? (
          <>
            <Loader className="h-4 w-4 animate-spin" />
            Membuat...
          </>
        ) : (
          <>
            <Send className="h-4 w-4" />
            Buat Kode
          </>
        )}
      </Button>

      {/* Hint */}
      <p className="text-xs text-muted-foreground text-center">
        {mode === "CREATE"
          ? "Buat project baru dari prompt"
          : "Modify atau extend project yang ada"}
      </p>
    </div>
  )
}

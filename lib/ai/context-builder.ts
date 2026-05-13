import type { GeneratedFile } from "@/lib/types"
import { trimContextForGeneration, type GenerationLayer } from "@/lib/ai/generation-pipeline"

export function buildContextForTask(input: {
  prompt: string
  files?: GeneratedFile[]
  activeFile?: GeneratedFile | null
  previewError?: string | null
  maxFiles?: number
  layer?: GenerationLayer
}) {
  const trimmed = trimContextForGeneration({
    prompt: input.prompt,
    files: input.files || [],
    activeFilePath: input.activeFile?.path || null,
    previewErrorFile: null,
    layer: input.layer || "builder",
    budget: input.maxFiles ? { maxFiles: input.maxFiles } : undefined,
  })
  const relevant = trimmed.files

  const fileSummaries = relevant
    .map((f) => `FILE: ${f.path}\n${String(f.content || "").slice(0, 1200)}`)
    .join("\n\n")

  const parts = [input.prompt]
  if (fileSummaries) parts.push("### RELEVANT_FILES", fileSummaries)
  if (input.previewError) parts.push("### PREVIEW_ERROR", String(input.previewError))
  if (trimmed.dependencyMap.missingLocalImports.length > 0 || trimmed.dependencyMap.unsupportedPreviewImports.length > 0) {
    parts.push(
      "### DEPENDENCY_MAP",
      JSON.stringify(
        {
          externalPackages: trimmed.dependencyMap.externalPackages,
          missingLocalImports: trimmed.dependencyMap.missingLocalImports.slice(0, 20),
          unsupportedPreviewImports: trimmed.dependencyMap.unsupportedPreviewImports.slice(0, 20),
          omittedFileCount: trimmed.omittedFileCount,
          contextChars: trimmed.totalChars,
        },
        null,
        2
      )
    )
  }

  return parts.join("\n\n")
}

const contextBuilder = { buildContextForTask }

export default contextBuilder

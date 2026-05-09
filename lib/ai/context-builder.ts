import type { GeneratedFile } from "@/lib/types"

export function buildContextForTask(input: {
  prompt: string
  files?: GeneratedFile[]
  activeFile?: GeneratedFile | null
  previewError?: string | null
  maxFiles?: number
}) {
  const maxFiles = input.maxFiles ?? 6
  const relevant = (input.files || []).slice(0, maxFiles)

  const fileSummaries = relevant
    .map((f) => `FILE: ${f.path}\n${String(f.content || "").slice(0, 1200)}`)
    .join("\n\n")

  const parts = [input.prompt]
  if (fileSummaries) parts.push("### RELEVANT_FILES", fileSummaries)
  if (input.previewError) parts.push("### PREVIEW_ERROR", String(input.previewError))

  return parts.join("\n\n")
}

export default { buildContextForTask }

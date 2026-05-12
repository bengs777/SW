import { z } from "zod"
import type { GeneratedFile } from "@/lib/types"
import { extractGeneratedFilesFromProviderMessage } from "@/lib/ai/provider-output"
import { normalizeFileLanguage } from "@/lib/workspace-state"

const generatedFileSchema = z.object({
  path: z.string().trim().min(1),
  content: z.string(),
  language: z.string().trim().optional(),
})

const generatedArtifactSchema = z.object({
  files: z.array(generatedFileSchema).min(1),
  dependencies: z.array(z.string().trim().min(1)).optional().default([]),
  diagnostics: z.array(z.string()).optional().default([]),
  metadata: z.record(z.unknown()).optional().default({}),
  repairs: z.array(generatedFileSchema).optional().default([]),
})

export type GeneratedArtifact = {
  files: GeneratedFile[]
  dependencies: string[]
  diagnostics: string[]
  metadata: Record<string, unknown>
  repairs: GeneratedFile[]
}

export function parseGeneratedArtifact(providerMessage: string): GeneratedArtifact {
  const parsedJson = tryParseJson(providerMessage)
  if (parsedJson && typeof parsedJson === "object" && !Array.isArray(parsedJson)) {
    const strict = generatedArtifactSchema.safeParse(parsedJson)
    if (strict.success) {
      return {
        files: strict.data.files.map(toGeneratedFile),
        dependencies: strict.data.dependencies,
        diagnostics: strict.data.diagnostics,
        metadata: strict.data.metadata,
        repairs: strict.data.repairs.map(toGeneratedFile),
      }
    }
  }

  const legacy = extractGeneratedFilesFromProviderMessage(providerMessage)
  if (legacy.files.length === 0) {
    throw new Error("MALFORMED_GENERATED_ARTIFACT")
  }

  return {
    files: legacy.files,
    dependencies: [],
    diagnostics: [`providerParseMode:${legacy.parseMode}`],
    metadata: {},
    repairs: [],
  }
}

function toGeneratedFile(file: z.infer<typeof generatedFileSchema>): GeneratedFile {
  return {
    path: file.path,
    content: file.content,
    language: normalizeFileLanguage(file.language),
  }
}

function tryParseJson(value: string) {
  try {
    return JSON.parse(String(value || "").trim())
  } catch {
    return null
  }
}

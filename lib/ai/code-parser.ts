import type { GeneratedFile } from "@/lib/types"

export type GenerationMode = "CREATE" | "EXTEND"

export type GenerationResponse = {
  success: boolean
  files: GeneratedFile[]
  error?: string
  mode?: GenerationMode
}

export type CodeParserResult = {
  mode: GenerationMode
  existingFiles: GeneratedFile[]
  context: string
  error?: string
}

type RawGeneratedFile = {
  path?: unknown
  content?: unknown
  code?: unknown
  language?: unknown
}

/**
 * Detect if project is empty (CREATE mode) or has files (EXTEND mode)
 */
export function detectGenerationMode(files: GeneratedFile[]): GenerationMode {
  return files.length === 0 ? "CREATE" : "EXTEND"
}

/**
 * Extract file structure from current generated files
 * Format files for AI context in prompt
 */
export function extractFileContext(files: GeneratedFile[]): string {
  if (files.length === 0) {
    return "Project is empty. Generate new files."
  }

  const fileList = files
    .map((file) => {
      const lines = file.content.split("\n").length
      return `- ${file.path} (${file.language}, ${lines} lines)`
    })
    .join("\n")

  const fileDetails = files
    .map((file) => `\n### File: ${file.path}\n\`\`\`${file.language}\n${file.content}\n\`\`\``)
    .join("\n")

  return `Current project files:\n${fileList}\n\nFile contents:\n${fileDetails}`
}

/**
 * Parse and validate JSON response from AI
 * Always returns valid JSON structure or throws error with details
 */
export function parseGenerationResponse(responseText: string): GenerationResponse {
  try {
    const parsed = JSON.parse(responseText) as { files?: unknown; error?: unknown }

    // Validate structure
    if (!Array.isArray(parsed.files)) {
      throw new Error("Response must contain 'files' array")
    }

    // Validate each file
    const files: GeneratedFile[] = parsed.files.map((file: RawGeneratedFile, index: number) => {
      if (!file.path || typeof file.path !== "string") {
        throw new Error(`File ${index}: missing or invalid 'path'`)
      }
      // Accept both 'code' and 'content' property names
      const code = file.code || file.content
      if (!code || typeof code !== "string") {
        throw new Error(`File ${index}: missing or invalid 'code'/'content'`)
      }

      return {
        path: file.path,
        content: code,
        language: normalizeLanguage(file.language || inferLanguage(file.path)),
      }
    })

    return {
      success: true,
      files,
      error: typeof parsed.error === "string" ? parsed.error : undefined,
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown JSON parse error"
    throw new Error(`Failed to parse AI response: ${message}`)
  }
}

/**
 * Infer language from file path
 */
function inferLanguage(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase()
  const languageMap: Record<string, string> = {
    ts: "ts",
    tsx: "tsx",
    js: "js",
    jsx: "jsx",
    css: "css",
    json: "json",
    html: "html",
    md: "md",
    prisma: "prisma",
    env: "env",
    sql: "sql",
  }
  return languageMap[ext || ""] || "tsx"
}

/**
 * Normalize language to supported types
 */
function normalizeLanguage(value: unknown): GeneratedFile["language"] {
  const candidate = typeof value === "string" ? value.toLowerCase() : ""
  return isGeneratedFileLanguage(candidate) ? candidate : "tsx"
}

function isGeneratedFileLanguage(value: string): value is GeneratedFile["language"] {
  return ["tsx", "ts", "css", "json", "html", "prisma", "md", "env"].includes(value)
}

/**
 * Check if JSON string is valid without throwing
 */
export function isValidJSON(text: string): boolean {
  try {
    JSON.parse(text)
    return true
  } catch {
    return false
  }
}

/**
 * Extract JSON from AI response that might contain markdown or extra text
 * Looks for JSON block or JSON object
 */
export function extractJSON(text: string): string {
  // Try to find JSON in markdown code block
  const jsonBlockMatch = text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/)
  if (jsonBlockMatch && jsonBlockMatch[1]) {
    return jsonBlockMatch[1].trim()
  }

  // Try to find raw JSON object
  const jsonMatch = text.match(/\{[\s\S]*\}/)
  if (jsonMatch) {
    return jsonMatch[0]
  }

  // If no JSON found, return original text
  return text
}

/**
 * Build system prompt for code generation with mode awareness
 */
export function buildCodeGenerationPrompt(
  userPrompt: string,
  mode: GenerationMode,
  existingContext?: string
): string {
  const baseInstructions = `You are an expert web developer. Generate production-ready React/Next.js code with Tailwind CSS.
Always return ONLY valid JSON with this exact structure:
{
  "files": [
    {"path": "app/page.tsx", "code": "...code here..."},
    {"path": "components/example.tsx", "code": "...code here..."}
  ]
}
Do not include any text outside the JSON object. Do not wrap JSON in markdown code blocks.`

  if (mode === "CREATE") {
    return `${baseInstructions}\n\nUser request (create new project):\n${userPrompt}`
  }

  return `${baseInstructions}\n\nExisting project context:\n${existingContext}\n\nUser request (modify/extend project):\n${userPrompt}`
}

/**
 * Merge existing files with generated files
 * Generated files with same path replace existing ones
 */
export function mergeFiles(existingFiles: GeneratedFile[], generatedFiles: GeneratedFile[]): GeneratedFile[] {
  const fileMap = new Map(existingFiles.map((f) => [f.path, f]))

  // Update or add generated files
  for (const file of generatedFiles) {
    fileMap.set(file.path, file)
  }

  return Array.from(fileMap.values())
}

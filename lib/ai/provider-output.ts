import { z } from "zod"
import type { GeneratedFile } from "@/lib/types"

type ProviderOutputParseResult = {
  files: GeneratedFile[]
  parseMode: "json-object" | "json-array" | "json-fence" | "json-fragment" | "json-loose" | "code-fence-files" | "none"
}

const ALLOWED_LANGUAGES: GeneratedFile["language"][] = [
  "tsx",
  "ts",
  "css",
  "json",
  "html",
  "prisma",
  "md",
  "env",
]

const ALLOWED_LANGUAGE_SET = new Set(ALLOWED_LANGUAGES)
const FILE_PATH_PATTERN = /[A-Za-z0-9._/-]+\.(tsx|ts|css|json|html|prisma|md|env)/i

const PATH_CONTENT_FILE_SCHEMA = z.object({
  path: z.string().trim().min(1),
  content: z.string(),
  language: z.string().trim().optional().nullable(),
})

const FILENAME_CODE_FILE_SCHEMA = z.object({
  filename: z.string().trim().min(1),
  code: z.string(),
  language: z.string().trim().optional().nullable(),
})

const PROVIDER_OUTPUT_SCHEMA = z.union([
  z.array(z.union([PATH_CONTENT_FILE_SCHEMA, FILENAME_CODE_FILE_SCHEMA])),
  z.object({
    message: z.string().optional(),
    files: z.array(z.union([PATH_CONTENT_FILE_SCHEMA, FILENAME_CODE_FILE_SCHEMA])),
  }),
])

const LANGUAGE_ALIASES: Record<string, GeneratedFile["language"]> = {
  tsx: "tsx",
  jsx: "tsx",
  typescriptreact: "tsx",
  react: "tsx",
  ts: "ts",
  typescript: "ts",
  js: "ts",
  javascript: "ts",
  css: "css",
  json: "json",
  html: "html",
  prisma: "prisma",
  md: "md",
  markdown: "md",
  env: "env",
  dotenv: "env",
}

type CodeFenceBlock = {
  info: string
  body: string
  index: number
}

export function extractGeneratedFilesFromProviderMessage(message: string): ProviderOutputParseResult {
  const normalized = (message || "").trim()
  if (!normalized) {
    return { files: [], parseMode: "none" }
  }

  const direct = parseJsonCandidate(normalized)
  if (direct.length > 0) {
    const parsedDirect = safeJsonParse(sanitizeJsonCandidate(normalized))
    return {
      files: normalizeGeneratedFiles(direct),
      parseMode: Array.isArray(parsedDirect) ? "json-array" : "json-object",
    }
  }

  const fencedCandidates = extractJsonCodeFenceCandidates(normalized)
  for (const candidate of fencedCandidates) {
    const parsed = parseJsonCandidate(candidate)
    if (parsed.length > 0) {
      return {
        files: normalizeGeneratedFiles(parsed),
        parseMode: "json-fence",
      }
    }
  }

  const jsonFragments = extractJsonFragmentCandidates(normalized)
  for (const candidate of jsonFragments) {
    const parsed = parseJsonCandidate(candidate)
    if (parsed.length > 0) {
      return {
        files: normalizeGeneratedFiles(parsed),
        parseMode: "json-fragment",
      }
    }
  }

  const looseFiles = extractLooseJsonFiles(normalized)
  if (looseFiles.length > 0) {
    return {
      files: normalizeGeneratedFiles(looseFiles),
      parseMode: "json-loose",
    }
  }

  const fencedFiles = extractFilesFromCodeFences(normalized)
  if (fencedFiles.length > 0) {
    return {
      files: normalizeGeneratedFiles(fencedFiles),
      parseMode: "code-fence-files",
    }
  }

  return { files: [], parseMode: "none" }
}

export function mergeGeneratedFiles(baseFiles: GeneratedFile[], providerFiles: GeneratedFile[]) {
  const merged = new Map<string, GeneratedFile>()

  for (const file of normalizeGeneratedFiles(baseFiles)) {
    merged.set(file.path, file)
  }

  for (const file of normalizeGeneratedFiles(providerFiles)) {
    merged.set(file.path, file)
  }

  return Array.from(merged.values()).sort((a, b) => a.path.localeCompare(b.path))
}

function parseJsonCandidate(candidate: string): GeneratedFile[] {
  const parsed = safeJsonParse(sanitizeJsonCandidate(candidate))
  if (!parsed) {
    return []
  }

  const validated = PROVIDER_OUTPUT_SCHEMA.safeParse(parsed)
  if (!validated.success) {
    return []
  }

  if (Array.isArray(validated.data)) {
    return validated.data.flatMap((entry) => toGeneratedFile(entry)).filter(Boolean) as GeneratedFile[]
  }

  if (typeof validated.data === "object" && validated.data !== null) {
    return validated.data.files
      .flatMap((entry) => toGeneratedFile(entry))
      .filter(Boolean) as GeneratedFile[]
  }

  return []
}

function safeJsonParse(value: string): unknown | null {
  try {
    return JSON.parse(value)
  } catch {
    return null
  }
}

function sanitizeJsonCandidate(value: string) {
  return value
    .trim()
    .replace(/^\uFEFF/, "")
    .replace(/^json\s*/i, "")
    .replace(/;\s*$/, "")
}

function extractJsonCodeFenceCandidates(message: string) {
  const candidates: string[] = []

  for (const block of extractCodeFenceBlocks(message)) {
    const info = block.info.trim().toLowerCase()
    const body = block.body.trim()
    if (!body) {
      continue
    }

    if (info.includes("json") || body.startsWith("{") || body.startsWith("[")) {
      candidates.push(body)
    }
  }

  return candidates
}

function extractJsonFragmentCandidates(message: string) {
  return extractBalancedJsonFragments(message)
    .map((fragment) => fragment.trim())
    .filter(Boolean)
    .sort((left, right) => {
      const scoreDelta = scoreJsonFragment(right) - scoreJsonFragment(left)
      if (scoreDelta !== 0) {
        return scoreDelta
      }

      return right.length - left.length
    })
    .slice(0, 12)
}

function scoreJsonFragment(fragment: string) {
  let score = 0

  if (/"files"\s*:|\'files\'\s*:/.test(fragment)) {
    score += 5
  }

  if (/"path"\s*:|\'path\'\s*:/.test(fragment)) {
    score += 3
  }

  if (/"content"\s*:|\'content\'\s*:/.test(fragment)) {
    score += 3
  }

  if (fragment.startsWith("{")) {
    score += 1
  }

  if (fragment.length > 1000) {
    score += 1
  }

  return score
}

function extractBalancedJsonFragments(text: string) {
  const fragments: string[] = []
  const stack: string[] = []
  let startIndex = -1
  let inString = false
  let stringDelimiter = ""
  let escaped = false

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]

    if (inString) {
      if (escaped) {
        escaped = false
        continue
      }

      if (char === "\\") {
        escaped = true
        continue
      }

      if (char === stringDelimiter) {
        inString = false
        stringDelimiter = ""
      }

      continue
    }

    if (char === `"`) {
      inString = true
      stringDelimiter = char
      continue
    }

    if (char === "{" || char === "[") {
      if (stack.length === 0) {
        startIndex = index
      }

      stack.push(char)
      continue
    }

    if (char !== "}" && char !== "]") {
      continue
    }

    if (stack.length === 0) {
      continue
    }

    const opening = stack[stack.length - 1]
    const isMatchingPair = (opening === "{" && char === "}") || (opening === "[" && char === "]")

    if (!isMatchingPair) {
      stack.length = 0
      startIndex = -1
      continue
    }

    stack.pop()

    if (stack.length === 0 && startIndex >= 0) {
      fragments.push(text.slice(startIndex, index + 1))
      startIndex = -1
    }
  }

  return fragments
}

function extractFilesFromCodeFences(message: string): GeneratedFile[] {
  const blocks = extractCodeFenceBlocks(message)
  if (blocks.length === 0) {
    return []
  }

  const extracted: GeneratedFile[] = []

  for (let index = 0; index < blocks.length; index += 1) {
    const block = blocks[index]
    const body = block.body.replace(/\r\n/g, "\n").trim()
    if (!body) {
      continue
    }

    const languageFromInfo = inferLanguageFromFenceInfo(block.info)
    const explicitPath = inferPathFromFenceInfo(block.info) || inferPathFromContext(message, block.index)

    if (!explicitPath && !languageFromInfo) {
      continue
    }

    if (!explicitPath && languageFromInfo === "json") {
      continue
    }

    if (!explicitPath && body.length < 20) {
      continue
    }

    const fallbackPath = selectFallbackPathForFence(languageFromInfo, index)
    const normalizedPath = normalizePath(explicitPath || fallbackPath)
    if (!normalizedPath) {
      continue
    }

    extracted.push({
      path: normalizedPath,
      content: body,
      language: normalizeLanguage(languageFromInfo, normalizedPath),
    })
  }

  return normalizeGeneratedFiles(extracted)
}

function extractLooseJsonFiles(message: string): GeneratedFile[] {
  const extracted: GeneratedFile[] = []
  const seen = new Set<string>()

  for (let index = 0; index < message.length; index += 1) {
    if (message[index] !== "{") {
      continue
    }

    const candidate = readBalancedObjectAt(message, index)
    if (!candidate) {
      continue
    }

    if (!/"(?:path|filename)"\s*:/.test(candidate) || !/"(?:content|code)"\s*:/.test(candidate)) {
      continue
    }

    const parsed = safeJsonParse(candidate)
    const file = toGeneratedFile(parsed)
    if (!file) {
      continue
    }

    const dedupeKey = `${file.path}:${file.content.length}`
    if (seen.has(dedupeKey)) {
      continue
    }

    seen.add(dedupeKey)
    extracted.push(file)
  }

  return extracted
}

function readBalancedObjectAt(text: string, startIndex: number) {
  if (text[startIndex] !== "{") {
    return ""
  }

  let depth = 0
  let inString = false
  let escaped = false

  for (let index = startIndex; index < text.length; index += 1) {
    const char = text[index]

    if (inString) {
      if (escaped) {
        escaped = false
        continue
      }

      if (char === "\\") {
        escaped = true
        continue
      }

      if (char === `"`) {
        inString = false
      }

      continue
    }

    if (char === `"`) {
      inString = true
      continue
    }

    if (char === "{") {
      depth += 1
      continue
    }

    if (char !== "}") {
      continue
    }

    depth -= 1
    if (depth === 0) {
      return text.slice(startIndex, index + 1)
    }

    if (depth < 0) {
      return ""
    }
  }

  return ""
}

function extractCodeFenceBlocks(message: string): CodeFenceBlock[] {
  const blocks: CodeFenceBlock[] = []
  const fenceRegex = /(```|''')([^\n\r]*)\r?\n([\s\S]*?)\1/g

  let match: RegExpExecArray | null
  while ((match = fenceRegex.exec(message))) {
    blocks.push({
      info: match[2] || "",
      body: match[3] || "",
      index: match.index,
    })
  }

  return blocks
}

function inferLanguageFromFenceInfo(info: string): GeneratedFile["language"] | "" {
  const tokens = info
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .flatMap((token) => token.split(/[=,:|]/))
    .map((token) => token.toLowerCase().trim())

  for (const token of tokens) {
    if (!token) {
      continue
    }

    if (token in LANGUAGE_ALIASES) {
      return LANGUAGE_ALIASES[token]
    }
  }

  return ""
}

function inferPathFromFenceInfo(info: string) {
  const tokenized = info
    .trim()
    .split(/\s+/)
    .filter(Boolean)

  for (const token of tokenized) {
    const extracted = extractPathToken(token)
    if (extracted) {
      return extracted
    }
  }

  return ""
}

function inferPathFromContext(message: string, fenceIndex: number) {
  const context = message.slice(Math.max(0, fenceIndex - 320), fenceIndex)
  const lines = context
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)

  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]
    const extracted = extractPathToken(line)
    if (extracted) {
      return extracted
    }

    const headingMatch = line.match(
      /^(?:#+\s*)?`?([A-Za-z0-9._/-]+\.(?:tsx|ts|css|json|html|prisma|md|env))`?$/i
    )
    if (headingMatch?.[1]) {
      return headingMatch[1]
    }
  }

  return ""
}

function extractPathToken(value: string) {
  const explicitMatch = value.match(
    /(?:path|file|filename)\s*[:=]\s*`?([A-Za-z0-9._/-]+\.(?:tsx|ts|css|json|html|prisma|md|env))`?/i
  )
  if (explicitMatch?.[1]) {
    return explicitMatch[1]
  }

  const directMatch = value.match(FILE_PATH_PATTERN)
  if (directMatch?.[0]) {
    return directMatch[0]
  }

  return ""
}

function selectFallbackPathForFence(language: GeneratedFile["language"] | "", index: number) {
  if (!language) {
    return ""
  }

  if (index === 0) {
    if (language === "tsx") return "app/page.tsx"
    if (language === "ts") return "app/page.ts"
    if (language === "css") return "app/globals.css"
    if (language === "html") return "index.html"
  }

  const extension = extensionForLanguage(language)
  if (!extension) {
    return ""
  }

  return `generated/file-${index + 1}.${extension}`
}

function extensionForLanguage(language: GeneratedFile["language"]) {
  if (language === "tsx") return "tsx"
  if (language === "ts") return "ts"
  if (language === "css") return "css"
  if (language === "json") return "json"
  if (language === "html") return "html"
  if (language === "prisma") return "prisma"
  if (language === "md") return "md"
  if (language === "env") return "env"
  return ""
}

function toGeneratedFile(value: unknown): GeneratedFile | null {
  if (!value || typeof value !== "object") {
    return null
  }

  const record = value as Record<string, unknown>
  const rawPath = typeof record.path === "string" ? record.path : typeof record.filename === "string" ? record.filename : ""
  const rawContent = typeof record.content === "string" ? record.content : typeof record.code === "string" ? record.code : ""

  if (!rawPath.trim() || !rawContent) {
    return null
  }

  const path = normalizePath(rawPath)
  if (!path) {
    return null
  }

  const providedLanguage = typeof record.language === "string" ? record.language : ""
  const language = normalizeLanguage(providedLanguage, path)

  return {
    path,
    content: rawContent,
    language,
  }
}

function normalizeGeneratedFiles(files: GeneratedFile[]) {
  const normalized = new Map<string, GeneratedFile>()

  for (const file of files) {
    const path = normalizePath(file.path)
    if (!path) {
      continue
    }

    normalized.set(path, {
      path,
      content: file.content,
      language: normalizeLanguage(file.language, path),
    })
  }

  return Array.from(normalized.values())
}

function normalizePath(path: string) {
  const normalized = path
    .replace(/\\/g, "/")
    .replace(/^\.\//, "")
    .trim()

  if (!normalized || normalized.startsWith("/") || normalized.includes("..")) {
    return ""
  }

  return normalized
}

function normalizeLanguage(language: string, path: string): GeneratedFile["language"] {
  const normalized = language.trim().toLowerCase()
  if (ALLOWED_LANGUAGE_SET.has(normalized as GeneratedFile["language"])) {
    return normalized as GeneratedFile["language"]
  }

  if (path.endsWith(".tsx")) return "tsx"
  if (path.endsWith(".ts")) return "ts"
  if (path.endsWith(".css")) return "css"
  if (path.endsWith(".json")) return "json"
  if (path.endsWith(".html")) return "html"
  if (path.endsWith(".prisma")) return "prisma"
  if (path.endsWith(".md")) return "md"
  if (path.endsWith(".env")) return "env"
  return "ts"
}

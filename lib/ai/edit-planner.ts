import type { GeneratedFile, PreviewContext } from "@/lib/types"
import { buildImportGraph, getTransitiveImpactPaths } from "@/lib/ai/import-graph"

export type EditIntent =
  | "full_generation"
  | "feature_addition"
  | "file_scoped_edit"
  | "component_scoped_edit"
  | "schema_change"
  | "api_change"
  | "runtime_fix"
  | "style_copy_edit"
  | "upload_integration"
  | "pricing_page"

export type PartialEditPlan = {
  mode: "full" | "partial"
  intent: EditIntent
  confidence: number
  reason: string
  targetPaths: string[]
  allowedNewPaths: string[]
  preservePaths: string[]
  maxSlices: number
  requiresFullValidation: boolean
}

type BuildEditPlanInput = {
  prompt: string
  existingFiles: GeneratedFile[]
  collaborationMode?: string | null
  previewContext?: PreviewContext | null
}

const ALWAYS_ALLOWED_PATCH_FILES = new Set([
  "package.json",
  ".env.example",
  "prisma/schema.prisma",
  "app/globals.css",
  "lib/utils.ts",
])

export function buildPartialEditPlan(input: BuildEditPlanInput): PartialEditPlan {
  const existingPaths = input.existingFiles.map((file) => normalizePath(file.path))
  const importGraph = buildImportGraph(input.existingFiles)
  const prompt = String(input.prompt || "")
  const normalizedPrompt = prompt.toLowerCase()
  const mode = String(input.collaborationMode || "").toLowerCase()
  const hasExistingProject = existingPaths.length > 0
  const activeFilePath = normalizePath(input.previewContext?.activeFilePath || "")
  const previewErrorFile = normalizePath(input.previewContext?.previewError?.filename || "")
  const intent = classifyEditIntent(normalizedPrompt, mode)
  const partial =
    hasExistingProject &&
    (mode === "edit" ||
      mode === "fix" ||
      mode === "review" ||
      intent !== "full_generation" ||
      /\b(add|tambahkan|ubah|change|update|edit|fix|perbaiki|connect|integrate|refine|polish)\b/i.test(prompt))

  if (!partial) {
    return {
      mode: "full",
      intent: "full_generation",
      confidence: 0.92,
      reason: "New or broad build request; full controlled generation is allowed.",
      targetPaths: [],
      allowedNewPaths: [],
      preservePaths: [],
      maxSlices: 6,
      requiresFullValidation: true,
    }
  }

  const targetPaths = new Set<string>()
  const allowedNewPaths = new Set<string>()

  if (activeFilePath && fileExists(activeFilePath, existingPaths)) {
    targetPaths.add(activeFilePath)
  }
  if (previewErrorFile && fileExists(previewErrorFile, existingPaths)) {
    targetPaths.add(previewErrorFile)
  }

  addIntentPaths({
    intent,
    prompt: normalizedPrompt,
    existingPaths,
    targetPaths,
    allowedNewPaths,
  })

  for (const path of findPromptMentionedPaths(prompt, existingPaths)) {
    targetPaths.add(path)
  }

  if (targetPaths.size === 0) {
    for (const path of rankRelevantPaths(normalizedPrompt, existingPaths).slice(0, 4)) {
      targetPaths.add(path)
    }
  }

  const impactPaths = getTransitiveImpactPaths(importGraph, Array.from(targetPaths), {
    direction: "both",
    maxDepth: intent === "runtime_fix" || intent === "schema_change" ? 2 : 1,
    maxFiles: maxSlicesForIntent(intent) + 4,
  })
  for (const path of impactPaths) {
    if (fileExists(path, existingPaths) && targetPaths.size < maxSlicesForIntent(intent)) {
      targetPaths.add(path)
    }
  }

  for (const path of Array.from(ALWAYS_ALLOWED_PATCH_FILES)) {
    if (fileExists(path, existingPaths) && shouldIncludeSupportFile(intent, path)) {
      targetPaths.add(path)
    }
  }

  const targetList = Array.from(targetPaths).slice(0, maxSlicesForIntent(intent))
  const preservePaths = existingPaths
    .filter((path) => !targetPaths.has(path))
    .filter((path) => !ALWAYS_ALLOWED_PATCH_FILES.has(path))

  return {
    mode: "partial",
    intent,
    confidence: targetList.length > 0 ? 0.86 : 0.62,
    reason: buildReason(intent, mode, targetList),
    targetPaths: targetList,
    allowedNewPaths: Array.from(allowedNewPaths).slice(0, 8),
    preservePaths,
    maxSlices: maxSlicesForIntent(intent),
    requiresFullValidation: true,
  }
}

export function buildPartialEditInstructionBlock(plan: PartialEditPlan) {
  if (plan.mode !== "partial") {
    return "PARTIAL_REGENERATION_CONTRACT: full controlled generation allowed for this request."
  }

  return [
    "PARTIAL_REGENERATION_CONTRACT:",
    JSON.stringify(
      {
        intent: plan.intent,
        reason: plan.reason,
        targetPaths: plan.targetPaths,
        allowedNewPaths: plan.allowedNewPaths,
        preservePolicy: "Preserve every existing file not listed in targetPaths unless it is a direct import fix needed for validation.",
        outputPolicy: [
          "Return only changed files.",
          "Do not return unchanged files.",
          "Do not rewrite the full project.",
          "Prefer the smallest deployable patch.",
        ],
      },
      null,
      2
    ),
  ].join("\n")
}

export function filterFilesForPartialEdit(
  generatedFiles: GeneratedFile[],
  plan: PartialEditPlan
): {
  acceptedFiles: GeneratedFile[]
  rejectedFiles: GeneratedFile[]
} {
  if (plan.mode !== "partial") {
    return {
      acceptedFiles: generatedFiles,
      rejectedFiles: [],
    }
  }

  const allowed = new Set([
    ...plan.targetPaths.map(normalizePath),
    ...plan.allowedNewPaths.map(normalizePath),
    ...Array.from(ALWAYS_ALLOWED_PATCH_FILES),
  ])
  const acceptedFiles: GeneratedFile[] = []
  const rejectedFiles: GeneratedFile[] = []

  for (const file of generatedFiles) {
    const path = normalizePath(file.path)
    if (allowed.has(path) || isGeneratedSupportFile(path, plan)) {
      acceptedFiles.push({ ...file, path })
    } else {
      rejectedFiles.push({ ...file, path })
    }
  }

  return { acceptedFiles, rejectedFiles }
}

function classifyEditIntent(prompt: string, mode: string): EditIntent {
  if (mode === "fix" || /\b(fix|repair|perbaiki|error|bug|crash|hydration|module not found|cannot find module)\b/.test(prompt)) {
    return "runtime_fix"
  }

  if (/\b(pricing|price|plan|billing page|stripe pricing|paket harga|harga)\b/.test(prompt)) {
    return "pricing_page"
  }

  if (/\b(upload|storage|supabase storage|file upload|image upload|unggah|lampiran)\b/.test(prompt)) {
    return "upload_integration"
  }

  if (/\b(schema|prisma|model\s+\w+|database|migration|lead schema|ubah schema)\b/.test(prompt)) {
    return "schema_change"
  }

  if (/\b(api|route handler|endpoint|webhook|connect|integrate|hubungkan)\b/.test(prompt)) {
    return "api_change"
  }

  if (/\b(component|section|card|modal|dialog|form|button|table|chart)\b/.test(prompt)) {
    return "component_scoped_edit"
  }

  if (/\b(copy|text|warna|color|style|spacing|polish|visual|responsive|mobile)\b/.test(prompt)) {
    return "style_copy_edit"
  }

  if (/\b(add|tambahkan|new page|fitur baru|feature|create page)\b/.test(prompt)) {
    return "feature_addition"
  }

  return mode === "edit" ? "file_scoped_edit" : "full_generation"
}

function addIntentPaths(input: {
  intent: EditIntent
  prompt: string
  existingPaths: string[]
  targetPaths: Set<string>
  allowedNewPaths: Set<string>
}) {
  const addExistingMatches = (patterns: RegExp[], limit = 5) => {
    for (const path of input.existingPaths) {
      if (patterns.some((pattern) => pattern.test(path))) {
        input.targetPaths.add(path)
      }
      if (input.targetPaths.size >= limit) break
    }
  }

  if (input.intent === "pricing_page") {
    addExistingMatches([/pricing/i, /billing/i, /^app\/page\.tsx$/i, /^components\/.*pricing/i])
    input.allowedNewPaths.add("app/pricing/page.tsx")
    input.allowedNewPaths.add("components/pricing-section.tsx")
    return
  }

  if (input.intent === "upload_integration") {
    addExistingMatches([/upload/i, /storage/i, /supabase/i, /^app\/api\/.*upload.*\/route\.ts$/i, /^\.env\.example$/i])
    input.allowedNewPaths.add("app/api/uploads/route.ts")
    input.allowedNewPaths.add("lib/services/storage.service.ts")
    input.allowedNewPaths.add("components/upload-field.tsx")
    return
  }

  if (input.intent === "schema_change") {
    addExistingMatches([/^prisma\/schema\.prisma$/i, /lead/i, /crm/i, /^lib\/services\//i, /^app\/api\//i], 6)
    if (/lead|crm|pipeline/.test(input.prompt)) {
      input.allowedNewPaths.add("app/api/leads/route.ts")
      input.allowedNewPaths.add("lib/services/lead.service.ts")
    }
    return
  }

  if (input.intent === "api_change") {
    addExistingMatches([/^app\/api\//i, /^lib\/services\//i, /^prisma\/schema\.prisma$/i], 6)
    return
  }

  if (input.intent === "runtime_fix") {
    addExistingMatches([/page\.(tsx|ts)$/i, /^components\//i, /^lib\//i, /^app\/api\//i], 6)
    return
  }

  if (/\bbooking|reservation|appointment|slot\b/.test(input.prompt)) {
    addExistingMatches([/booking/i, /reservation/i, /slot/i, /^app\/api\/bookings\/route\.ts$/i], 5)
    input.allowedNewPaths.add("app/booking/page.tsx")
    input.allowedNewPaths.add("app/api/bookings/route.ts")
    input.allowedNewPaths.add("lib/services/booking.service.ts")
    return
  }

  if (/\bcrm|lead|pipeline|customer\b/.test(input.prompt)) {
    addExistingMatches([/crm/i, /lead/i, /pipeline/i, /^app\/api\/leads\/route\.ts$/i], 5)
    input.allowedNewPaths.add("app/crm/page.tsx")
    input.allowedNewPaths.add("app/api/leads/route.ts")
    input.allowedNewPaths.add("lib/services/lead.service.ts")
    return
  }

  addExistingMatches([/^app\/page\.tsx$/i, /^components\//i, /^app\/.+\/page\.tsx$/i], 5)
}

function rankRelevantPaths(prompt: string, existingPaths: string[]) {
  const terms = prompt
    .replace(/[^a-z0-9/_-]+/g, " ")
    .split(/\s+/)
    .filter((term) => term.length >= 3)

  return existingPaths
    .map((path) => ({
      path,
      score:
        (/^app\/(?:.+\/)?page\.tsx$/i.test(path) ? 40 : 0) +
        (/^components\//i.test(path) ? 30 : 0) +
        (/^app\/api\//i.test(path) ? 24 : 0) +
        (/^lib\/services\//i.test(path) ? 22 : 0) +
        (/^prisma\/schema\.prisma$/i.test(path) ? 20 : 0) +
        terms.reduce((sum, term) => sum + (path.toLowerCase().includes(term) ? 18 : 0), 0),
    }))
    .filter((item) => item.score > 0)
    .sort((left, right) => right.score - left.score || left.path.localeCompare(right.path))
    .map((item) => item.path)
}

function findPromptMentionedPaths(prompt: string, existingPaths: string[]) {
  const mentioned = new Set<string>()
  const pathPattern = /(?:^|\s)([A-Za-z0-9_./()@-]+\.(?:tsx?|jsx?|css|json|prisma|md|env))/g

  for (const match of prompt.matchAll(pathPattern)) {
    const normalized = normalizePath(match[1] || "")
    if (fileExists(normalized, existingPaths)) {
      mentioned.add(normalized)
    }
  }

  return Array.from(mentioned)
}

function shouldIncludeSupportFile(intent: EditIntent, path: string) {
  if (path === "package.json") return intent === "upload_integration" || intent === "api_change"
  if (path === ".env.example") return intent === "upload_integration" || intent === "api_change" || intent === "schema_change"
  if (path === "prisma/schema.prisma") return intent === "schema_change"
  return false
}

function isGeneratedSupportFile(path: string, plan: PartialEditPlan) {
  if (path.startsWith("components/ui/")) return false
  if (path === "lib/utils.ts") return plan.intent === "component_scoped_edit" || plan.intent === "style_copy_edit"
  return false
}

function maxSlicesForIntent(intent: EditIntent) {
  if (intent === "schema_change" || intent === "upload_integration") return 6
  if (intent === "api_change" || intent === "pricing_page") return 5
  if (intent === "runtime_fix") return 4
  return 3
}

function buildReason(intent: EditIntent, mode: string, targetPaths: string[]) {
  return `Detected ${intent} from ${mode || "prompt"} mode; scoped to ${targetPaths.length} target file(s).`
}

function fileExists(path: string, existingPaths: string[]) {
  return existingPaths.includes(normalizePath(path))
}

function normalizePath(value: string) {
  return String(value || "").replace(/\\/g, "/").replace(/^\/+/, "").replace(/^\.\//, "").trim()
}

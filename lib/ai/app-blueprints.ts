import type { GeneratedFile } from "@/lib/types"
import { buildProjectFiles } from "@/lib/ai/project-scaffold"

export type ControlledAppType =
  | "saas_dashboard"
  | "village_news_portal"
  | "crud_admin_panel"
  | "ai_chat_app"
  | "landing_auth"
  | "internal_business_tool"
  | "booking_app"
  | "lightweight_crm"
  | "simple_marketplace"

export type ControlledAppBlueprint = {
  appType: ControlledAppType
  label: string
  starterPrompt: string
  requiredFiles: string[]
  dependencyPolicy: {
    stack: string[]
    allowedExternalPackages: string[]
    forbiddenPatterns: string[]
  }
  architectureRules: string[]
  editingRules: string[]
}

const STACK = [
  "Next.js App Router",
  "TypeScript",
  "Tailwind",
  "shadcn/ui-compatible primitives",
  "Prisma",
  "Neon PostgreSQL",
  "Supabase storage",
]

const BASE_ALLOWED_PACKAGES = [
  "@prisma/client",
  "@supabase/supabase-js",
  "class-variance-authority",
  "clsx",
  "date-fns",
  "lucide-react",
  "next",
  "next-auth",
  "prisma",
  "react",
  "react-dom",
  "react-hook-form",
  "recharts",
  "sonner",
  "tailwind-merge",
  "zod",
]

const BASE_REQUIRED_FILES = [
  "app/layout.tsx",
  "app/page.tsx",
  "app/globals.css",
  "app/api/health/route.ts",
  "components/build-status-panel.tsx",
  "lib/services/project.service.ts",
  "prisma/schema.prisma",
  ".env.example",
  "package.json",
]

const BLUEPRINTS: Record<ControlledAppType, ControlledAppBlueprint> = {
  village_news_portal: blueprint("village_news_portal", "Portal berita desa", "Build an official village news portal for Desa Buntu. Public home must show hero with village identity, latest village news, citizen announcements, and village agenda. Include full article reading pages with comments and Google/Gmail-ready login placeholders. Include admin CRUD for posts and categories. Prisma schema must model posts, categories, and comments. Do not include SaaS finance metrics, revenue, orders, conversion cards, or business analytics.", [
    "app/posts/[slug]/page.tsx",
    "app/admin/posts/page.tsx",
    "app/admin/categories/page.tsx",
    "app/api/posts/route.ts",
    "app/api/posts/[id]/route.ts",
    "app/api/categories/route.ts",
    "app/api/comments/route.ts",
    "lib/services/news.service.ts",
  ]),
  saas_dashboard: blueprint("saas_dashboard", "SaaS dashboard", "Build a SaaS dashboard with auth-ready layout, workspace metrics, activity feed, settings entry points, Prisma schema, Neon PostgreSQL env template, and Supabase storage placeholders.", [
    "app/dashboard/page.tsx",
    "app/api/projects/route.ts",
    "lib/services/project.service.ts",
  ]),
  crud_admin_panel: blueprint("crud_admin_panel", "CRUD admin panel", "Build a CRUD admin panel with list, create, update, status filters, API route handlers, Prisma models, and safe empty/error states.", [
    "app/admin/page.tsx",
    "app/api/admin/items/route.ts",
    "lib/services/admin-item.service.ts",
  ]),
  ai_chat_app: blueprint("ai_chat_app", "AI chat app", "Build an AI chat app with conversation UI, message persistence model, chat API route placeholder, provider config, and deterministic loading/error states.", [
    "app/chat/page.tsx",
    "app/api/chat/route.ts",
    "lib/services/chat.service.ts",
  ]),
  landing_auth: blueprint("landing_auth", "Landing page + auth", "Build a conversion landing page with auth-ready sign in/sign up screens, pricing, trust sections, env template, and route-safe auth placeholders.", [
    "app/(auth)/sign-in/page.tsx",
    "app/(auth)/sign-up/page.tsx",
    "auth.ts",
  ]),
  internal_business_tool: blueprint("internal_business_tool", "Internal business tool", "Build an internal business tool with operational dashboard, task/table workflow, API route handlers, Prisma-backed service placeholders, and audit-friendly status states.", [
    "app/operations/page.tsx",
    "app/api/operations/route.ts",
    "lib/services/operation.service.ts",
  ]),
  booking_app: blueprint("booking_app", "Booking app", "Build a booking app with availability slots, reservation form, confirmation state, bookings API route, Prisma models, and conflict-check service placeholders.", [
    "app/booking/page.tsx",
    "app/api/bookings/route.ts",
    "lib/services/booking.service.ts",
  ]),
  lightweight_crm: blueprint("lightweight_crm", "Lightweight CRM", "Build a lightweight CRM with lead pipeline, customer table, activity timeline, lead API route, Prisma models, and import/export-ready service boundaries.", [
    "app/crm/page.tsx",
    "app/api/leads/route.ts",
    "lib/services/lead.service.ts",
  ]),
  simple_marketplace: blueprint("simple_marketplace", "Simple marketplace", "Build a simple marketplace with storefront, product listing, seller/admin placeholders, product API route, Prisma models, and checkout-safe placeholder flow.", [
    "app/marketplace/page.tsx",
    "app/api/products/route.ts",
    "lib/services/product.service.ts",
  ]),
}

function blueprint(appType: ControlledAppType, label: string, starterPrompt: string, extraRequiredFiles: string[]): ControlledAppBlueprint {
  return {
    appType,
    label,
    starterPrompt,
    requiredFiles: Array.from(new Set([...BASE_REQUIRED_FILES, ...extraRequiredFiles])),
    dependencyPolicy: {
      stack: STACK,
      allowedExternalPackages: BASE_ALLOWED_PACKAGES,
      forbiddenPatterns: [
        "pages/",
        "vite",
        "express",
        "mongodb",
        "mongoose",
        "firebase",
        "serverless.yml",
        "webpack.config",
      ],
    },
    architectureRules: [
      "Use App Router only; do not create pages/ routes.",
      "Keep Prisma, Neon PostgreSQL, Supabase, auth, and provider code on server boundaries.",
      "Use mock data only behind explicit service/API placeholders.",
      "Keep route handlers small and validate request bodies with zod when accepting input.",
      "Keep package dependencies inside the allowed stack; prefer existing generated utilities.",
    ],
    editingRules: [
      "Preserve existing working files unless the prompt directly targets them.",
      "Prefer file-scoped and component-scoped edits over whole-project rewrites.",
      "Return only changed files when editing an existing project.",
      "Do not delete user-created files unless the prompt explicitly asks.",
    ],
  }
}

export function classifyControlledAppType(prompt: string): ControlledAppType {
  const text = String(prompt || "").toLowerCase()

  if (/\b(berita|news|artikel|article|majalah|blog|portal berita|portal desa|desa|warga|bumdes|pengumuman|agenda desa|kegiatan desa)\b/.test(text)) {
    return "village_news_portal"
  }

  if (/\b(ai chat|chatbot|chat app|conversation|assistant|llm|openai|claude)\b/.test(text)) {
    return "ai_chat_app"
  }

  if (/\b(booking|reservation|appointment|schedule|calendar|slot|reservasi|janji temu|jadwal)\b/.test(text)) {
    return "booking_app"
  }

  if (/\b(crm|lead|pipeline|sales|customer relationship|pelanggan|prospect)\b/.test(text)) {
    return "lightweight_crm"
  }

  if (/\b(marketplace|e-?commerce|seller|buyer|storefront|product catalog|catalog|katalog|cart|checkout|toko|dagang|pasar)\b/.test(text)) {
    return "simple_marketplace"
  }

  if (/\b(crud|admin panel|cms|manage records|data table|moderation|moderasi)\b/.test(text)) {
    return "crud_admin_panel"
  }

  if (/\b(landing|marketing page|pricing|hero|cta|sign in|sign up|login|register|auth)\b/.test(text)) {
    return "landing_auth"
  }

  if (/\b(internal tool|ops|operation|inventory|approval|workflow|back office|business tool)\b/.test(text)) {
    return "internal_business_tool"
  }

  return "saas_dashboard"
}

export function buildDynamicSeedDirective(prompt: string) {
  const appType = classifyControlledAppType(prompt)

  if (appType === "village_news_portal") {
    return [
      "DYNAMIC_SEED_STRATEGY:",
      "- Prompt matched article/blog/news keywords.",
      "- Use static article/blog seed semantics: posts, categories, announcements, agendas, authors, and public article detail pages.",
      "- Do not add commerce revenue cards, conversion charts, order metrics, or SaaS finance dashboards unless explicitly requested.",
    ].join("\n")
  }

  if (appType === "simple_marketplace") {
    return [
      "DYNAMIC_SEED_STRATEGY:",
      "- Prompt matched commerce/catalog keywords.",
      "- Use open e-commerce catalog seed semantics: products, categories, inventory-safe placeholders, cart or inquiry flow, and seller/admin placeholders.",
      "- Keep payment flow as a safe placeholder unless the user explicitly asks for live checkout integration.",
    ].join("\n")
  }

  return [
    "DYNAMIC_SEED_STRATEGY:",
    "- Select the starter semantics from the user's explicit industry keywords only.",
    "- Do not inject unrelated SaaS, finance, commerce, or dashboard assumptions into non-commercial prompts.",
  ].join("\n")
}

export function getControlledAppBlueprint(appType: ControlledAppType) {
  return BLUEPRINTS[appType]
}

export function buildBlueprintSeedFiles(input: {
  prompt: string
  appType: ControlledAppType
  projectName?: string | null
}) {
  const blueprint = getControlledAppBlueprint(input.appType)
  return buildProjectFiles({
    prompt: `${blueprint.starterPrompt}\n\nUSER_BRIEF:\n${input.prompt}`,
    originalPrompt: input.prompt,
    projectName: input.projectName || blueprint.label,
    promptSummary: blueprint.starterPrompt,
  }).files
}

export function buildBlueprintInstructionBlock(blueprint: ControlledAppBlueprint) {
  return [
    "CONTROLLED_APP_BLUEPRINT:",
    JSON.stringify(
      {
        appType: blueprint.appType,
        label: blueprint.label,
        stack: blueprint.dependencyPolicy.stack,
        allowedExternalPackages: blueprint.dependencyPolicy.allowedExternalPackages,
        requiredFiles: blueprint.requiredFiles,
        architectureRules: blueprint.architectureRules,
        editingRules: blueprint.editingRules,
      },
      null,
      2
    ),
  ].join("\n")
}

export function validateBlueprintConstraints(
  files: GeneratedFile[],
  blueprint: ControlledAppBlueprint,
  options?: { requiredFiles?: string[] }
) {
  const paths = new Set(files.map((file) => normalizePath(file.path)))
  const requiredFiles = options?.requiredFiles || blueprint.requiredFiles
  const missingRequiredFiles = requiredFiles.filter((filePath) => !paths.has(normalizePath(filePath)))
  const forbiddenFiles = Array.from(paths).filter((filePath) =>
    blueprint.dependencyPolicy.forbiddenPatterns.some((pattern) => filePath.toLowerCase().includes(pattern.toLowerCase()))
  )

  return {
    ok: missingRequiredFiles.length === 0 && forbiddenFiles.length === 0,
    missingRequiredFiles,
    forbiddenFiles,
  }
}

function normalizePath(value: string) {
  return String(value || "").replace(/\\/g, "/").replace(/^\/+/, "").replace(/^\.\//, "").trim()
}

import type { GeneratedFile } from "@/lib/types"
import { envVarsForProvider, type SwiftStructuredIntent } from "@/lib/ai/architecture-intent"

export type SwiftArchitecturePlan = {
  mode: "architecture-plan-v1"
  frontend: {
    framework: "Next.js App Router"
    styling: "Tailwind"
    pages: string[]
  }
  backend: {
    apiRoutes: string[]
    services: string[]
  }
  database: {
    provider: string | null
    schema: string
    models: string[]
  }
  storage: {
    provider: string | null
    adapters: string[]
  }
  auth: {
    provider: string | null
    routes: string[]
  }
  payments: {
    provider: string | null
    routes: string[]
    services: string[]
  }
  integrations: Array<{
    kind: string
    provider: string
    envVars: string[]
  }>
  dependencies: string[]
  requiredEnvVars: string[]
  orchestrationStages: SwiftOrchestrationStage[]
}

export type SwiftOrchestrationStage =
  | "scaffold_generation"
  | "database_generation"
  | "backend_generation"
  | "frontend_generation"
  | "integration_generation"
  | "validation"
  | "repair"
  | "runtime_testing"
  | "preview_ready"

export function buildArchitecturePlan(input: {
  intent: SwiftStructuredIntent
  existingFiles?: GeneratedFile[]
}): SwiftArchitecturePlan {
  const intent = input.intent
  const frontendOnly = intent.type === "frontend_only"
  const modelRoutes = frontendOnly ? [] : intent.database.models.map((model) => `app/api/${routeSegmentForModel(model)}/route.ts`)
  const serviceFiles = frontendOnly
    ? []
    : unique([
        ...intent.backend.services.map((service) => `lib/services/${service}.service.ts`),
        ...intent.database.models.map((model) => `lib/services/${serviceSegmentForModel(model)}.service.ts`),
      ])
  const paymentRoutes = !frontendOnly && intent.payments.provider
    ? ["app/api/payments/checkout/route.ts", "app/api/payments/webhook/route.ts"]
    : []
  const storageAdapters = !frontendOnly && intent.storage.provider ? [`lib/storage/${String(intent.storage.provider).replace(/_/g, "-")}.ts`] : []
  const authRoutes = !frontendOnly && intent.auth.provider ? ["app/api/auth/[...nextauth]/route.ts"] : []
  const pages = pagesForIntent(intent)
  const requiredEnvVars = unique(
    intent.integrations.flatMap((integration) => integration.requiredEnvVars)
  )

  return {
    mode: "architecture-plan-v1",
    frontend: {
      framework: "Next.js App Router",
      styling: "Tailwind",
      pages,
    },
    backend: {
      apiRoutes: unique([...modelRoutes, ...paymentRoutes, ...authRoutes]),
      services: serviceFiles,
    },
    database: {
      provider: frontendOnly ? null : intent.database.provider,
      schema: !frontendOnly && intent.database.provider ? "prisma/schema.prisma" : "none",
      models: frontendOnly ? [] : intent.database.models,
    },
    storage: {
      provider: intent.storage.provider,
      adapters: storageAdapters,
    },
    auth: {
      provider: intent.auth.provider,
      routes: authRoutes,
    },
    payments: {
      provider: intent.payments.provider,
      routes: paymentRoutes,
      services: !frontendOnly && intent.payments.provider ? ["lib/services/payment.service.ts"] : [],
    },
    integrations: intent.integrations.map((integration) => ({
      kind: integration.kind,
      provider: integration.provider,
      envVars: envVarsForProvider(integration.provider),
    })),
    dependencies: dependenciesForIntent(intent),
    requiredEnvVars,
    orchestrationStages: [
      "scaffold_generation",
      "database_generation",
      "backend_generation",
      "frontend_generation",
      "integration_generation",
      "validation",
      "repair",
      "runtime_testing",
      "preview_ready",
    ],
  }
}

export function buildArchitectureInstructionBlock(plan: SwiftArchitecturePlan) {
  return [
    "STRUCTURED_ARCHITECTURE_PLAN:",
    JSON.stringify(plan, null, 2),
    "Rules:",
    "- Treat this architecture plan as orchestration input, not decoration.",
    "- Generate files only for the current slice, but keep route/service/model/env dependencies consistent with the plan.",
    "- When an integration is requested and credentials are absent, create typed server boundaries and env placeholders instead of UI-only mocks.",
    "- When editing, preserve unrelated files and evolve the existing architecture incrementally.",
  ].join("\n")
}

function pagesForIntent(intent: SwiftStructuredIntent) {
  const pages = new Set<string>(["app/page.tsx"])
  if (intent.type === "frontend_only" && (intent.archetype === "DASHBOARD_SAAS" || intent.archetype === "ADMIN_PANEL")) {
    pages.add("app/dashboard/page.tsx")
  }
  if (intent.type === "frontend_only" && intent.archetype === "BOOKING_APP") pages.add("app/booking/page.tsx")
  if (intent.type === "frontend_only" && intent.archetype === "CONTENT_PLATFORM") pages.add("app/posts/[slug]/page.tsx")
  if (intent.type === "frontend_only") return Array.from(pages)
  if (intent.archetype === "FULLSTACK_COMMERCE") {
    pages.add("app/products/page.tsx")
    pages.add("app/products/[id]/page.tsx")
    pages.add("app/cart/page.tsx")
    pages.add("app/checkout/page.tsx")
    pages.add("app/login/page.tsx")
    pages.add("app/admin/page.tsx")
    pages.add("app/orders/page.tsx")
  }
  if (intent.archetype === "DASHBOARD_SAAS" || intent.archetype === "ADMIN_PANEL") pages.add("app/dashboard/page.tsx")
  if (intent.archetype === "BOOKING_APP") pages.add("app/booking/page.tsx")
  if (intent.archetype === "CONTENT_PLATFORM") pages.add("app/posts/[slug]/page.tsx")
  if (intent.auth.provider) pages.add("app/login/page.tsx")
  return Array.from(pages)
}

function dependenciesForIntent(intent: SwiftStructuredIntent) {
  const dependencies = new Set(["next", "react", "react-dom", "typescript", "tailwindcss"])
  if (intent.type === "frontend_only") return Array.from(dependencies).sort()
  dependencies.add("zod")
  if (intent.database.provider) {
    dependencies.add("prisma")
    dependencies.add("@prisma/client")
  }
  if (intent.database.provider === "turso") dependencies.add("@libsql/client")
  if (intent.auth.provider) dependencies.add("next-auth")
  if (intent.payments.provider === "stripe") dependencies.add("stripe")
  if (intent.storage.provider === "cloudflare_r2") dependencies.add("@aws-sdk/client-s3")
  return Array.from(dependencies).sort()
}

export function routeSegmentForModel(model: string) {
  const normalized = String(model || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")
  return normalized || "items"
}

function serviceSegmentForModel(model: string) {
  const routeSegment = routeSegmentForModel(model)
  if (routeSegment.endsWith("ies")) return `${routeSegment.slice(0, -3)}y`
  if (routeSegment.endsWith("s")) return routeSegment.slice(0, -1)
  return routeSegment
}

function unique(values: string[]) {
  return Array.from(new Set(values.filter(Boolean)))
}

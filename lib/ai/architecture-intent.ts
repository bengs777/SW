import type { ControlledAppType } from "@/lib/ai/app-blueprints"

export type SwiftAppIntentType = "frontend_only" | "fullstack_app"

export type SwiftIntegrationProvider =
  | "turso"
  | "neon"
  | "postgres"
  | "supabase"
  | "cloudflare_r2"
  | "nextauth"
  | "midtrans"
  | "stripe"
  | "xendit"
  | "pakasir"
  | "unknown"

export type SwiftStructuredIntent = {
  type: SwiftAppIntentType
  domain: string
  archetype: SwiftArchitectureArchetype
  frontend: {
    framework: "nextjs"
    styling: "tailwind"
  }
  backend: {
    api: boolean
    services: string[]
    crud: string[]
  }
  database: {
    provider: SwiftIntegrationProvider | null
    models: string[]
  }
  storage: {
    provider: SwiftIntegrationProvider | null
  }
  auth: {
    provider: SwiftIntegrationProvider | null
  }
  payments: {
    provider: SwiftIntegrationProvider | null
  }
  integrations: Array<{
    kind: "database" | "storage" | "auth" | "payments" | "external_api"
    provider: SwiftIntegrationProvider
    requiredEnvVars: string[]
  }>
  businessRequirements: string[]
  normalizedKeywords: string[]
}

export type SwiftArchitectureArchetype =
  | "FULLSTACK_COMMERCE"
  | "DASHBOARD_SAAS"
  | "BOOKING_APP"
  | "CONTENT_PLATFORM"
  | "ADMIN_PANEL"
  | "PORTFOLIO_SITE"

const EXPLICIT_BACKEND_RE =
  /\b(full\s*stack|fullstack|backend|server\s*actions?|server action|api\s+routes?|api route|route handler|database|db|prisma|postgres|postgresql|neon|turso|crud|auth|login|register|session|nextauth|role|rbac|admin|payment|payments|pembayaran|stripe|midtrans|xendit|pakasir|webhook|storage|upload|r2)\b/i

const UI_ONLY_PAGE_RE =
  /\b(static|frontend\s*only|ui\s*only|homepage|home\s*page|landing|marketing\s+page|storefront|catalog|catalogue|katalog|menu|restaurant|restoran|food|makanan|soto|produk|product|cart|keranjang|checkout|hero|section|tailwind|mock\s+data|data\s+dummy)\b/i

const DOMAIN_ALIASES: Array<{ domain: string; patterns: RegExp[] }> = [
  { domain: "coffee_shop", patterns: [/\b(coffee|kopi|cafe|coffee shop|kedai kopi)\b/i] },
  { domain: "commerce_storefront", patterns: [/\b(ecommerce|e-commerce|marketplace|toko|shop|store|produk|cart|checkout)\b/i] },
  { domain: "booking", patterns: [/\b(booking|reservation|reservasi|appointment|jadwal|slot)\b/i] },
  { domain: "content_platform", patterns: [/\b(blog|news|artikel|cms|portal|content|berita)\b/i] },
  { domain: "saas_dashboard", patterns: [/\b(saas|dashboard|workspace|analytics|metrics)\b/i] },
  { domain: "portfolio", patterns: [/\b(portfolio|portofolio|profile|company profile|landing)\b/i] },
]

const MODEL_KEYWORDS: Array<{ model: string; patterns: RegExp[] }> = [
  { model: "users", patterns: [/\b(users?|pengguna|customers?|pelanggan|members?|staff|admin|role|auth|login)\b/i] },
  { model: "products", patterns: [/\b(products?|produk|catalog|katalog|menu|items?|inventory|stok)\b/i] },
  { model: "orders", patterns: [/\b(orders?|pesanan|checkout|cart|keranjang|online ordering|pemesanan)\b/i] },
  { model: "payments", patterns: [/\b(payments?|pembayaran|invoice|midtrans|stripe|xendit|pakasir)\b/i] },
  { model: "bookings", patterns: [/\b(bookings?|reservasi|reservation|appointment|jadwal|slot)\b/i] },
  { model: "posts", patterns: [/\b(posts?|artikel|articles?|news|berita|blog|content)\b/i] },
  { model: "assets", patterns: [/\b(assets?|files?|storage|upload|image|gambar|lampiran|r2|bucket)\b/i] },
]

const SERVICE_KEYWORDS: Array<{ service: string; patterns: RegExp[] }> = [
  { service: "orders", patterns: [/\b(orders?|pesanan|checkout|cart|keranjang|online ordering)\b/i] },
  { service: "payments", patterns: [/\b(payments?|pembayaran|midtrans|stripe|xendit|pakasir|webhook)\b/i] },
  { service: "products", patterns: [/\b(products?|produk|catalog|katalog|menu|inventory)\b/i] },
  { service: "auth", patterns: [/\b(auth|login|register|session|nextauth|role|rbac)\b/i] },
  { service: "storage", patterns: [/\b(storage|upload|asset|file|image|r2|bucket)\b/i] },
  { service: "bookings", patterns: [/\b(booking|reservation|reservasi|appointment|jadwal)\b/i] },
  { service: "content", patterns: [/\b(blog|news|cms|artikel|post|category)\b/i] },
]

export function parseStructuredIntent(input: {
  prompt: string
  appType?: ControlledAppType
}): SwiftStructuredIntent {
  const text = normalizeText(input.prompt)
  const providers = detectProviders(text)
  const hardFrontendOnly = isHardFrontendOnlyPrompt(input.prompt)
  const explicitFullstack = !hardFrontendOnly && hasExplicitBackendRequest(text)
  const services = explicitFullstack
    ? unique(SERVICE_KEYWORDS.filter((item) => item.patterns.some((pattern) => pattern.test(text))).map((item) => item.service))
    : []
  const crudModels = explicitFullstack
    ? unique(MODEL_KEYWORDS.filter((item) => item.patterns.some((pattern) => pattern.test(text))).map((item) => item.model))
    : []
  const businessRequirements = explicitFullstack ? inferBusinessRequirements(text, services, crudModels) : []
  const type: SwiftAppIntentType = explicitFullstack ? "fullstack_app" : "frontend_only"
  const domain = detectDomain(text, input.appType)
  const databaseProvider = type === "fullstack_app"
    ? providers.database || (/\b(database|db|prisma|crud)\b/i.test(text) ? "postgres" : null)
    : null
  const authProvider = type === "fullstack_app"
    ? providers.auth || (/\b(auth|login|register|session|user|role|rbac)\b/i.test(text) ? "nextauth" : null)
    : null
  const paymentProvider = type === "fullstack_app"
    ? providers.payments || (/\b(payment|payments|pembayaran|stripe|midtrans|xendit|pakasir)\b/i.test(text) ? "midtrans" : null)
    : null
  const storageProvider = type === "fullstack_app" ? providers.storage || null : null
  const models = inferModels({ domain, type, crudModels, services, databaseProvider, paymentProvider, storageProvider, authProvider })

  return {
    type,
    domain,
    archetype: selectArchetype({ text, domain, appType: input.appType }),
    frontend: {
      framework: "nextjs",
      styling: "tailwind",
    },
    backend: {
      api: type === "fullstack_app" && /\b(api|api\s+routes?|route handler|crud|webhook|backend|server action)\b/i.test(text),
      services,
      crud: crudModels,
    },
    database: {
      provider: databaseProvider,
      models,
    },
    storage: {
      provider: storageProvider,
    },
    auth: {
      provider: authProvider,
    },
    payments: {
      provider: paymentProvider,
    },
    integrations: buildIntegrations({ databaseProvider, storageProvider, authProvider, paymentProvider }),
    businessRequirements,
    normalizedKeywords: unique(text.split(" ").filter((word) => word.length > 2)).slice(0, 40),
  }
}

function detectProviders(text: string) {
  return {
    database: /\bturso\b/i.test(text)
      ? "turso" as const
      : /\bneon\b/i.test(text)
        ? "neon" as const
        : /\b(postgres|postgresql)\b/i.test(text)
          ? "postgres" as const
          : /\bsupabase\b/i.test(text)
            ? "supabase" as const
            : null,
    storage: /\b(cloudflare\s*r2|r2)\b/i.test(text)
      ? "cloudflare_r2" as const
      : /\bsupabase\s+storage|storage\s+supabase\b/i.test(text)
        ? "supabase" as const
        : null,
    auth: /\b(nextauth|next-auth)\b/i.test(text) ? "nextauth" as const : null,
    payments: /\bmidtrans\b/i.test(text)
      ? "midtrans" as const
      : /\bstripe\b/i.test(text)
        ? "stripe" as const
        : /\bxendit\b/i.test(text)
          ? "xendit" as const
          : /\bpakasir\b/i.test(text)
            ? "pakasir" as const
            : null,
  }
}

function detectDomain(text: string, appType?: ControlledAppType) {
  const matched = DOMAIN_ALIASES.find((item) => item.patterns.some((pattern) => pattern.test(text)))
  if (matched) return matched.domain
  if (appType === "simple_marketplace") return "commerce_storefront"
  if (appType === "booking_app") return "booking"
  if (appType === "saas_dashboard") return "saas_dashboard"
  if (appType === "village_news_portal") return "content_platform"
  if (appType === "sports_portfolio") return "portfolio"
  return "custom_web_app"
}

function selectArchetype(input: { text: string; domain: string; appType?: ControlledAppType }): SwiftArchitectureArchetype {
  if (isHardFrontendOnlyPrompt(input.text)) return "PORTFOLIO_SITE"
  if (/\b(booking|reservation|reservasi|appointment|jadwal)\b/i.test(input.text) || input.appType === "booking_app") return "BOOKING_APP"
  if (/\b(saas|dashboard|workspace|analytics|metrics)\b/i.test(input.text) || input.appType === "saas_dashboard") return "DASHBOARD_SAAS"
  if (/\b(blog|news|cms|artikel|portal|content|berita)\b/i.test(input.text) || input.appType === "village_news_portal") return "CONTENT_PLATFORM"
  if (/\b(admin panel|crud|back office|internal tool)\b/i.test(input.text) || input.appType === "crud_admin_panel") return "ADMIN_PANEL"
  if (/\b(portfolio|portofolio|company profile|profile)\b/i.test(input.text) || input.appType === "sports_portfolio") return "PORTFOLIO_SITE"
  if (input.domain === "coffee_shop" || input.domain === "commerce_storefront" || input.appType === "simple_marketplace") return "FULLSTACK_COMMERCE"
  return input.appType === "landing_auth" ? "PORTFOLIO_SITE" : "ADMIN_PANEL"
}

export function hasExplicitBackendRequest(prompt: string) {
  return EXPLICIT_BACKEND_RE.test(normalizeText(prompt))
}

export function isHardFrontendOnlyPrompt(prompt: string) {
  const text = normalizeText(prompt)
  if (!text) return false
  if (hasExplicitBackendRequest(text)) return false
  return UI_ONLY_PAGE_RE.test(text)
}

function inferModels(input: {
  domain: string
  type: SwiftAppIntentType
  crudModels: string[]
  services: string[]
  databaseProvider: SwiftIntegrationProvider | null
  paymentProvider: SwiftIntegrationProvider | null
  storageProvider: SwiftIntegrationProvider | null
  authProvider: SwiftIntegrationProvider | null
}) {
  const models = new Set(input.crudModels)
  if (input.type === "fullstack_app" && input.databaseProvider) {
    if (input.authProvider) models.add("users")
    if (input.domain === "coffee_shop" || input.domain === "commerce_storefront") {
      models.add("products")
      models.add("orders")
    }
    if (input.domain === "booking") models.add("bookings")
    if (input.domain === "content_platform") models.add("posts")
  }
  if (input.paymentProvider) {
    models.add("orders")
    models.add("payments")
  }
  if (input.storageProvider) models.add("assets")
  return Array.from(models)
}

function buildIntegrations(input: {
  databaseProvider: SwiftIntegrationProvider | null
  storageProvider: SwiftIntegrationProvider | null
  authProvider: SwiftIntegrationProvider | null
  paymentProvider: SwiftIntegrationProvider | null
}) {
  const integrations: SwiftStructuredIntent["integrations"] = []
  if (input.databaseProvider) integrations.push({ kind: "database", provider: input.databaseProvider, requiredEnvVars: envVarsForProvider(input.databaseProvider) })
  if (input.storageProvider) integrations.push({ kind: "storage", provider: input.storageProvider, requiredEnvVars: envVarsForProvider(input.storageProvider) })
  if (input.authProvider) integrations.push({ kind: "auth", provider: input.authProvider, requiredEnvVars: envVarsForProvider(input.authProvider) })
  if (input.paymentProvider) integrations.push({ kind: "payments", provider: input.paymentProvider, requiredEnvVars: envVarsForProvider(input.paymentProvider) })
  return integrations
}

export function envVarsForProvider(provider: SwiftIntegrationProvider) {
  const byProvider: Record<SwiftIntegrationProvider, string[]> = {
    turso: ["TURSO_DATABASE_URL", "TURSO_AUTH_TOKEN"],
    neon: ["DATABASE_URL"],
    postgres: ["DATABASE_URL"],
    supabase: ["NEXT_PUBLIC_SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_ANON_KEY", "SUPABASE_SERVICE_ROLE_KEY"],
    cloudflare_r2: ["R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_BUCKET_NAME", "R2_PUBLIC_BASE_URL"],
    nextauth: ["NEXTAUTH_SECRET", "NEXTAUTH_URL"],
    midtrans: ["MIDTRANS_SERVER_KEY", "MIDTRANS_CLIENT_KEY", "MIDTRANS_IS_PRODUCTION"],
    stripe: ["STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET", "NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY"],
    xendit: ["XENDIT_SECRET_KEY", "XENDIT_WEBHOOK_TOKEN"],
    pakasir: ["PAKASIR_SLUG", "PAKASIR_API_KEY"],
    unknown: [],
  }
  return byProvider[provider] || []
}

function inferBusinessRequirements(text: string, services: string[], models: string[]) {
  const requirements = new Set<string>()
  for (const service of services) requirements.add(`${service}_service`)
  for (const model of models) requirements.add(`${model}_crud`)
  if (/\b(online ordering|checkout|cart|keranjang|pesanan)\b/i.test(text)) requirements.add("checkout_flow")
  if (/\b(webhook)\b/i.test(text)) requirements.add("webhook_handler")
  if (/\b(admin|staff|role|rbac)\b/i.test(text)) requirements.add("role_based_admin")
  return Array.from(requirements)
}

function normalizeText(value: string) {
  return String(value || "").toLowerCase().replace(/[^a-z0-9\u00c0-\u024f\s-]+/g, " ").replace(/\s+/g, " ").trim()
}

function unique(values: string[]) {
  return Array.from(new Set(values.filter(Boolean)))
}

import type { ProjectMemoryData } from "@/lib/types"

type PromptDraft = {
  projectName: string
  productType: string
  coreGoal: string
  pages: string[]
  features: string[]
  apiRoutes: string[]
  dataModels: string[]
  uiStyle: string[]
  assumptions: string[]
  microTasks: string[]
  deliveryRules: string[]
}

type PromptWorkPlan = {
  mode: "build" | "patch"
  objective: string
  focusSlice: string
  filePriority: string[]
  previewChecks: string[]
  repairLoop: string[]
  constraints: string[]
}

type PromptMemorySeed = ProjectMemoryData

export type PromptEnhancementResult = {
  prompt: string
  summary: string
  sourcesUsed: string[]
  usedEnhancement: boolean
  plan: PromptWorkPlan
  projectMemory: PromptMemorySeed
}

const MAX_ITEMS_PER_SECTION = 5

export async function enhancePromptWithAgentRouter({
  prompt,
  modelName,
}: {
  prompt: string
  modelName: string
}): Promise<PromptEnhancementResult> {
  void modelName
  const draft = buildLocalPromptDraft(prompt)
  const plan = buildPromptWorkPlan(prompt, draft)
  const projectMemory = buildProjectMemorySeed(draft, plan)
  return {
    prompt: serializeDraft(prompt, draft, plan, projectMemory),
    summary: draft.microTasks[0] || draft.coreGoal || draft.productType || inferFallbackSummary(prompt),
    sourcesUsed: ["local-heuristic"],
    usedEnhancement: true,
    plan,
    projectMemory,
  }
}

function buildLocalPromptDraft(prompt: string): PromptDraft {
  const compactPrompt = inlineText(prompt)
  const normalized = compactPrompt.toLowerCase()

  const looksLikeWorkspace = hasAny(normalized, [
    "workspace",
    "replit",
    "lovable",
    "file explorer",
    "file tree",
    "live preview",
    "terminal",
    "code editor",
    "output panel",
  ])

  const looksLikeDashboard = hasAny(normalized, ["dashboard", "admin panel", "panel admin", "analytics", "analitik", "laporan"])
  const looksLikeAuth = hasAny(normalized, ["login", "sign in", "signin", "auth", "register", "daftar", "signup", "masuk"])
  const looksLikeLanding = hasAny(normalized, ["landing", "hero", "marketing", "company profile", "profil perusahaan", "satu halaman"])
  const looksLikeStore = hasAny(normalized, ["shop", "ecommerce", "e-commerce", "store", "toko", "toko online", "jualan", "produk", "katalog", "checkout", "keranjang"])
  const looksLikePortfolio = hasAny(normalized, ["portfolio", "portofolio", "personal brand", "resume", "cv", "showcase", "project gallery"])
  const looksLikeBooking = hasAny(normalized, ["booking", "reservation", "reservasi", "appointment", "janji temu", "jadwal", "slot"])
  const looksLikeCrm = hasAny(normalized, ["crm", "pipeline", "lead management", "lead", "sales", "prospek", "pelanggan"])
  // Only detect blog/news/article INTENTIONALLY - not vague mentions of "content"
  // Require explicit keywords: blog, news, article, berita, magazine, media, content portal
  const looksLikeBlog = hasAny(normalized, ["blog", "berita", "news", "artikel", "article", "magazine", "majalah", "media", "portal konten", "content portal"]) ||
    (normalized.includes("content") && (normalized.includes("blog") || normalized.includes("website") || normalized.includes("portal") || normalized.includes("management")))
  const looksLikeTrading = hasAny(normalized, [
    "trading",
    "forex",
    "crypto",
    "kripto",
    "saham",
    "mata uang",
    "currency",
    "exchange",
    "market",
    "candlestick",
    "order book",
    "watchlist",
    "portfolio",
    "posisi",
  ])
  const looksLikeLaundry = hasAny(normalized, ["laundry", "cuci", "dry clean", "setrika"])
  const looksLikeClinic = hasAny(normalized, ["klinik", "dokter", "pasien", "rekam medis", "medical", "clinic"])
  const looksLikeSchool = hasAny(normalized, ["sekolah", "kampus", "siswa", "guru", "kelas", "course", "kursus", "e-learning", "elearning"])
  const looksLikeRestaurant = hasAny(normalized, ["restoran", "restaurant", "cafe", "kafe", "kopi", "menu", "reservasi meja"])
  const looksLikeSalon = hasAny(normalized, ["salon", "barbershop", "spa", "kecantikan", "haircut", "massage"])
  const looksLikeRental = hasAny(normalized, ["rental", "sewa", "booking kendaraan", "car rental", "bike rental"])
  const looksLikeSaaS = hasAny(normalized, ["saas", "software as a service", "subscription", "langganan"])
  const looksLikeLandingPage = hasAny(normalized, ["landing", "marketing"]) && !looksLikeBooking && !looksLikeLanding

  const projectName = inferProjectName(compactPrompt)
  const productType =
    looksLikeWorkspace
      ? "developer workspace"
      : looksLikeTrading
        ? "financial trading dashboard"
      : looksLikeLaundry
        ? "laundry service web app"
      : looksLikeClinic
        ? "clinic appointment web app"
      : looksLikeRestaurant
        ? "restaurant management website"
      : looksLikeSalon
        ? "salon booking web app"
      : looksLikeRental
        ? "rental management web app"
      : looksLikeDashboard
        ? "dashboard web app"
      : looksLikeAuth
        ? "authentication-focused web app"
        : looksLikeLanding
          ? "marketing landing page"
        : looksLikeStore
            ? "e-commerce storefront"
          : looksLikePortfolio
            ? "personal brand portfolio website"
            : looksLikeBooking
              ? "booking and reservation web app"
              : looksLikeCrm
                ? "internal CRM business tool"
                : looksLikeSchool
                  ? "education platform"
                  : looksLikeBlog
                    ? "blog or news website"
                    : looksLikeSaaS
                      ? "SaaS dashboard"
                      : "custom full-stack web app"

  const pages = dedupeItems([
    looksLikeWorkspace ? "Explorer" : "Homepage",
    looksLikeWorkspace ? "Editor" : "",
    looksLikeWorkspace ? "Preview" : "",
    looksLikeWorkspace ? "Terminal" : "",
    looksLikeWorkspace ? "History" : "",
    looksLikeTrading ? "Trading dashboard" : "",
    looksLikeTrading ? "Market watchlist" : "",
    looksLikeTrading ? "Portfolio and positions page" : "",
    looksLikeAuth ? "Login page" : "",
    looksLikeDashboard ? "Dashboard page" : "",
    looksLikeStore ? "Product listing page" : "",
    looksLikePortfolio ? "Portfolio page" : "",
    looksLikeBooking ? "Booking flow page" : "",
    looksLikeCrm ? "CRM pipeline page" : "",
    looksLikeBlog ? "Article listing page" : "",
    looksLikeLaundry ? "Service order page" : "",
    looksLikeClinic ? "Doctor appointment page" : "",
    looksLikeSchool ? "Course or class page" : "",
    looksLikeRestaurant ? "Menu and reservation page" : "",
    looksLikeSalon ? "Service booking page" : "",
    looksLikeRental ? "Vehicle or item listing page" : "",
  ])

  const features = dedupeItems([
    looksLikeWorkspace ? "File explorer, editor, preview, and output panels" : looksLikeAuth ? "Form validation and auth-ready UI" : "Responsive layout and polished UI",
    looksLikeWorkspace ? "Patch-first iteration and clear file state" : "",
    looksLikeWorkspace ? "Keyboard-first command bar and quick actions" : "",
    looksLikeWorkspace ? "Share link and version history hooks" : "",
    looksLikeTrading ? "Live-style FX/crypto watchlist, price cards, and market movement summary" : "",
    looksLikeTrading ? "Candlestick/chart placeholder, order ticket, open positions, and risk summary" : "",
    looksLikeTrading ? "Trading activity feed, wallet balance, and market news widgets" : "",
    looksLikeDashboard ? "Data cards, tables, and activity sections" : "",
    looksLikeStore ? "Product cards and call-to-action sections" : "",
    looksLikePortfolio ? "Project gallery, service highlights, and contact conversion flow" : "",
    looksLikeBooking ? "Availability calendar, reservation form, and booking confirmation" : "",
    looksLikeCrm ? "Lead list, deal pipeline, and task tracking workflow" : "",
    looksLikeBlog ? "Article list, search, and category filter" : "",
    looksLikeLaundry ? "Service packages, pickup scheduling, and order status" : "",
    looksLikeClinic ? "Doctor profiles, appointment booking, and patient-friendly service info" : "",
    looksLikeSchool ? "Programs, class schedule, student/admin-oriented sections" : "",
    looksLikeRestaurant ? "Menu highlights, table reservation, and location/contact CTA" : "",
    looksLikeSalon ? "Service catalog, booking calendar, stylist profiles, and confirmation" : "",
    looksLikeRental ? "Item/vehicle listing, availability calendar, rental form, and booking tracking" : "",
    "Responsive navigation, clear CTA, loading states, and empty states",
    "Reusable components and clean state handling",
  ])

  const apiRoutes = dedupeItems([
    looksLikeWorkspace ? "/api/projects/[id]/run" : "/api/health",
    looksLikeWorkspace ? "/api/projects/[id]/share" : "",
    looksLikeWorkspace ? "/api/projects/[id]/history" : "",
    looksLikeWorkspace ? "/api/projects/[id]/files" : "",
    looksLikeTrading ? "/api/markets" : "",
    looksLikeTrading ? "/api/positions" : "",
    looksLikeTrading ? "/api/orders" : "",
    looksLikeAuth ? "/api/auth/login" : "",
    looksLikeDashboard ? "/api/dashboard/summary" : "",
    looksLikeStore ? "/api/products" : "",
    looksLikePortfolio ? "/api/contact" : "",
    looksLikeBooking ? "/api/bookings" : "",
    looksLikeCrm ? "/api/leads" : "",
    looksLikeBlog ? "/api/articles" : "",
    looksLikeLaundry ? "/api/orders" : "",
    looksLikeClinic ? "/api/appointments" : "",
    looksLikeSchool ? "/api/classes" : "",
    looksLikeRestaurant ? "/api/reservations" : "",
    looksLikeSalon ? "/api/services" : "",
    looksLikeRental ? "/api/items" : "",
  ])

  const dataModels = dedupeItems([
    looksLikeWorkspace ? "ProjectFile" : looksLikeAuth ? "User" : "",
    looksLikeWorkspace ? "RunSession" : "",
    looksLikeWorkspace ? "ShareLink" : "",
    looksLikeWorkspace ? "GenerationHistory" : "",
    looksLikeTrading ? "MarketPair" : "",
    looksLikeTrading ? "TradeOrder" : "",
    looksLikeTrading ? "Position" : "",
    looksLikeDashboard ? "DashboardMetric" : "",
    looksLikeStore ? "Product" : "",
    looksLikePortfolio ? "ProjectShowcase" : "",
    looksLikeBooking ? "BookingSlot" : "",
    looksLikeCrm ? "Lead" : "",
    looksLikeBlog ? "Article" : "",
    looksLikeLaundry ? "LaundryOrder" : "",
    looksLikeClinic ? "Appointment" : "",
    looksLikeSchool ? "Class" : "",
    looksLikeRestaurant ? "Reservation" : "",
    looksLikeSalon ? "SalonService" : "",
    looksLikeRental ? "RentalItem" : "",
  ])

  const uiStyle = dedupeItems([
    looksLikeWorkspace ? "IDE-like split panes and dense hierarchy" : looksLikeTrading ? "Dense financial terminal with clear risk hierarchy" : "Modern and production-ready",
    looksLikeWorkspace ? "Fast feedback loop with visible status and logs" : "Responsive spacing and clear hierarchy",
    looksLikeWorkspace ? "Opinionated, tasteful default layout" : "Conversion-focused hierarchy with strong CTA placement",
  ])

  const assumptions = dedupeItems([
    compactPrompt.length < 12 ? "User request is brief, so sensible starter defaults are applied." : "",
    "Any missing section is treated as optional and filled with the smallest reasonable default.",
    "Use Next.js app router with lightweight server endpoints.",
    looksLikeWorkspace ? "Prefer patch-first iteration over full regeneration when a project already exists." : "Keep scope practical for a starter project.",
    looksLikeWorkspace ? "Keep preview as a feedback loop and expose runtime errors clearly." : "",
  ])

  const microTasks = dedupeItems([
    looksLikeWorkspace
      ? "Build the smallest stable workspace shell first: layout, file explorer, editor, and preview container."
      : looksLikeTrading
        ? "Build the trading dashboard first: watchlist, chart area, order ticket, positions, and risk summary."
      : looksLikeLaundry
        ? "Build the laundry order intake and admin tracking flow first: order form, service packages, status metrics, and order table."
      : looksLikeDashboard
        ? "Build the main dashboard shell first: navigation, header, and one high-value KPI section."
        : looksLikeAuth
          ? "Build the primary auth flow first: sign-in, validation, and session-ready structure."
        : looksLikeLanding
            ? "Build the hero and primary CTA first, then add supporting sections only if needed."
            : looksLikeStore
              ? "Build the product listing and primary purchase path first."
              : looksLikePortfolio
                ? "Build a hero + proof + project showcase slice with one strong contact CTA first."
                : looksLikeBooking
                  ? "Build the reservation path first: availability, booking form, and confirmation feedback."
                  : looksLikeCrm
                    ? "Build the lead pipeline core first: list, status transitions, and owner visibility."
                : looksLikeBlog
                  ? "Build the article list with search and category filter first."
                  : looksLikeClinic
                      ? "Build the clinic service and appointment booking flow first."
                      : looksLikeSchool
                        ? "Build the program overview and class schedule slice first."
                        : looksLikeRestaurant
                          ? "Build the menu and reservation CTA slice first."
                          : looksLikeSalon
                            ? "Build the service catalog and booking calendar first."
                            : looksLikeRental
                              ? "Build the item/vehicle listing and availability calendar first."
                  : "Build the next smallest coherent slice first instead of the entire app at once.",
    looksLikeWorkspace
      ? "Add preview, logs, and version-history wiring only after the shell is stable."
      : looksLikeLaundry
        ? "Add pickup, delivery, payment, and customer notification modules only after the order table renders correctly."
      : looksLikeDashboard
        ? "Add supporting tables, charts, or detail views in the next pass only if the first slice is stable."
        : "Keep the response scoped to one meaningful increment and avoid unnecessary rewrites.",
    "If the request is broad, choose the highest-impact slice and defer the rest to the next prompt.",
  ])

  const deliveryRules = dedupeItems([
    "Patch existing files first when editing an existing project.",
    "Return only the files you changed or created.",
    "Keep the output browser-safe and previewable when a frontend file is involved.",
    "Include a visible build/status section in the preview that lists ready modules, partial modules, planned modules, errors, and next steps.",
    "For large products, implement one visible module per response and keep later modules explicitly marked as planned instead of creating empty folders only.",
    "Prefer preview/ sibling files or .preview variants for browser-rendered pages when needed.",
    "Avoid adding new libraries or architectural layers unless the request explicitly requires them.",
    !looksLikeBlog ? "Do NOT generate news layouts, blog headlines, 'topik populer', content feed sections, or news-style cards unless user explicitly asks for blog or news website." : "",
  ])

  // Debug logging for intent detection
  console.log("[v0] Prompt intent analysis:", {
    originalPrompt: compactPrompt.substring(0, 100),
    detectedProjectType: productType,
    blogDetected: looksLikeBlog,
    laundryDetected: looksLikeLaundry,
    restaurantDetected: looksLikeRestaurant,
    salonDetected: looksLikeSalon,
    rentalDetected: looksLikeRental,
    sampleFeatures: features.slice(0, 3),
  })

  return {
    projectName,
    productType,
    coreGoal: compactPrompt || (looksLikeWorkspace ? "Build a Lovable-style developer workspace starter." : "Build a polished web app starter."),
    pages,
    features,
    apiRoutes,
    dataModels,
    uiStyle,
    assumptions,
    microTasks,
    deliveryRules,
  }
}

function buildPromptWorkPlan(prompt: string, draft: PromptDraft): PromptWorkPlan {
  const normalized = inlineText(prompt).toLowerCase()
  const isPatchRequest =
    /(patch|continue existing project|existing project|current project file tree|project ini|this project|perbaiki|fix|edit this|refine|improve|enhance|debug|investigasi)/.test(normalized) ||
    draft.microTasks.some((item) => /patch|refine|improve|debug|inspect/i.test(item))

  return {
    mode: isPatchRequest ? "patch" : "build",
    objective: draft.coreGoal,
    focusSlice: draft.microTasks[0] || draft.coreGoal,
    filePriority: buildFilePriority(draft),
    previewChecks: buildPreviewChecks(draft, isPatchRequest),
    repairLoop: [
      "If preview fails, inspect the active file and the latest preview error first.",
      "Patch the smallest failing file before widening the change set.",
      "Re-run preview-safe syntax validation after the patch.",
      "Keep the fix localized and do not regenerate the whole project unless the slice is unrecoverable.",
    ],
    constraints: dedupeItems([
      ...draft.assumptions.slice(0, 3),
      ...draft.deliveryRules,
      "Do not add new libraries or architectural layers unless the request explicitly requires them.",
    ]),
  }
}

function buildFilePriority(draft: PromptDraft) {
  const isWorkspace = draft.pages.some((page) => ["Explorer", "Editor", "Preview", "Terminal", "History"].includes(page)) ||
    draft.features.some((feature) => /file explorer|preview|terminal|version history/i.test(feature))
  const isDashboard = draft.pages.some((page) => page === "Dashboard page")
  const isTrading = draft.pages.some((page) => /trading|market|position/i.test(page)) ||
    draft.features.some((feature) => /watchlist|order ticket|position|market|candlestick|trading/i.test(feature))
  const isCommerce = draft.features.some((feature) => /purchase|product cards|checkout|store/i.test(feature))
  const isPortfolio = draft.features.some((feature) => /project gallery|contact conversion|personal brand/i.test(feature))
  const isBooking = draft.features.some((feature) => /reservation|booking|availability/i.test(feature))
  const isCrm = draft.features.some((feature) => /lead|pipeline|crm/i.test(feature))
  const isLaundry = draft.features.some((feature) => /laundry|pickup scheduling|order status|service packages/i.test(feature)) ||
    draft.dataModels.some((model) => /LaundryOrder/i.test(model))
  const isAuth = draft.features.some((feature) => /auth-ready|validation/i.test(feature))

  if (isWorkspace) {
    return [
      "app/page.tsx",
      "app/layout.tsx",
      "components/editor/chat-panel.tsx",
      "components/editor/preview-panel.tsx",
      "components/editor/error-log-panel.tsx",
      "components/dashboard/sidebar.tsx",
      "app/api/generate/route.ts",
      "app/api/health/route.ts",
      "lib/services/project.service.ts",
      "prisma/schema.prisma",
    ]
  }

  if (isTrading) {
    return [
      "app/page.tsx",
      "app/api/markets/route.ts",
      "app/api/orders/route.ts",
      "app/api/positions/route.ts",
      "lib/services/trading.service.ts",
      "prisma/schema.prisma",
      "app/layout.tsx",
      "app/globals.css",
    ]
  }

  if (isLaundry) {
    return [
      "app/page.tsx",
      "app/api/orders/route.ts",
      "lib/services/laundry.service.ts",
      "prisma/schema.prisma",
      "app/layout.tsx",
      "app/globals.css",
    ]
  }

  if (isDashboard) {
    return [
      "app/page.tsx",
      "components/dashboard/sidebar.tsx",
      "app/api/dashboard/summary/route.ts",
      "lib/services/dashboard.service.ts",
      "app/layout.tsx",
      "prisma/schema.prisma",
    ]
  }

  if (isCommerce) {
    return [
      "app/page.tsx",
      "app/api/products/route.ts",
      "app/api/orders/route.ts",
      "lib/services/catalog.service.ts",
      "prisma/schema.prisma",
      "components/ui/button.tsx",
      "components/ui/card.tsx",
    ]
  }

  if (isPortfolio) {
    return [
      "app/page.tsx",
      "app/api/contact/route.ts",
      "components/ui/button.tsx",
      "components/ui/card.tsx",
      "app/layout.tsx",
      "prisma/schema.prisma",
    ]
  }

  if (isBooking) {
    return [
      "app/page.tsx",
      "app/api/bookings/route.ts",
      "lib/services/booking.service.ts",
      "components/ui/form.tsx",
      "app/layout.tsx",
      "prisma/schema.prisma",
    ]
  }

  if (isCrm) {
    return [
      "app/page.tsx",
      "app/api/leads/route.ts",
      "lib/services/crm.service.ts",
      "components/ui/table.tsx",
      "app/layout.tsx",
      "prisma/schema.prisma",
    ]
  }

  if (isAuth) {
    return [
      "app/page.tsx",
      "app/api/auth/[...nextauth]/route.ts",
      "lib/auth.ts",
      "app/layout.tsx",
      "prisma/schema.prisma",
    ]
  }

  return [
    "app/page.tsx",
    "app/layout.tsx",
    "app/api/health/route.ts",
    "lib/utils.ts",
    "prisma/schema.prisma",
  ]
}

function buildPreviewChecks(draft: PromptDraft, isPatchRequest: boolean) {
  const checks = [
    "Open app/page.tsx in browser preview and confirm it renders without syntax errors.",
    "Keep browser-facing files client-safe and avoid server-only imports in preview files.",
    "Validate the smallest changed file first before expanding to supporting modules.",
  ]

  if (isPatchRequest) {
    checks.push("If preview errors appear, patch the broken existing file instead of regenerating the whole tree.")
  }

  if (draft.pages.includes("Explorer") || draft.features.some((feature) => /preview/i.test(feature))) {
    checks.push("Keep preview/tab state and editor state consistent while patching the workspace shell.")
  }

  return dedupeItems(checks)
}

function buildProjectMemorySeed(draft: PromptDraft, plan: PromptWorkPlan): PromptMemorySeed {
  const notes = dedupeItems([
    `Plan mode: ${plan.mode}`,
    plan.focusSlice,
    ...draft.microTasks.slice(0, 3),
    ...draft.assumptions.slice(0, 3),
  ])

  return {
    framework: "next",
    uiStyle: draft.uiStyle[0] || null,
    database: draft.dataModels.length > 0 ? "Prisma + SQLite" : null,
    auth: draft.features.some((feature) => /auth|login|session/i.test(feature)) ? "session-ready" : null,
    folderRules: "Patch existing files first; keep browser-facing files preview-safe; prefer preview/ sibling files or .preview variants when the browser needs a safe entrypoint.",
    naming: draft.projectName,
    notes,
  }
}

function serializeDraft(originalPrompt: string, draft: PromptDraft, plan: PromptWorkPlan, projectMemory: PromptMemorySeed) {
  const sections = [
    `User request (verbatim): "${inlineText(originalPrompt)}"`,
    "SOURCE_OF_TRUTH: the user request above and attached context override every inferred field below.",
    "USER_FACTS: treat only words explicitly present in the user request as facts. Inferred fields are planning aids, not permission to change the product domain.",
    "RELEVANCE_RULE: the generated app must visibly match the user's domain, goal, and required features. Do not replace a specific user domain with a generic SaaS, dashboard, or landing page.",
    draft.projectName ? `Working title (inferred): ${draft.projectName}` : "",
    draft.productType ? `Detected product type (inferred): ${draft.productType}` : "",
    draft.coreGoal ? `Primary goal (inferred): ${draft.coreGoal}` : "",
    formatSection("Inferred screens or pages", draft.pages),
    formatSection("Inferred features", draft.features),
    formatSection("Suggested API routes (only if needed)", draft.apiRoutes),
    formatSection("Suggested data models (only if needed)", draft.dataModels),
    formatSection("UI direction", draft.uiStyle),
    formatSection("Assumptions", draft.assumptions),
    formatSection("Micro-task focus", draft.microTasks),
    formatSection("Delivery rules", draft.deliveryRules),
    "WORKPLAN_JSON (source of truth for execution order; do not skip patch-first steps or invent new scope):",
    JSON.stringify(plan, null, 2),
    "PROJECT_MEMORY_SEED (persist these decisions across future iterations):",
    JSON.stringify(projectMemory, null, 2),
    "Preview rule: keep browser-facing files self-contained, preview-safe, and aligned with the user brief.",
  ].filter(Boolean)

  return sections.join("\n\n")
}

function formatSection(title: string, items: string[]) {
  if (items.length === 0) {
    return ""
  }

  return `${title}:\n- ${items.slice(0, MAX_ITEMS_PER_SECTION).join("\n- ")}`
}

function hasAny(value: string, signals: string[]) {
  return signals.some((signal) => value.includes(signal))
}

function normalizeText(value: unknown) {
  if (typeof value !== "string") {
    return ""
  }

  return value.replace(/\s+/g, " ").trim()
}

function normalizeList(value: unknown) {
  if (!Array.isArray(value)) {
    return []
  }

  return value
    .map((item) => normalizeText(item))
    .filter(Boolean)
}

function dedupeItems(items: string[]) {
  return items.filter(Boolean).filter((item, index, list) => list.indexOf(item) === index)
}

function inferProjectName(prompt: string) {
  const cleaned = prompt
    .replace(/[^a-zA-Z0-9\s-]/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 3)
    .join(" ")
    .trim()

  if (!cleaned) {
    return "Starter Project"
  }

  return cleaned
    .split(/\s+/)
    .map((part) => part[0].toUpperCase() + part.slice(1))
    .join(" ")
}

function inlineText(value: string) {
  return value.replace(/\s+/g, " ").trim().replace(/"/g, "'")
}

function inferFallbackSummary(prompt: string) {
  const compactPrompt = inlineText(prompt)
  if (!compactPrompt) {
    return "Build a polished web app starter."
  }

  if (compactPrompt.length <= 60) {
    return `Build a polished web app starter inspired by "${compactPrompt}".`
  }

  return compactPrompt
}

function buildFallbackEnhancement(prompt: string): PromptEnhancementResult {
  return {
    prompt,
    summary: inferFallbackSummary(prompt),
    sourcesUsed: [],
    usedEnhancement: false,
    plan: {
      mode: "build",
      objective: inferFallbackSummary(prompt),
      focusSlice: inferFallbackSummary(prompt),
      filePriority: [],
      previewChecks: [],
      repairLoop: [],
      constraints: [],
    },
    projectMemory: {
      notes: [],
    },
  }
}

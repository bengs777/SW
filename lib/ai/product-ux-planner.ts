import type { SwiftArchitecturePlan } from "@/lib/ai/architecture-planner"
import type { SwiftStructuredIntent } from "@/lib/ai/architecture-intent"

export type UXDensity = "compact" | "balanced" | "editorial"

export type UXProductScreen = {
  route: string
  purpose: string
  sections: string[]
  primaryActions: string[]
  states: string[]
}

export type UXProductFlow = {
  name: string
  entry: string
  steps: string[]
}

export type UXProductPlan = {
  mode: "ux-product-plan-v1"
  domain: string
  audience: string
  primaryGoal: string
  appType: "ecommerce" | "dashboard" | "landing" | "blog" | "portfolio" | "saas" | "other"
  screens: UXProductScreen[]
  flows: UXProductFlow[]
  visualSemantics: {
    layoutPattern: string
    density: UXDensity
    tone: string
    colorRoles: Record<string, string>
    avoid: string[]
  }
  dataSemantics: {
    mockDataRules: string[]
    forbiddenPlaceholders: string[]
  }
  qualityCriteria: string[]
}

const GENERIC_PLACEHOLDERS = [
  "Product 1",
  "Product 2",
  "Project 1",
  "Project 2",
  "Description of project",
  "Lorem ipsum",
  "Untitled",
  "Sample item",
]

export function buildUXProductPlan(input: {
  prompt: string
  appType: UXProductPlan["appType"]
  structuredIntent: SwiftStructuredIntent
  architecture: SwiftArchitecturePlan
}): UXProductPlan {
  const prompt = normalize(input.prompt)
  const appType = input.appType
  const commerceDashboard = appType === "dashboard" && /warung|toko|store|commerce|ecommerce|produk|product|sales|penjualan|stok|stock|inventory/.test(prompt)

  if (commerceDashboard) {
    return makeDashboardPlan({
      domain: "commerce_operations",
      audience: /warung/.test(prompt) ? "owner warung and store operator" : "commerce operations team",
      primaryGoal: "monitor sales, stock, and product performance from one operational dashboard",
      mockDataRules: [
        "Use realistic Indonesian product names and IDR currency.",
        "Show sales, stock, margin, order count, and low-stock status.",
        "Use domain labels such as Penjualan, Stok, Produk, Transaksi, and Margin when prompt is Indonesian.",
      ],
    })
  }

  if (appType === "dashboard") {
    return makeDashboardPlan({
      domain: input.structuredIntent.domain || "business_dashboard",
      audience: "workspace operator",
      primaryGoal: "understand operational health and act on the most important records",
      mockDataRules: [
        "Use domain-specific metric labels instead of generic KPI names.",
        "Use realistic trend, status, and owner values.",
      ],
    })
  }

  if (appType === "ecommerce") {
    return makeEcommercePlan(input)
  }

  if (appType === "portfolio" || /portfolio|portofolio|profile|cv|resume/.test(prompt)) {
    return makePortfolioPlan(input)
  }

  if (appType === "landing") {
    return makeLandingPlan(input)
  }

  return makeGeneralPlan(input)
}

export function buildUXPlanInstructionBlock(plan: UXProductPlan) {
  return [
    "UX_PRODUCT_PLAN:",
    JSON.stringify(plan, null, 2),
    "UX contract rules:",
    "- Do not generate UI from the raw prompt alone; use UX_PRODUCT_PLAN as the product and design source of truth.",
    "- Every planned screen must implement its purpose, sections, primary actions, states, and semantic mock data.",
    "- Do not use generic placeholders listed in dataSemantics.forbiddenPlaceholders.",
    "- Prefer domain-specific labels, realistic data, visible hierarchy, responsive behavior, loading states, empty states, and actionable error states.",
    "- UI Enhancement must improve visual hierarchy, spacing, density, copy quality, and responsive behavior without changing business logic.",
  ].join("\n")
}

export function validateUXProductPlan(plan: UXProductPlan) {
  const failures: string[] = []
  if (plan.screens.length === 0) failures.push("UX plan produced no screens")
  if (plan.flows.length === 0) failures.push("UX plan produced no flows")
  if (plan.qualityCriteria.length < 3) failures.push("UX plan quality criteria are too thin")

  const sectionText = plan.screens.flatMap((screen) => screen.sections).join(" ").toLowerCase()
  const stateText = plan.screens.flatMap((screen) => screen.states).join(" ").toLowerCase()
  if (plan.appType === "dashboard") {
    for (const required of ["kpi", "chart", "table", "filter"]) {
      if (!sectionText.includes(required)) failures.push(`Dashboard UX plan missing ${required}`)
    }
    for (const required of ["loading", "empty", "error"]) {
      if (!stateText.includes(required)) failures.push(`Dashboard UX plan missing ${required} state`)
    }
  }
  if (plan.appType === "ecommerce") {
    for (const required of ["product", "cart", "checkout"]) {
      if (!sectionText.includes(required) && !plan.flows.some((flow) => flow.steps.join(" ").toLowerCase().includes(required))) {
        failures.push(`Ecommerce UX plan missing ${required}`)
      }
    }
  }
  if ((plan.appType === "portfolio" || plan.appType === "landing") && !sectionText.includes("hero")) {
    failures.push(`${plan.appType} UX plan missing hero`)
  }

  for (const placeholder of GENERIC_PLACEHOLDERS) {
    if (!plan.dataSemantics.forbiddenPlaceholders.includes(placeholder)) {
      failures.push(`UX plan missing forbidden placeholder: ${placeholder}`)
    }
  }
  return failures
}

export function validateGeneratedUXQuality(input: {
  plan: UXProductPlan
  files: Array<{ path: string; content: string }>
}) {
  const failures: string[] = []
  const searchableFiles = input.files.filter((file) => /\.(tsx?|jsx?|mdx?)$/i.test(file.path))
  for (const file of searchableFiles) {
    for (const placeholder of input.plan.dataSemantics.forbiddenPlaceholders) {
      if (new RegExp(`\\b${escapeRegExp(placeholder)}\\b`, "i").test(file.content)) {
        failures.push(`Generic placeholder "${placeholder}" found in ${file.path}`)
      }
    }
  }

  const allContent = searchableFiles.map((file) => file.content).join("\n").toLowerCase()
  if (input.plan.appType === "dashboard") {
    const requiredConcepts = [
      { label: "KPI or metric summary", pattern: /\b(kpi|metric|summary|ringkasan|penjualan|sales|revenue|stok|stock)\b/ },
      { label: "chart or trend section", pattern: /\b(chart|grafik|trend|tren|recharts|bar|line)\b/ },
      { label: "table or row list", pattern: /\b(table|tabel|row|list|daftar)\b/ },
      { label: "filter or search control", pattern: /\b(filter|search|cari|periode|period|date|tanggal)\b/ },
      { label: "loading state", pattern: /\b(loading|memuat|skeleton)\b/ },
      { label: "empty state", pattern: /\b(empty|kosong|belum ada|no data)\b/ },
      { label: "error state", pattern: /\b(error|gagal|failed|retry)\b/ },
    ]
    for (const concept of requiredConcepts) {
      if (!concept.pattern.test(allContent)) failures.push(`Dashboard UX quality missing ${concept.label}`)
    }
  }

  return failures
}

function makeDashboardPlan(input: {
  domain: string
  audience: string
  primaryGoal: string
  mockDataRules: string[]
}): UXProductPlan {
  return {
    mode: "ux-product-plan-v1",
    domain: input.domain,
    audience: input.audience,
    primaryGoal: input.primaryGoal,
    appType: "dashboard",
    screens: [
      {
        route: "app/page.tsx",
        purpose: "main operational dashboard",
        sections: ["topbar with date/filter controls", "KPI summary strip", "sales or activity chart", "searchable data table", "recent activity feed", "loading skeleton", "empty state", "error callout"],
        primaryActions: ["filter period", "search records", "inspect row", "export or review report"],
        states: ["loading", "empty", "error", "success", "low-stock warning"],
      },
    ],
    flows: [
      {
        name: "Review business health",
        entry: "dashboard overview",
        steps: ["scan KPI summary", "compare chart trend", "filter period", "review table rows", "act on warning state"],
      },
    ],
    visualSemantics: {
      layoutPattern: "dashboard_shell",
      density: "compact",
      tone: "calm, data-first, operational, trustworthy",
      colorRoles: {
        primary: "main action and selected filter",
        success: "healthy growth or completed status",
        warning: "low stock or attention needed",
        danger: "failed transaction or critical issue",
      },
      avoid: ["marketing hero layout", "oversized decorative cards", "generic SaaS finance language", "single-column template page"],
    },
    dataSemantics: {
      mockDataRules: input.mockDataRules,
      forbiddenPlaceholders: GENERIC_PLACEHOLDERS,
    },
    qualityCriteria: [
      "Dashboard includes KPI, chart, table, filter, loading, empty, and error states.",
      "All mock data uses domain-specific labels and realistic values.",
      "Visual hierarchy supports fast scanning on desktop and stacked sections on mobile.",
      "Primary actions are visible without explanatory feature text.",
    ],
  }
}

function makeEcommercePlan(input: { prompt: string; structuredIntent: SwiftStructuredIntent; architecture: SwiftArchitecturePlan }): UXProductPlan {
  return {
    mode: "ux-product-plan-v1",
    domain: input.structuredIntent.domain || "commerce_storefront",
    audience: "shopper and seller/admin operator",
    primaryGoal: "help users discover products and move toward cart or checkout confidently",
    appType: "ecommerce",
    screens: [
      {
        route: "app/page.tsx",
        purpose: "storefront overview and product discovery",
        sections: ["navigation", "featured product area", "category filter", "product grid", "cart summary", "checkout CTA", "empty product state", "loading state"],
        primaryActions: ["filter category", "view product", "add to cart", "open checkout"],
        states: ["loading", "empty", "error", "success", "cart updated"],
      },
    ],
    flows: [
      {
        name: "Browse to checkout",
        entry: "storefront",
        steps: ["scan categories", "compare product cards", "add product to cart", "review cart summary", "continue to checkout"],
      },
    ],
    visualSemantics: {
      layoutPattern: "storefront_grid",
      density: "balanced",
      tone: "clear, commercial, trustworthy, conversion-focused",
      colorRoles: {
        primary: "add to cart and checkout",
        success: "cart update confirmation",
        warning: "limited stock",
        danger: "unavailable product",
      },
      avoid: ["generic Product 1 cards", "cart-only page without product discovery", "fake dashboard metrics unless requested"],
    },
    dataSemantics: {
      mockDataRules: ["Use domain-specific product names, prices, categories, stock, ratings, and cart quantities."],
      forbiddenPlaceholders: GENERIC_PLACEHOLDERS,
    },
    qualityCriteria: [
      "Storefront includes product discovery, category filtering, cart intent, and checkout CTA.",
      "Product data is realistic and domain-specific.",
      "Mobile layout keeps cart/checkout actions reachable.",
    ],
  }
}

function makePortfolioPlan(input: { prompt: string; structuredIntent: SwiftStructuredIntent }): UXProductPlan {
  return {
    mode: "ux-product-plan-v1",
    domain: input.structuredIntent.domain || "personal_portfolio",
    audience: "recruiter, client, or collaborator",
    primaryGoal: "communicate identity, capability, work proof, and contact path quickly",
    appType: "portfolio",
    screens: [
      {
        route: "app/page.tsx",
        purpose: "personal portfolio homepage",
        sections: ["hero identity", "about summary", "skills/toolkit", "project gallery", "experience or services", "contact CTA", "loading state", "empty project state"],
        primaryActions: ["view projects", "contact owner", "open resume or social link"],
        states: ["loading", "empty", "error", "success"],
      },
    ],
    flows: [
      {
        name: "Assess candidate fit",
        entry: "hero",
        steps: ["read positioning", "scan skills", "review projects", "check experience", "contact"],
      },
    ],
    visualSemantics: {
      layoutPattern: "portfolio_story",
      density: "editorial",
      tone: "confident, polished, personal, credible",
      colorRoles: {
        primary: "contact and project actions",
        success: "proof points",
        warning: "availability note",
        danger: "form error",
      },
      avoid: ["generic Project 1 cards", "resume dump", "empty white page with plain headings"],
    },
    dataSemantics: {
      mockDataRules: ["Use realistic project names, roles, outcomes, tools, and contact details derived from the prompt when available."],
      forbiddenPlaceholders: GENERIC_PLACEHOLDERS,
    },
    qualityCriteria: [
      "Portfolio includes hero, about, skills, projects, proof, and contact CTA.",
      "Project cards include concrete names, outcomes, and tools.",
      "First viewport clearly communicates the person or brand.",
    ],
  }
}

function makeLandingPlan(input: { structuredIntent: SwiftStructuredIntent }): UXProductPlan {
  return {
    mode: "ux-product-plan-v1",
    domain: input.structuredIntent.domain || "marketing_page",
    audience: "prospective customer",
    primaryGoal: "explain the offer and drive one clear conversion action",
    appType: "landing",
    screens: [
      {
        route: "app/page.tsx",
        purpose: "marketing landing page",
        sections: ["hero offer", "benefits", "feature proof", "social proof", "pricing or CTA", "footer"],
        primaryActions: ["start", "learn more", "contact"],
        states: ["loading", "error", "success"],
      },
    ],
    flows: [
      {
        name: "Understand and convert",
        entry: "hero",
        steps: ["read offer", "scan benefits", "review proof", "choose CTA"],
      },
    ],
    visualSemantics: {
      layoutPattern: "conversion_landing",
      density: "editorial",
      tone: "clear, polished, benefit-led",
      colorRoles: {
        primary: "conversion CTA",
        success: "trust proof",
        warning: "limited offer",
        danger: "form error",
      },
      avoid: ["dashboard shell", "generic app screenshots", "feature explanation text inside the app UI"],
    },
    dataSemantics: {
      mockDataRules: ["Use offer-specific benefits, proof points, and CTA labels."],
      forbiddenPlaceholders: GENERIC_PLACEHOLDERS,
    },
    qualityCriteria: [
      "Landing page includes hero, benefits, proof, CTA, and footer.",
      "Headline uses the product, brand, person, or literal offer.",
      "CTA is visible in the first viewport.",
    ],
  }
}

function makeGeneralPlan(input: { structuredIntent: SwiftStructuredIntent; architecture: SwiftArchitecturePlan }): UXProductPlan {
  const route = input.architecture.frontend.pages[0] || "app/page.tsx"
  return {
    mode: "ux-product-plan-v1",
    domain: input.structuredIntent.domain || "custom_web_app",
    audience: "end user",
    primaryGoal: "deliver the requested web experience with clear navigation and useful states",
    appType: "other",
    screens: [
      {
        route,
        purpose: "primary app experience",
        sections: ["navigation", "main content", "action area", "loading state", "empty state", "error state"],
        primaryActions: ["review content", "take primary action"],
        states: ["loading", "empty", "error", "success"],
      },
    ],
    flows: [
      {
        name: "Use primary experience",
        entry: route,
        steps: ["understand context", "review main content", "take primary action", "see feedback state"],
      },
    ],
    visualSemantics: {
      layoutPattern: "responsive_app",
      density: "balanced",
      tone: "clear, modern, practical",
      colorRoles: {
        primary: "main action",
        success: "completed state",
        warning: "attention state",
        danger: "error state",
      },
      avoid: ["generic placeholder content", "unstyled HTML scaffold", "single flat column without hierarchy"],
    },
    dataSemantics: {
      mockDataRules: ["Use realistic domain-specific content and labels."],
      forbiddenPlaceholders: GENERIC_PLACEHOLDERS,
    },
    qualityCriteria: [
      "Primary screen includes navigation, main content, action area, and states.",
      "Mock content is domain-specific.",
      "Responsive layout preserves hierarchy on mobile and desktop.",
    ],
  }
}

function normalize(value: string) {
  return String(value || "").toLowerCase().replace(/[^a-z0-9\u00c0-\u024f\s-]+/g, " ").replace(/\s+/g, " ").trim()
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

import type { ControlledAppType } from "@/lib/ai/app-blueprints"

export type IntentAnalysis = {
  appType: ControlledAppType
  domain: string
  confidence: number
  keywords: string[]
  forbiddenAssumptions: string[]
  requiredCapabilities: string[]
}

const INTENT_RULES: Array<{
  appType: ControlledAppType
  domain: string
  keywords: string[]
  requiredCapabilities: string[]
  forbiddenAssumptions?: string[]
}> = [
  {
    appType: "simple_marketplace",
    domain: "commerce_storefront",
    keywords: ["jual", "beli", "jual beli", "toko", "dagang", "pasar", "marketplace", "ecommerce", "e-commerce", "shopee", "tokopedia", "katalog", "produk", "checkout", "cart"],
    requiredCapabilities: ["storefront", "product_catalog", "product_detail", "cart_or_checkout_flow", "seller_or_admin_placeholder"],
    forbiddenAssumptions: ["saas_metrics", "workspace_analytics", "revenue_dashboard"],
  },
  {
    appType: "village_news_portal",
    domain: "article_news_portal",
    keywords: ["berita", "news", "artikel", "article", "majalah", "blog", "portal", "desa", "warga", "pengumuman"],
    requiredCapabilities: ["article_listing", "article_detail", "category_filter", "announcement_or_agenda"],
    forbiddenAssumptions: ["checkout", "revenue_dashboard", "conversion_metrics"],
  },
  {
    appType: "ai_chat_app",
    domain: "ai_chat",
    keywords: ["ai chat", "chatbot", "assistant", "conversation", "llm"],
    requiredCapabilities: ["chat_thread", "message_input", "loading_state", "provider_route_placeholder"],
  },
  {
    appType: "booking_app",
    domain: "booking",
    keywords: ["booking", "reservation", "reservasi", "jadwal", "appointment", "slot"],
    requiredCapabilities: ["availability", "reservation_form", "confirmation_state"],
  },
  {
    appType: "lightweight_crm",
    domain: "crm",
    keywords: ["crm", "lead", "pipeline", "customer", "pelanggan", "prospect"],
    requiredCapabilities: ["lead_pipeline", "customer_table", "activity_timeline"],
  },
  {
    appType: "internal_business_tool",
    domain: "community_social_tool",
    keywords: ["komunitas", "community", "social", "sosial", "feed", "post ", " post", "moderation admin"],
    requiredCapabilities: ["feed", "profile_or_member_context", "moderation_state"],
    forbiddenAssumptions: ["commerce_checkout", "saas_metrics"],
  },
  {
    appType: "crud_admin_panel",
    domain: "crud_admin",
    keywords: ["crud", "admin panel", "cms", "moderasi", "manage records"],
    requiredCapabilities: ["list_view", "create_form", "edit_flow", "status_filter"],
  },
  {
    appType: "saas_dashboard",
    domain: "saas_dashboard",
    keywords: ["saas", "dashboard", "workspace", "workspace metrics", "activity feed", "settings"],
    requiredCapabilities: ["dashboard_shell", "workspace_metrics", "activity_feed", "settings_entry"],
    forbiddenAssumptions: ["commerce_checkout", "article_portal"],
  },
  {
    appType: "landing_auth",
    domain: "landing_auth",
    keywords: ["landing", "hero", "cta", "login", "register", "auth", "sign in", "sign up"],
    requiredCapabilities: ["hero", "auth_entry", "primary_cta"],
  },
  {
    appType: "internal_business_tool",
    domain: "internal_tool",
    keywords: ["internal tool", "ops", "operation", "inventory", "workflow", "back office"],
    requiredCapabilities: ["task_table", "workflow_status", "audit_state"],
  },
]

export function analyzePromptIntent(prompt: string): IntentAnalysis {
  const text = normalizeText(prompt)
  const scored = INTENT_RULES.map((rule) => {
    const matched = rule.keywords.filter((keyword) => text.includes(normalizeText(keyword)))
    return {
      rule,
      matched,
      score: matched.reduce((sum, keyword) => sum + Math.max(1, keyword.split(/\s+/).length), 0),
    }
  }).sort((left, right) => right.score - left.score)

  const best = scored[0]
  if (best && best.score > 0) {
    return {
      appType: best.rule.appType,
      domain: best.rule.domain,
      confidence: Math.min(0.98, 0.55 + best.score * 0.08),
      keywords: best.matched,
      forbiddenAssumptions: best.rule.forbiddenAssumptions || [],
      requiredCapabilities: best.rule.requiredCapabilities,
    }
  }

  return {
    appType: "internal_business_tool",
    domain: "custom_web_app",
    confidence: 0.35,
    keywords: [],
    forbiddenAssumptions: ["saas_metrics", "commerce_checkout", "financial_dashboard"],
    requiredCapabilities: ["visible_homepage", "clear_navigation", "domain_specific_content"],
  }
}

export function buildIntentInstructionBlock(intent: IntentAnalysis) {
  return [
    "INTENT_ANALYZER_RESULT:",
    JSON.stringify(intent, null, 2),
    "Rules:",
    "- Treat this intent as the source of truth unless the user explicitly says otherwise.",
    "- Do not replace the domain with SaaS/dashboard language when the intent is commerce, news, portfolio, hobby, or another non-SaaS domain.",
    "- Every generated operation must serve one of the required capabilities or a direct dependency for it.",
  ].join("\n")
}

function normalizeText(value: string) {
  return String(value || "").toLowerCase().replace(/[^a-z0-9\u00c0-\u024f\s-]+/g, " ").replace(/\s+/g, " ").trim()
}

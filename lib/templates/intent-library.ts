export const INTENT_TEMPLATE_IDS = [
  "landing",
  "dashboard",
  "marketplace",
  "saas",
  "crm",
  "restaurant",
  "clinic",
  "laundry",
  "blog",
] as const

export type IntentTemplateId = (typeof INTENT_TEMPLATE_IDS)[number]

export type IntentTemplateDefinition = {
  id: IntentTemplateId
  label: string
  path: `templates/${IntentTemplateId}`
  match: RegExp
  requiredCapabilities: string[]
}

export const INTENT_TEMPLATE_LIBRARY: IntentTemplateDefinition[] = [
  template("landing", "Landing page", /\b(landing|hero|company profile|portfolio|marketing|homepage)\b/i, ["marketing_page", "cta_sections"]),
  template("dashboard", "Dashboard", /\b(dashboard|admin|analytics|metric|monitoring|report)\b/i, ["dashboard_shell", "metrics"]),
  template("marketplace", "Marketplace", /\b(marketplace|multi seller|vendor|catalog|listing)\b/i, ["catalog", "seller_profiles"]),
  template("saas", "SaaS", /\b(saas|subscription|workspace|billing|team)\b/i, ["workspace", "billing_ready"]),
  template("crm", "CRM", /\b(crm|customer|lead|pipeline|sales)\b/i, ["contacts", "pipeline"]),
  template("restaurant", "Restaurant", /\b(restaurant|restoran|menu|reservation|booking|cafe)\b/i, ["menu", "reservations"]),
  template("clinic", "Clinic", /\b(clinic|klinik|doctor|dokter|patient|pasien|appointment)\b/i, ["appointments", "patients"]),
  template("laundry", "Laundry", /\b(laundry|dry clean|pickup|order tracking|cuci)\b/i, ["orders", "service_packages"]),
  template("blog", "Blog", /\b(blog|news|article|post|cms|portal berita)\b/i, ["posts", "categories"]),
]

export function selectIntentTemplate(prompt: string) {
  return INTENT_TEMPLATE_LIBRARY.find((item) => item.match.test(prompt)) || null
}

function template(
  id: IntentTemplateId,
  label: string,
  match: RegExp,
  requiredCapabilities: string[]
): IntentTemplateDefinition {
  return {
    id,
    label,
    path: `templates/${id}`,
    match,
    requiredCapabilities,
  }
}

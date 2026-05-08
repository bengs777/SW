export type BillingPlanId = "free" | "builder" | "studio"

export type BillingPurchaseType = "topup" | "subscription"

export type BillingOrderPayload = {
  purchaseType?: BillingPurchaseType
  planId?: BillingPlanId
  workspaceId?: string
  source?: string
  note?: string
}

export type BillingPlanDefinition = {
  id: BillingPlanId
  name: string
  badge: string
  description: string
  priceIdr: number
  monthlyCredits: number
  tokensLimit: number
  renewalDays: number | null
  highlighted?: boolean
  ctaLabel: string
  features: string[]
  unlocks: string[]
}

export const BILLING_PLANS: BillingPlanDefinition[] = [
  {
    id: "free",
    name: "Free",
    badge: "Mulai gratis",
    description: "Untuk eksplorasi, validasi ide, dan build awal.",
    priceIdr: 0,
    monthlyCredits: 5000,
    tokensLimit: 5000,
    renewalDays: 30,
    ctaLabel: "Buat akun gratis",
    features: [
      "5.000 credits per bulan",
      "Maksimal 3 project aktif",
      "Template dasar",
      "Komunitas support",
    ],
    unlocks: [
      "Basic generation",
      "Dashboard access",
      "Top up balance",
    ],
  },
  {
    id: "builder",
    name: "Builder",
    badge: "Paling populer",
    description: "Untuk solo founder yang butuh volume credits lebih besar.",
    priceIdr: 99_000,
    monthlyCredits: 50_000,
    tokensLimit: 50_000,
    renewalDays: 30,
    highlighted: true,
    ctaLabel: "Lanjut ke billing",
    features: [
      "50.000 credits per bulan",
      "Project tanpa batas",
      "Prioritas antrean generate",
      "Export project penuh",
      "Top up tambahan mulai Rp 2.000",
    ],
    unlocks: [
      "Priority queue",
      "Full project export",
      "Custom domain",
      "More active projects",
    ],
  },
  {
    id: "studio",
    name: "Studio",
    badge: "Skala tim",
    description: "Untuk tim kecil yang butuh workspace, kontrol, dan prioritas.",
    priceIdr: 249_000,
    monthlyCredits: 250_000,
    tokensLimit: 250_000,
    renewalDays: 30,
    ctaLabel: "Lanjut ke billing",
    features: [
      "250.000 credits per bulan",
      "Kolaborasi workspace",
      "Priority support",
      "Advanced usage insights",
      "Top up manual dan crypto mulai Rp 2.000",
    ],
    unlocks: [
      "Workspace collaboration",
      "Advanced usage insights",
      "Priority support",
      "Team-scale limits",
    ],
  },
]

export const BILLING_PLAN_MAP: Record<BillingPlanId, BillingPlanDefinition> = BILLING_PLANS.reduce(
  (accumulator, plan) => {
    accumulator[plan.id] = plan
    return accumulator
  },
  {} as Record<BillingPlanId, BillingPlanDefinition>
)

export const PAID_BILLING_PLAN_IDS: BillingPlanId[] = BILLING_PLANS.filter((plan) => plan.id !== "free").map(
  (plan) => plan.id
)

export function normalizeBillingPlanId(value: string | null | undefined): BillingPlanId {
  switch ((value || "").toLowerCase()) {
    case "builder":
      return "builder"
    case "studio":
      return "studio"
    case "pro":
      return "builder"
    case "enterprise":
      return "studio"
    default:
      return "free"
  }
}

export function isBillingPlanId(value: string | null | undefined): value is BillingPlanId {
  return ["free", "builder", "studio"].includes((value || "").toLowerCase())
}

export function getBillingPlan(value: string | null | undefined): BillingPlanDefinition {
  return BILLING_PLAN_MAP[normalizeBillingPlanId(value)]
}

export function parseBillingOrderPayload(payload: string | null | undefined): BillingOrderPayload | null {
  if (!payload) {
    return null
  }

  try {
    const parsed = JSON.parse(payload) as BillingOrderPayload
    return parsed && typeof parsed === "object" ? parsed : null
  } catch {
    return null
  }
}

export function isSubscriptionPurchasePayload(
  payload: BillingOrderPayload | null | undefined
): payload is BillingOrderPayload & { purchaseType: "subscription"; planId: Exclude<BillingPlanId, "free">; workspaceId: string } {
  return (
    Boolean(payload) &&
    payload?.purchaseType === "subscription" &&
    (payload.planId === "builder" || payload.planId === "studio") &&
    typeof payload.workspaceId === "string" &&
    payload.workspaceId.length > 0
  )
}
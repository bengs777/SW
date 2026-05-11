import { BillingService } from "@/lib/services/billing.service"

export type SwiftBillingTransition = "reserved" | "captured" | "refunded" | "released" | "failed"

export function buildSwiftBillingMetadata(input: {
  requestId: string
  userId: string
  projectId?: string | null
  selectedTier: string
  amountIdr: number
  billingStatus: SwiftBillingTransition
  refundReason?: string | null
  latencyMs?: number
  retries?: number
  providerUsedInternal?: string | null
}) {
  return {
    requestId: input.requestId,
    userId: input.userId,
    projectId: input.projectId || null,
    selectedTier: input.selectedTier,
    amountIdr: input.amountIdr,
    billingStatus: input.billingStatus,
    refundReason: input.refundReason || null,
    latencyMs: input.latencyMs || 0,
    retries: input.retries || 0,
    providerUsedInternal: input.providerUsedInternal || null,
  }
}

export { BillingService as SwiftBillingService }

import { routeModelForRequest, type PromptClassification, type RoutingPurpose } from "@/lib/ai/generation-pipeline"
import { SWIFT_PROVIDER } from "@/lib/ai/model-tiers"
import type { GeneratedFile } from "@/lib/types"

export type ModelRouterInput = {
  prompt?: string
  classification?: PromptClassification
  existingFiles?: GeneratedFile[]
  previewError?: string | null
  attachmentCount?: number
  repairAttempt?: number
  allowPremiumEscalation?: boolean
}

export function chooseModelForTask(purpose: RoutingPurpose | "generate" | "inspect", input: ModelRouterInput = {}) {
  const decision = routeModelForRequest({
    prompt: input.prompt || "",
    purpose,
    classification: input.classification,
    existingFiles: input.existingFiles,
    previewError: input.previewError,
    attachmentCount: input.attachmentCount,
    repairAttempt: input.repairAttempt,
    allowPremiumEscalation: input.allowPremiumEscalation,
  })

  return {
    provider: SWIFT_PROVIDER,
    modelName: decision.modelName,
    decision,
  }
}

const modelRouter = { chooseModelForTask }

export default modelRouter

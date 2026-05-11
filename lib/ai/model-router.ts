import { SWIFT_PROVIDER, DEFAULT_SWIFT_TIER_KEY } from "@/lib/ai/model-tiers"

export function chooseModelForTask(purpose: "generate" | "inspect") {
  void purpose
  return { provider: SWIFT_PROVIDER, modelName: DEFAULT_SWIFT_TIER_KEY }
}

const modelRouter = { chooseModelForTask }

export default modelRouter

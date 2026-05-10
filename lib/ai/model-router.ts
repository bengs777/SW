import { SWIFT_PROVIDER, SWIFT_2_MODEL_KEY, SWIFT_3_MODEL_KEY } from "@/lib/ai/model-tiers"

export function chooseModelForTask(purpose: "generate" | "inspect") {
  if (purpose === "inspect") {
    return { provider: SWIFT_PROVIDER, modelName: SWIFT_3_MODEL_KEY }
  }

  return { provider: SWIFT_PROVIDER, modelName: SWIFT_2_MODEL_KEY }
}

export default { chooseModelForTask }

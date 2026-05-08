import type { ModelOption } from "@/lib/types"
import { DEFAULT_MODEL_OPTIONS } from "@/lib/ai/models"

export function getRuntimeModelOptions(): ModelOption[] {
  return DEFAULT_MODEL_OPTIONS
}

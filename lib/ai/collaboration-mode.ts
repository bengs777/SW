export const COLLABORATION_MODES = ["build", "edit", "fix", "review", "ask"] as const

export type CollaborationMode = (typeof COLLABORATION_MODES)[number]

export const MUTATING_COLLABORATION_MODES = ["build", "edit", "fix"] as const satisfies readonly CollaborationMode[]

const COLLABORATION_MODE_SET = new Set<string>(COLLABORATION_MODES)

export function isCollaborationMode(value: unknown): value is CollaborationMode {
  return typeof value === "string" && COLLABORATION_MODE_SET.has(value)
}

export function normalizeCollaborationMode(value: unknown, fallback: CollaborationMode = "build"): CollaborationMode {
  if (typeof value !== "string") return fallback
  const normalized = value.trim().toLowerCase()
  return isCollaborationMode(normalized) ? normalized : fallback
}

export function isMutatingCollaborationMode(mode: CollaborationMode) {
  return mode === "build" || mode === "edit" || mode === "fix"
}

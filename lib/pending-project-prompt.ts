export const PENDING_PROJECT_PROMPT_STORAGE_KEY = "swift.pendingProjectPrompt"

export type PendingProjectPrompt = {
  prompt: string
  source: "landing"
  createdAt: string
}

export function readPendingProjectPrompt(): PendingProjectPrompt | null {
  if (typeof window === "undefined") return null

  const rawPrompt = window.localStorage.getItem(PENDING_PROJECT_PROMPT_STORAGE_KEY)
  if (!rawPrompt) return null

  try {
    const parsed = JSON.parse(rawPrompt) as Partial<PendingProjectPrompt>
    const prompt = typeof parsed.prompt === "string" ? parsed.prompt.trim() : ""
    if (!prompt) return null

    return {
      prompt,
      source: "landing",
      createdAt: typeof parsed.createdAt === "string" ? parsed.createdAt : new Date().toISOString(),
    }
  } catch {
    return null
  }
}

export function writePendingProjectPrompt(prompt: string) {
  if (typeof window === "undefined") return

  const trimmedPrompt = prompt.trim()
  if (!trimmedPrompt) return

  const payload: PendingProjectPrompt = {
    prompt: trimmedPrompt,
    source: "landing",
    createdAt: new Date().toISOString(),
  }

  window.localStorage.setItem(PENDING_PROJECT_PROMPT_STORAGE_KEY, JSON.stringify(payload))
}

export function clearPendingProjectPrompt() {
  if (typeof window === "undefined") return

  window.localStorage.removeItem(PENDING_PROJECT_PROMPT_STORAGE_KEY)
}

export type CanonicalPathFix =
  | "trim"
  | "windows_separators"
  | "leading_slash"
  | "dot_prefix"
  | "duplicate_slash"

export type CanonicalPathResult = {
  received: string
  path: string
  changed: boolean
  fixes: CanonicalPathFix[]
}

export const CANONICAL_PATH_REGRESSION_CASES = [
  { input: "/components/Button.tsx", expected: "components/Button.tsx", safe: true },
  { input: "./app/page.tsx", expected: "app/page.tsx", safe: true },
  { input: "src\\components\\Card.tsx", expected: "src/components/Card.tsx", safe: true },
  { input: "app\\dashboard//page.tsx", expected: "app/dashboard/page.tsx", safe: true },
  { input: "components//ui\\button.tsx", expected: "components/ui/button.tsx", safe: true },
  { input: "../lib/utils.ts", expected: "../lib/utils.ts", safe: false },
] as const

export function canonicalizeGeneratedPath(filePath: string): CanonicalPathResult {
  const received = String(filePath || "")
  let next = received
  const fixes: CanonicalPathFix[] = []

  const trimmed = next.trim()
  if (trimmed !== next) {
    next = trimmed
    fixes.push("trim")
  }

  if (next.includes("\\")) {
    next = next.replace(/\\/g, "/")
    fixes.push("windows_separators")
  }

  if (/^\/+/.test(next)) {
    next = next.replace(/^\/+/, "")
    fixes.push("leading_slash")
  }

  while (next.startsWith("./")) {
    next = next.slice(2)
    fixes.push("dot_prefix")
  }

  if (/\/{2,}/.test(next)) {
    next = next.replace(/\/{2,}/g, "/")
    fixes.push("duplicate_slash")
  }

  return {
    received,
    path: next,
    changed: received !== next,
    fixes: Array.from(new Set(fixes)),
  }
}

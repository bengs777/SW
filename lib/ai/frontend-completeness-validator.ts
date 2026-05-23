import type { GeneratedFile } from "@/lib/types"

export type FrontendCompletenessResult = {
  ok: boolean
  failures: string[]
  signals: {
    fileCount: number
    componentFileCount: number
    sectionFileCount: number
    hasHomePage: boolean
    hasLayout: boolean
    hasGlobalStyles: boolean
    hasHeaderOrNavbar: boolean
    hasFooter: boolean
    hasCta: boolean
    hasResponsiveLayout: boolean
    hasLoadingOrEmptyState: boolean
    hasDomainSpecificSections: boolean
    loremIpsumCount: number
  }
}

const normalizePath = (value: string) => String(value || "").replace(/\\/g, "/").replace(/^\.\//, "").trim()

export function validateFrontendCompleteness(files: GeneratedFile[]): FrontendCompletenessResult {
  const normalized = files.map((file) => ({
    path: normalizePath(file.path),
    content: String(file.content || ""),
  }))
  const allContent = normalized.map((file) => file.content).join("\n")
  const visibleContent = normalized
    .filter((file) => /\.(tsx|jsx|css)$/i.test(file.path))
    .map((file) => file.content)
    .join("\n")

  const componentFiles = normalized.filter((file) => /^components\/.+\.(tsx|jsx)$/i.test(file.path))
  const sectionFiles = normalized.filter((file) => /^sections\/.+\.(tsx|jsx)$/i.test(file.path) || /^components\/sections\/.+\.(tsx|jsx)$/i.test(file.path))
  const signals = {
    fileCount: normalized.length,
    componentFileCount: componentFiles.length,
    sectionFileCount: sectionFiles.length,
    hasHomePage: normalized.some((file) => /^app\/(?:.+\/)?page\.(tsx|jsx|ts|js)$/i.test(file.path) && /export\s+default|<main\b|<section\b/i.test(file.content)),
    hasLayout: normalized.some((file) => /^app\/layout\.(tsx|jsx|ts|js)$/i.test(file.path)),
    hasGlobalStyles: normalized.some((file) => /^app\/globals\.css$/i.test(file.path)),
    hasHeaderOrNavbar: /(<header\b|<nav\b|navbar|siteheader|navigation|menu)/i.test(visibleContent),
    hasFooter: /(<footer\b|sitefooter|footer)/i.test(visibleContent),
    hasCta: /\b(cta|call to action|get started|mulai|hubungi|book now|pesan|daftar|beli sekarang|lihat paket|explore)\b/i.test(visibleContent),
    hasResponsiveLayout: /\b(sm:|md:|lg:|xl:|grid-cols-|flex-col|flex-row|@media|max-width|minmax\(|clamp\()/i.test(visibleContent),
    hasLoadingOrEmptyState: /\b(loading|skeleton|memuat|empty state|belum ada|no data|kosong|placeholder)/i.test(visibleContent),
    hasDomainSpecificSections: countDomainSections(visibleContent) >= 4,
    loremIpsumCount: (allContent.match(/lorem ipsum/gi) || []).length,
  }

  const failures: string[] = []
  if (signals.fileCount < 8) failures.push("FULL_FRONTEND requires at least 8 generated files.")
  if (!signals.hasHomePage) failures.push("Missing meaningful app page.")
  if (!signals.hasLayout) failures.push("Missing app/layout.tsx.")
  if (!signals.hasGlobalStyles) failures.push("Missing app/globals.css.")
  if (signals.componentFileCount + signals.sectionFileCount < 4) failures.push("Missing reusable component or section hierarchy.")
  if (!signals.hasHeaderOrNavbar) failures.push("Missing responsive header/navbar.")
  if (!signals.hasFooter) failures.push("Missing footer.")
  if (!signals.hasCta) failures.push("Missing CTA section or CTA actions.")
  if (!signals.hasResponsiveLayout) failures.push("Missing responsive layout signals.")
  if (!signals.hasLoadingOrEmptyState) failures.push("Missing loading, skeleton, or empty state.")
  if (!signals.hasDomainSpecificSections) failures.push("Missing enough domain-specific sections.")
  if (signals.loremIpsumCount > 0) failures.push("Contains lorem ipsum placeholder copy.")
  if (isSingleFileDemo(normalized)) failures.push("Generated output looks like a single-file demo instead of production-like frontend architecture.")

  return {
    ok: failures.length === 0,
    failures,
    signals,
  }
}

function countDomainSections(content: string) {
  const labels = [
    "hero",
    "features",
    "benefit",
    "pricing",
    "testimonial",
    "faq",
    "gallery",
    "services",
    "products",
    "portfolio",
    "stats",
    "contact",
    "team",
    "process",
    "destination",
    "packages",
    "analytics",
    "activity",
    "table",
    "chart",
    "cta",
  ]
  const normalized = content.toLowerCase()
  return labels.filter((label) => normalized.includes(label)).length
}

function isSingleFileDemo(files: Array<{ path: string; content: string }>) {
  const appFiles = files.filter((file) => /^(app|components|sections|lib)\//i.test(file.path))
  const pageOnly = appFiles.filter((file) => !/^app\/page\.(tsx|jsx|ts|js)$/i.test(file.path)).length === 0
  return appFiles.length <= 3 && pageOnly
}

import type { GeneratedFile } from "@/lib/types"

/**
 * Prompt grounding & intent verification.
 *
 * Goal: ensure AI responses STAY ON-TOPIC with the user's domain/intent.
 *
 * Two stages:
 * 1. Pre-generation: build a domain-anchoring system message that's appended
 *    to the AI prompt, telling the model exactly which domain words to honor.
 * 2. Post-generation: verify generated files actually mention the user's
 *    domain. If the AI ignored the user's request and produced a generic
 *    landing page, we flag it for re-generation instead of saving drift.
 *
 * Why this matters:
 * - Users complain when "buat web laundry" returns a generic SaaS dashboard.
 * - Cheap heuristic check catches obvious drift before files hit storage.
 * - Costs nothing extra — runs on already-generated text.
 */

// Domain keyword lexicon (Indonesian + English common terms)
const DOMAIN_LEXICON: Array<{ id: string; keywords: string[]; expectedFileTerms: string[] }> = [
  {
    id: "laundry",
    keywords: ["laundry", "cuci", "setrika", "dry clean", "kiloan"],
    expectedFileTerms: ["laundry", "cuci", "order", "pickup", "kg"],
  },
  {
    id: "ecommerce",
    keywords: ["toko online", "shopee", "tokopedia", "ecommerce", "e-commerce", "jualan", "katalog produk", "shop"],
    expectedFileTerms: ["product", "cart", "checkout", "harga", "katalog", "keranjang"],
  },
  {
    id: "burung",
    keywords: ["burung", "bird", "kicau", "majalengka"],
    expectedFileTerms: ["burung", "bird", "spesies", "lokasi", "harga"],
  },
  {
    id: "restaurant",
    keywords: ["restoran", "restaurant", "cafe", "kafe", "menu", "kopi"],
    expectedFileTerms: ["menu", "makanan", "minuman", "reservasi", "table"],
  },
  {
    id: "clinic",
    keywords: ["klinik", "dokter", "pasien", "medical", "rumah sakit"],
    expectedFileTerms: ["dokter", "pasien", "appointment", "jadwal", "klinik"],
  },
  {
    id: "school",
    keywords: ["sekolah", "kampus", "siswa", "guru", "kursus", "elearning", "e-learning"],
    expectedFileTerms: ["siswa", "guru", "kelas", "course", "schedule"],
  },
  {
    id: "salon",
    keywords: ["salon", "barbershop", "spa", "kecantikan", "haircut"],
    expectedFileTerms: ["salon", "service", "stylist", "booking", "treatment"],
  },
  {
    id: "rental",
    keywords: ["rental", "sewa", "car rental", "rental motor"],
    expectedFileTerms: ["rental", "sewa", "vehicle", "kendaraan", "booking"],
  },
  {
    id: "trading",
    keywords: ["trading", "forex", "crypto", "kripto", "saham", "exchange"],
    expectedFileTerms: ["price", "market", "order", "position", "watchlist"],
  },
  {
    id: "booking",
    keywords: ["booking", "reservasi", "appointment", "jadwal"],
    expectedFileTerms: ["booking", "reservation", "schedule", "calendar", "slot"],
  },
  {
    id: "blog",
    keywords: ["blog", "berita", "news", "artikel", "media", "portal konten"],
    expectedFileTerms: ["article", "post", "blog", "berita", "kategori"],
  },
  {
    id: "portfolio",
    keywords: ["portfolio", "portofolio", "personal brand", "cv online"],
    expectedFileTerms: ["project", "work", "about", "skills", "contact"],
  },
]

export type PromptDomain = {
  id: string
  matchedKeywords: string[]
  expectedFileTerms: string[]
} | null

/**
 * Detect the user's domain from their original prompt.
 * Returns the most specific match, or null if no domain detected.
 */
export function detectPromptDomain(prompt: string): PromptDomain {
  const normalized = prompt.toLowerCase()
  let bestMatch: PromptDomain = null
  let bestScore = 0

  for (const domain of DOMAIN_LEXICON) {
    const matched = domain.keywords.filter((kw) => normalized.includes(kw))
    if (matched.length === 0) continue

    // Score by number of matched keywords + total length of matched keywords
    // (longer matches like "toko online" beat shorter ones like "shop")
    const score = matched.length * 10 + matched.reduce((sum, kw) => sum + kw.length, 0)

    if (score > bestScore) {
      bestScore = score
      bestMatch = {
        id: domain.id,
        matchedKeywords: matched,
        expectedFileTerms: domain.expectedFileTerms,
      }
    }
  }

  return bestMatch
}

/**
 * Build a domain-anchoring directive to append to the AI system prompt.
 * This dramatically reduces drift by giving the AI an explicit anchor.
 */
export function buildDomainAnchorDirective(prompt: string, language: "id" | "en" = "id"): string {
  const domain = detectPromptDomain(prompt)
  if (!domain) return ""

  if (language === "en") {
    return [
      `\nDOMAIN_ANCHOR: The user requested a ${domain.id} application.`,
      `Their literal keywords: ${domain.matchedKeywords.join(", ")}.`,
      `Expected vocabulary in generated code: ${domain.expectedFileTerms.join(", ")}.`,
      `MUST NOT replace this domain with a generic SaaS dashboard, generic landing page, or unrelated product.`,
      `Every generated file must visibly reflect the ${domain.id} domain in copy, data models, and routes.`,
    ].join("\n")
  }

  return [
    `\nDOMAIN_ANCHOR: User meminta aplikasi domain ${domain.id}.`,
    `Kata kunci eksplisit user: ${domain.matchedKeywords.join(", ")}.`,
    `Vocabulary yang harus muncul di kode: ${domain.expectedFileTerms.join(", ")}.`,
    `WAJIB: jangan ganti domain ini dengan SaaS generik, landing page generik, atau produk lain.`,
    `Setiap file yang di-generate harus terlihat sebagai aplikasi ${domain.id} di copy, data model, dan routes.`,
  ].join("\n")
}

/**
 * Verify that generated content reflects the user's domain.
 * Returns drift indicators if the AI produced off-topic content.
 *
 * This is a heuristic — not perfect, but catches gross drift cheaply.
 */
export function verifyDomainGrounding(input: {
  prompt: string
  generatedFiles: GeneratedFile[]
  generatedMessage?: string
}): {
  ok: boolean
  domain: PromptDomain
  drift: {
    expectedTerms: string[]
    foundTerms: string[]
    missingTerms: string[]
    coverage: number
  } | null
} {
  const domain = detectPromptDomain(input.prompt)

  if (!domain) {
    // No specific domain detected → no grounding check applies
    return { ok: true, domain: null, drift: null }
  }

  // Build a lowercase corpus of all generated content
  const corpus = [
    input.generatedMessage || "",
    ...input.generatedFiles.map((file) => `${file.path}\n${file.content || ""}`),
  ]
    .join("\n")
    .toLowerCase()

  if (!corpus.trim()) {
    return { ok: false, domain, drift: { expectedTerms: domain.expectedFileTerms, foundTerms: [], missingTerms: domain.expectedFileTerms, coverage: 0 } }
  }

  const foundTerms: string[] = []
  const missingTerms: string[] = []

  // Always check that the user's literal keywords appear somewhere
  const allExpected = Array.from(new Set([...domain.matchedKeywords, ...domain.expectedFileTerms]))

  for (const term of allExpected) {
    if (corpus.includes(term.toLowerCase())) {
      foundTerms.push(term)
    } else {
      missingTerms.push(term)
    }
  }

  const coverage = allExpected.length === 0 ? 1 : foundTerms.length / allExpected.length
  // Pass if at least 25% of expected terms appear AND at least one of the user's literal keywords is present
  const userKeywordPresent = domain.matchedKeywords.some((kw) => corpus.includes(kw.toLowerCase()))
  const ok = coverage >= 0.25 && userKeywordPresent

  return {
    ok,
    domain,
    drift: ok
      ? null
      : {
          expectedTerms: allExpected,
          foundTerms,
          missingTerms,
          coverage: Math.round(coverage * 100) / 100,
        },
  }
}

/**
 * Build a corrective re-prompt directive when domain drift is detected.
 * Used to ask the AI to rewrite without burning a fresh full request — we
 * only re-generate the failing slice with a stronger anchor.
 */
export function buildDriftCorrectionDirective(
  domain: NonNullable<PromptDomain>,
  drift: { missingTerms: string[]; foundTerms: string[]; coverage: number },
  language: "id" | "en" = "id"
): string {
  if (language === "en") {
    return [
      `\nDOMAIN_DRIFT_DETECTED: Previous output drifted away from the user's ${domain.id} domain.`,
      `User keywords missing from output: ${drift.missingTerms.join(", ") || "(all missing)"}`,
      `Domain coverage was only ${Math.round(drift.coverage * 100)}%.`,
      `RETRY_INSTRUCTION: Rewrite the failing slice so the ${domain.id} domain is unmistakable in copy, data, and routes. Use the user's literal keywords (${domain.matchedKeywords.join(", ")}) at least once in visible UI.`,
    ].join("\n")
  }

  return [
    `\nDOMAIN_DRIFT_DETECTED: Output sebelumnya melenceng dari domain ${domain.id} yang user minta.`,
    `Kata kunci user yang hilang dari output: ${drift.missingTerms.join(", ") || "(semua hilang)"}`,
    `Coverage domain hanya ${Math.round(drift.coverage * 100)}%.`,
    `INSTRUKSI ULANG: Tulis ulang slice yang gagal supaya domain ${domain.id} jelas di copy, data, dan routes. Gunakan kata user (${domain.matchedKeywords.join(", ")}) minimal sekali di UI visible.`,
  ].join("\n")
}

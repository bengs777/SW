import type { PromptLanguage } from "@/lib/ai/prompt-templates"

export type PromptIntentMode = "chat" | "build" | "inspect"

export type PromptIntentConfidence = "low" | "medium" | "high"

export interface PromptIntentAnalysis {
  mode: PromptIntentMode
  needsClarification: boolean
  confidence: PromptIntentConfidence
  label: string
  summary: string
  nextStep: string
  example: string
}

const greetingOnlyPatterns = [
  /^(halo|hai|hi|hello|helo|ass?alamualaikum|pagi|siang|sore|malam)[!.,\s]*$/i,
  /^(terima kasih|makasih|thanks|thx|oke|ok|sip)[!.,\s]*$/i,
]

const chatSignals = [
  "apa itu",
  "siapa kamu",
  "jelaskan",
  "terangkan",
  "bantu saya",
  "tolong jelaskan",
  "apa kabar",
  "kenapa",
  "bagaimana",
  "what is",
  "how does",
  "review",
  "analisa",
  "diskusi",
  "ngobrol",
]

const actionSignals = [
  "buat",
  "bikin",
  "create",
  "build",
  "generate",
  "rancang",
  "desain",
  "design",
  "implement",
  "ubah",
  "ganti",
  "perbaiki",
  "fix",
  "update",
  "edit",
  "refactor",
  "tambahkan",
  "add",
  "remove",
  "hapus",
]

const targetSignals = [
  "web",
  "website",
  "app",
  "aplikasi",
  "landing",
  "dashboard",
  "login",
  "register",
  "auth",
  "form",
  "table",
  "chart",
  "api",
  "component",
  "layout",
  "ui",
  "navbar",
  "footer",
  "header",
  "tombol",
  "button",
  "toko",
  "toko online",
  "jualan",
  "produk",
  "ecommerce",
  "e-commerce",
  "portfolio",
  "portofolio",
  "company profile",
  "booking",
  "reservasi",
  "jadwal",
  "reservation",
  "appointment",
  "crm",
  "lead",
  "pipeline",
  "blog",
  "admin",
  "profile",
  "checkout",
  "payment",
  "pembayaran",
  "laundry",
  "klinik",
  "dokter",
  "sekolah",
  "kampus",
  "restoran",
  "cafe",
  "kopi",
  "hotel",
  "travel",
  "event",
  "berita",
  "artikel",
  "kasir",
  "page",
  "halaman",
  "fitur",
]

const detailSignals = [
  "fitur",
  "halaman",
  "page",
  "komponen",
  "component",
  "style",
  "desain",
  "warna",
  "tema",
  "database",
  "auth",
  "login",
  "signup",
  "checkout",
  "api",
  "data",
  "backend",
  "booking",
  "reservation",
  "crm",
  "pipeline",
  "lead",
  "role",
  "admin",
  "mobile",
  "responsive",
  "service",
  "layanan",
  "harga",
  "pricing",
  "paket",
  "produk",
  "katalog",
  "keranjang",
  "pesanan",
  "invoice",
  "jadwal",
  "reservasi",
  "booking",
  "dokter",
  "siswa",
  "guru",
  "customer",
  "pelanggan",
  "testimoni",
  "galeri",
  "kontak",
  "whatsapp",
]

const vagueTargetSignals = [
  "web",
  "website",
  "app",
  "aplikasi",
  "project",
  "starter",
  "boilerplate",
  "page",
  "halaman",
  "ui",
]

const domainSignals = [
  "dashboard",
  "landing",
  "auth",
  "login",
  "register",
  "toko",
  "toko online",
  "jualan",
  "produk",
  "shop",
  "store",
  "ecommerce",
  "e-commerce",
  "portfolio",
  "portofolio",
  "company profile",
  "booking",
  "reservasi",
  "appointment",
  "crm",
  "blog",
  "artikel",
  "berita",
  "laundry",
  "klinik",
  "dokter",
  "sekolah",
  "kampus",
  "restoran",
  "cafe",
  "kopi",
  "hotel",
  "travel",
  "kasir",
]

const audienceSignals = [
  "untuk",
  "for",
  "pelanggan",
  "customer",
  "admin",
  "owner",
  "pemilik",
  "siswa",
  "guru",
  "dokter",
  "pasien",
  "tim",
  "staff",
  "sales",
  "user",
  "pengguna",
]

const styleSignals = [
  "modern",
  "minimalis",
  "minimalist",
  "clean",
  "premium",
  "elegan",
  "elegant",
  "dark",
  "light",
  "warna",
  "tema",
  "mobile",
  "responsive",
  "profesional",
  "professional",
]

const genericBuildSignals = [
  "random",
  "bebas",
  "apa aja",
  "apa saja",
  "acak",
  "suka suka",
  "sukasukanya",
  "whatever",
  "replit",
  "workspace",
  "file explorer",
  "file tree",
  "terminal",
  "preview",
  "ide",
]

const workspaceSignals = [
  "lovable",
  "workspace builder",
  "developer workspace",
  "file explorer",
  "live preview",
  "preview panel",
  "terminal panel",
  "output panel",
  "command bar",
  "split pane",
  "editor pane",
  "project history",
  "version history",
  "share link",
]

const patchSignals = [
  "continue",
  "lanjut",
  "lanjutkan",
  "existing project",
  "project existing",
  "project ini",
  "yang ada",
  "current project",
  "this project",
  "edit this",
  "patch",
  "revise",
  "refine",
  "polish",
  "improve",
  "enhance",
  "optimize",
  "tweak",
  "fix ui",
  "fix bug",
  "perbaiki ui",
  "perbaiki bug",
]

const inspectSignals = [
  "inspect",
  "investigasi",
  "debug",
  "diagnose",
  "diagnosis",
  "review kode",
  "review code",
  "cek kode",
  "cek code",
  "analisa kode",
  "analisis kode",
  "debug kode",
  "debug code",
  "kode ini",
  "code ini",
  "isi preview",
  "isi kode",
  "isi code",
  "trace",
  "traceback",
  "stack trace",
  "browser preview",
  "preview error",
  "error di preview",
  "preview tidak jalan",
  "tidak bisa running di preview",
  "gagal di preview",
  "blank preview",
  "white screen",
  "runtime error",
  "hydration",
  "not rendering",
  "not running",
]

type PromptIntentCopy = {
  label: string
  summary: string
  nextStep: string
  example: string
}

type ClarifyingPromptCopy = {
  intro: string
  originalPrompt: string
  instruction: string
  focus: string
  noCode: string
  keepShort: string
}

const PROMPT_INTENT_COPY: Record<
  PromptLanguage,
  {
    empty: PromptIntentCopy
    greeting: PromptIntentCopy
    chat: PromptIntentCopy
    inspect: PromptIntentCopy
    clarify: PromptIntentCopy
    build: PromptIntentCopy
    defaultChat: PromptIntentCopy
    clarifyingPrompt: ClarifyingPromptCopy
  }
> = {
  id: {
    empty: {
      label: "Belum ada prompt",
      summary: "Tulis dulu apa yang ingin dibahas atau dibuat.",
      nextStep: "Kalau mau bikin web, sebut tujuan, fitur utama, dan gaya UI.",
      example: "Contoh: Buat web portofolio sederhana untuk designer.",
    },
    greeting: {
      label: "Mode chat",
      summary: "AI akan menjawab sebagai obrolan biasa, singkat, dan natural.",
      nextStep: "Cocok untuk sapaan, tanya konsep, minta saran, atau diskusi.",
      example: "Contoh jawaban: Halo, ada yang bisa saya bantu?",
    },
    chat: {
      label: "Mode chat",
      summary: "AI akan menjawab pertanyaan atau diskusi tanpa membuat project.",
      nextStep: "Kalau ingin generate web, tambahkan kata seperti buat, bikin, build, atau generate.",
      example: "Contoh jawaban: JWT dipakai untuk autentikasi berbasis token.",
    },
    inspect: {
      label: "Mode inspect",
      summary: "AI akan membaca evidence preview dan menjawab diagnosis teknis, bukan obrolan umum.",
      nextStep: "Tambahkan error browser, file aktif, dan konteks preview supaya root cause lebih cepat ditemukan.",
      example: "Contoh jawaban: root cause ada di JSX yang tidak valid di file app/page.tsx.",
    },
    clarify: {
      label: "Akan minta klarifikasi",
      summary: "AI kemungkinan akan tanya 1-2 detail penting dulu supaya hasilnya lebih tepat.",
      nextStep: "Tambahkan Tujuan, Fitur wajib, UI / visual, Data / backend, Batasan, dan Preview agar prompt lebih efisien.",
      example: "Contoh: Buat web toko online dengan login, cart, checkout, dan halaman admin.",
    },
    build: {
      label: "Siap generate project",
      summary: "AI akan langsung membangun atau memperbaiki project dari prompt ini secara iteratif.",
      nextStep: "Prompt sudah cukup spesifik untuk langsung dieksekusi atau dipatch.",
      example: "Contoh jawaban: saya akan mulai update file yang ada dan menambahkan bagian yang belum lengkap.",
    },
    defaultChat: {
      label: "Mode chat",
      summary: "AI akan menjawab dulu sebagai chat; belum cukup sinyal untuk generate project.",
      nextStep: "Kalau ingin bikin web, sebut tujuan, fitur, dan stack yang diinginkan.",
      example: "Contoh: Buat landing page untuk SaaS dengan hero, pricing, dan FAQ.",
    },
    clarifyingPrompt: {
      intro: "Pengguna ingin membangun aplikasi web, tetapi brief masih terlalu singkat.",
      originalPrompt: "Permintaan asli:",
      instruction: "Ajukan maksimal 2 pertanyaan klarifikasi yang singkat dan tepat.",
      focus: "Fokus pada Tujuan dan Fitur wajib terlebih dulu, lalu tanyakan UI / visual atau Data / backend jika masih diperlukan.",
      noCode: "Jangan tulis kode, daftar file, atau JSON dulu.",
      keepShort: "Jaga jawaban tetap singkat, natural, dan membantu.",
    },
  },
  en: {
    empty: {
      label: "No prompt yet",
      summary: "Start by typing what you want to discuss or build.",
      nextStep: "If you want to build a web app, include the goal, core features, and UI style.",
      example: "Example: Build a simple portfolio website for a designer.",
    },
    greeting: {
      label: "Chat mode",
      summary: "AI will reply as a normal conversation, short and natural.",
      nextStep: "Good for greetings, concept questions, advice, or discussion.",
      example: "Example reply: Hi, how can I help?",
    },
    chat: {
      label: "Chat mode",
      summary: "AI will answer questions or discussions without creating a project.",
      nextStep: "If you want to generate a web app, add words like build, create, or generate.",
      example: "Example reply: JWT is used for token-based authentication.",
    },
    inspect: {
      label: "Inspect mode",
      summary: "AI will read preview evidence and answer with a technical diagnosis instead of a general chat reply.",
      nextStep: "Add the browser error, active file, and preview context so the root cause is easier to find.",
      example: "Example reply: the root cause is invalid JSX in app/page.tsx.",
    },
    clarify: {
      label: "Will ask clarifying questions",
      summary: "AI will probably ask 1-2 key details first so the result is more accurate.",
      nextStep: "Add Goal, Must-have features, UI / visual, Data / backend, Constraints, and Preview to make the prompt more efficient.",
      example: "Example: Build an e-commerce site with login, cart, checkout, and an admin page.",
    },
    build: {
      label: "Ready to generate project",
      summary: "AI will build or iteratively improve the project directly from this prompt.",
      nextStep: "The prompt is specific enough to execute or patch immediately.",
      example: "Example reply: I will update the existing files and add the missing pieces.",
    },
    defaultChat: {
      label: "Chat mode",
      summary: "AI will answer as chat first; there is not enough signal yet to generate a project.",
      nextStep: "If you want to build a web app, include the goal, features, and desired stack.",
      example: "Example: Build a landing page for a SaaS with a hero, pricing, and FAQ.",
    },
    clarifyingPrompt: {
      intro: "The user wants to build a web app, but the brief is still too short.",
      originalPrompt: "Original request:",
      instruction: "Ask at most 2 concise clarifying questions that capture the missing essentials.",
      focus: "Focus on Goal and Must-have features first, then ask about UI / visual or Data / backend if needed.",
      noCode: "Do not write code, file lists, or JSON yet.",
      keepShort: "Keep the response short, human, and helpful.",
    },
  },
}

export function analyzePromptIntent(prompt: string, language: PromptLanguage = "id"): PromptIntentAnalysis {
  const normalized = prompt.toLowerCase().replace(/\s+/g, " ").trim()
  const words = normalized ? normalized.split(" ").filter(Boolean) : []
  const copy = PROMPT_INTENT_COPY[language]

  if (!normalized) {
    return {
      mode: "chat",
      needsClarification: false,
      confidence: "low",
      ...copy.empty,
    }
  }

  if (greetingOnlyPatterns.some((pattern) => pattern.test(normalized))) {
    return {
      mode: "chat",
      needsClarification: false,
      confidence: "high",
      ...copy.greeting,
    }
  }

  const hasChatSignal = chatSignals.some((signal) => normalized.includes(signal))
  const hasAction = actionSignals.some((signal) => normalized.includes(signal))
  const hasTarget = targetSignals.some((signal) => normalized.includes(signal))
  const hasDetail = detailSignals.some((signal) => normalized.includes(signal))
  const hasConcreteDomain = domainSignals.some((signal) => normalized.includes(signal))
  const hasOnlyVagueTarget = hasTarget && !hasConcreteDomain && vagueTargetSignals.some((signal) => normalized.includes(signal))
  const hasAudience = audienceSignals.some((signal) => normalized.includes(signal))
  const hasStyle = styleSignals.some((signal) => normalized.includes(signal))
  const hasWorkspaceSignal = workspaceSignals.some((signal) => normalized.includes(signal))
  const hasPatchSignal = patchSignals.some((signal) => normalized.includes(signal))
  const hasInspectSignal = inspectSignals.some((signal) => normalized.includes(signal))
  const hasPreviewFailureSignal =
    normalized.includes("preview") &&
    (normalized.includes("error") ||
      normalized.includes("gagal") ||
      normalized.includes("tidak jalan") ||
      normalized.includes("tidak bisa") ||
      normalized.includes("broken") ||
      normalized.includes("crash") ||
      normalized.includes("stack") ||
      normalized.includes("runtime") ||
      normalized.includes("hydration"))
  const hasBuildKeyword =
    normalized.includes("full stack") ||
    normalized.includes("fullstack") ||
    normalized.includes("project") ||
    normalized.includes("starter") ||
    normalized.includes("boilerplate")
  const hasGenericBuildSignal = genericBuildSignals.some((signal) => normalized.includes(signal))
  if (hasInspectSignal || hasPreviewFailureSignal) {
    return {
      mode: "inspect",
      needsClarification: false,
      confidence: hasPreviewFailureSignal ? "high" : "medium",
      ...copy.inspect,
      summary:
        language === "id"
          ? "Prompt ini meminta diagnosis preview, jadi AI akan membaca evidence browser dan menjelaskan root cause paling mungkin."
          : "This prompt asks for a preview diagnosis, so AI will read browser evidence and explain the most likely root cause.",
      nextStep:
        language === "id"
          ? "Tambahkan file aktif, error browser, dan konteks preview jika ingin diagnosis yang lebih presisi."
          : "Add the active file, browser error, and preview context if you want a more precise diagnosis.",
      example:
        language === "id"
          ? "Contoh: Kenapa halaman template blank saat dibuka di preview?"
          : "Example: Why is the template page blank when opened in preview?",
    }
  }
  const forceGenerateBuild = (hasAction && hasGenericBuildSignal && !hasTarget && !hasBuildKeyword) || hasWorkspaceSignal

  if (hasChatSignal && !hasAction && !hasBuildKeyword && !hasPatchSignal && !hasWorkspaceSignal) {
    return {
      mode: "chat",
      needsClarification: false,
      confidence: "high",
      ...copy.chat,
    }
  }

  if (hasWorkspaceSignal) {
    return {
      mode: "build",
      needsClarification: false,
      confidence: "high",
      ...copy.build,
      summary:
        language === "id"
          ? "Prompt ini mengarah ke workspace builder, jadi AI akan membangun shell, editor, preview, dan output secara langsung."
          : "This prompt points to a workspace builder, so AI will build the shell, editor, preview, and output directly.",
      nextStep:
        language === "id"
          ? "Tambahkan detail kalau kamu ingin struktur yang lebih spesifik."
          : "Add more detail if you want a more specific structure.",
      example:
        language === "id"
          ? "Contoh: Buat workspace seperti Lovable dengan explorer, editor, preview, dan terminal."
          : "Example: Build a Lovable-style workspace with explorer, editor, preview, and terminal.",
    }
  }

  if (hasPatchSignal) {
    return {
      mode: "build",
      needsClarification: false,
      confidence: "high",
      ...copy.build,
      summary:
        language === "id"
          ? "Prompt ini terdengar seperti request patch atau iterasi project yang sudah ada."
          : "This prompt sounds like a patch or iteration request for an existing project.",
      nextStep:
        language === "id"
          ? "AI akan memperbaiki file yang ada dulu, lalu menambah file baru bila perlu."
          : "AI will patch the existing files first, then add new ones only if needed.",
      example:
        language === "id"
          ? "Contoh: Perbaiki UI dashboard ini dan tambahkan terminal output."
          : "Example: Improve this dashboard UI and add a terminal output panel.",
    }
  }

  if (forceGenerateBuild) {
    return {
      mode: "build",
      needsClarification: false,
      confidence: "medium",
      ...copy.build,
      summary:
        language === "id"
          ? "Prompt masih generik, tapi sistem akan tetap menjalankan generate memakai scaffold standar."
          : "The prompt is still generic, but the system will still run generation with a standard scaffold.",
      nextStep:
        language === "id"
          ? "Tambahkan detail jika ingin hasil yang lebih spesifik."
          : "Add more details if you want a more specific result.",
      example:
        language === "id"
          ? "Contoh: Generate landing page sederhana untuk produk kopi."
          : "Example: Generate a simple landing page for a coffee product.",
    }
  }

  const looksLikeBuildRequest = hasAction && (hasTarget || hasBuildKeyword || hasPatchSignal || hasWorkspaceSignal)
  if (looksLikeBuildRequest) {
    const specificityScore = [
      hasConcreteDomain,
      hasDetail,
      hasAudience,
      hasStyle,
      words.length >= 9,
    ].filter(Boolean).length
    const needsClarification =
      !hasPatchSignal &&
      !hasWorkspaceSignal &&
      (words.length <= 6 || hasOnlyVagueTarget || specificityScore < 2)

    return {
      mode: "build",
      needsClarification,
      confidence: needsClarification ? "medium" : "high",
      ...(needsClarification ? copy.clarify : copy.build),
      summary: needsClarification
        ? copy.clarify.summary
        : language === "id"
          ? "Prompt masih generik, tapi sistem akan tetap menjalankan generate memakai scaffold standar dan patch-first flow."
          : "The prompt is still generic, but the system will still run generation with a standard scaffold and patch-first flow.",
    }
  }

  return {
    mode: "chat",
    needsClarification: false,
    confidence: "medium",
    ...copy.defaultChat,
  }
}

export function buildClarifyingPrompt(prompt: string, language: PromptLanguage = "id") {
  const copy = PROMPT_INTENT_COPY[language].clarifyingPrompt

  return [
    copy.intro,
    `${copy.originalPrompt} ${prompt}`,
    copy.instruction,
    copy.focus,
    copy.noCode,
    copy.keepShort,
  ].join("\n\n")
}

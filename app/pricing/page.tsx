import Link from "next/link"
import { Fragment } from "react"
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "@/components/ui/accordion"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { TOPUP_MINIMUM_IDR } from "@/lib/billing/constants"
import { cn } from "@/lib/utils"
import {
  ArrowRight,
  BadgeCheck,
  Check,
  Clock3,
  CreditCard,
  type LucideIcon,
  Layers3,
  ShieldCheck,
  Sparkles,
  Users,
  Wallet,
} from "lucide-react"

const TOPUP_MINIMUM_LABEL = `Rp ${TOPUP_MINIMUM_IDR.toLocaleString("id-ID")}`

const plans = [
  {
    name: "Free",
    price: "Rp 0",
    period: "/bulan",
    description: "Untuk eksplorasi, validasi ide, dan build awal.",
    badge: "Mulai gratis",
    cta: "Buat akun gratis",
    href: "/signup",
    highlighted: false,
    features: [
      "5.000 credits per bulan",
      "Maksimal 3 project aktif",
      "Template dasar",
      "Komunitas support",
    ],
  },
  {
    name: "Builder",
    price: "Rp 99.000",
    period: "/bulan",
    description: "Untuk solo founder yang butuh volume credits lebih besar.",
    badge: "Paling populer",
    cta: "Lanjut ke billing",
    href: "/login?callbackUrl=%2Fdashboard%2Fsettings%3Ftab%3Dbilling",
    highlighted: true,
    features: [
      "50.000 credits per bulan",
      "Project tanpa batas",
      "Prioritas antrean generate",
      "Export project penuh",
      `Top up tambahan mulai ${TOPUP_MINIMUM_LABEL}`,
    ],
  },
  {
    name: "Studio",
    price: "Rp 249.000",
    period: "/bulan",
    description: "Untuk tim kecil yang butuh workspace, kontrol, dan prioritas.",
    badge: "Skala tim",
    cta: "Lanjut ke billing",
    href: "/login?callbackUrl=%2Fdashboard%2Fsettings%3Ftab%3Dbilling",
    highlighted: false,
    features: [
      "250.000 credits per bulan",
      "Kolaborasi workspace",
      "Priority support",
      "Advanced usage insights",
      `Top up manual dan crypto mulai ${TOPUP_MINIMUM_LABEL}`,
    ],
  },
]

const comparisonRows = [
  {
    label: "Credits bulanan",
    values: ["5.000", "50.000", "250.000"],
  },
  {
    label: "Project aktif",
    values: ["3", "Tanpa batas", "Tanpa batas"],
  },
  {
    label: "Workspace",
    values: ["1", "3", "Unlimited"],
  },
  {
    label: "Antrian generate",
    values: ["Standar", "Prioritas", "Prioritas utama"],
  },
  {
    label: "Support",
    values: ["Komunitas", "Email priority", "Priority chat"],
  },
  {
    label: "Purchase flow",
    values: ["Signup only", "Login → Billing", "Login → Billing"],
  },
  {
    label: "Top up minimum",
    values: [TOPUP_MINIMUM_LABEL, TOPUP_MINIMUM_LABEL, TOPUP_MINIMUM_LABEL],
  },
]

const faqItems = [
  {
    question: "Apa itu credits?",
    answer:
      "Credits adalah saldo yang dipakai untuk generate dan menjalankan pekerjaan di Swift. Setiap request akan mengurangi saldo secara transparan, sehingga kamu bisa memantau pemakaian dengan jelas di dashboard.",
  },
  {
    question: "Apakah saya bisa top up kapan saja?",
    answer:
      `Bisa. Top up tersedia dari dashboard billing dan bisa dibayar melalui Pakasir atau crypto. Minimum top up saat ini adalah ${TOPUP_MINIMUM_LABEL}.`,
  },
  {
    question: "Bagaimana dengan credits gratis?",
    answer:
      "Akun Free mendapatkan 5.000 credits per bulan, plus bonus awal saat pendaftaran. Itu cukup untuk mencoba alur kerja sebelum upgrade.",
  },
  {
    question: "Apakah plan ini mengunci saya ke satu paket?",
    answer:
      "Tidak. Kamu bisa mulai dari Free, lalu top up atau upgrade saat butuh volume dan workspace yang lebih besar.",
  },
  {
    question: "Kalau credits habis, apa yang terjadi?",
    answer:
      "Generate akan berhenti sampai saldo ditambah. Dashboard billing membantu kamu melihat riwayat transaksi, top up, dan refund secara langsung.",
  },
]

export default function PricingPage() {
  return (
    <main className="relative min-h-screen overflow-hidden bg-background">
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_top_left,oklch(0.985_0_0_/_0.8),transparent_28%),radial-gradient(circle_at_top_right,oklch(0.97_0_0_/_0.52),transparent_24%),radial-gradient(circle_at_bottom_center,oklch(0.145_0_0_/_0.08),transparent_30%)] dark:bg-[radial-gradient(circle_at_top_left,oklch(0.269_0_0_/_0.78),transparent_24%),radial-gradient(circle_at_top_right,oklch(0.205_0_0_/_0.5),transparent_20%),radial-gradient(circle_at_bottom_center,oklch(0.985_0_0_/_0.04),transparent_28%)]" />
      <div className="relative mx-auto flex max-w-7xl flex-col gap-16 px-4 py-16 sm:px-6 lg:px-8 lg:py-20">
        <section className="mx-auto max-w-4xl text-center">
          <Badge className="mx-auto mb-5 gap-2 rounded-full border border-border/70 bg-background/80 px-4 py-2 text-xs font-medium text-foreground shadow-sm">
            <Sparkles className="h-3.5 w-3.5" />
            Pricing & billing
          </Badge>
          <h1 className="text-4xl font-semibold tracking-tight text-foreground sm:text-5xl lg:text-6xl">
            Harga yang jelas, credits yang transparan, dan upgrade tanpa kejutan.
          </h1>
          <p className="mx-auto mt-5 max-w-3xl text-base leading-7 text-muted-foreground sm:text-lg">
            Mulai gratis dengan 5.000 credits, lalu pilih paket yang sesuai saat produk mulai dipakai serius. Semua billing tetap selaras dengan dashboard, top up, dan riwayat penggunaan.
          </p>

          <div className="mt-8 flex flex-wrap justify-center gap-3">
            <InfoPill icon={ShieldCheck} text={`Top up minimum ${TOPUP_MINIMUM_LABEL}`} />
            <InfoPill icon={CreditCard} text="Pakasir + Crypto" />
            <InfoPill icon={Clock3} text="Billing transparan di dashboard" />
            <InfoPill icon={Wallet} text="Credits dibaca sebagai balance" />
          </div>
        </section>

        <section className="grid gap-6 lg:grid-cols-[1.1fr,0.9fr]">
          <Card className="overflow-hidden border-border/70 shadow-sm lg:col-span-1">
            <CardHeader className="space-y-3 border-b border-border/70 bg-muted/20">
              <CardTitle className="flex items-center gap-2 text-2xl">
                <Layers3 className="h-5 w-5" />
                Paket yang dirancang untuk bertumbuh
              </CardTitle>
              <CardDescription>
                Tiga paket inti yang memandu pengguna dari coba-coba ke workflow serius.
              </CardDescription>
            </CardHeader>
            <CardContent className="grid gap-4 p-4 sm:p-6 xl:grid-cols-3">
              {plans.map((plan) => (
                <PlanCard key={plan.name} plan={plan} />
              ))}
            </CardContent>
          </Card>

          <Card className="overflow-hidden border-border/70 shadow-sm">
            <CardHeader className="space-y-3 border-b border-border/70 bg-muted/20">
              <CardTitle>Kenapa model ini terasa lebih masuk akal</CardTitle>
              <CardDescription>
                Pricing page harus menjelaskan cara kerja produk, bukan hanya menampilkan angka.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4 p-6">
              <div className="rounded-3xl border border-border/70 bg-background/70 p-5">
                <div className="text-sm font-medium text-foreground">Credit-first billing</div>
                <p className="mt-2 text-sm leading-6 text-muted-foreground">
                  Setiap paket menunjukkan credits yang didapat, lalu user bisa top up tambahan kapan saja dari dashboard billing. Ini menjaga ekspektasi tetap jelas.
                </p>
              </div>

              <div className="grid gap-3 sm:grid-cols-2">
                <MiniStat label="Minimum top up" value={TOPUP_MINIMUM_LABEL} />
                <MiniStat label="Payment methods" value="Pakasir + Crypto" />
                <MiniStat label="Free credits" value="5.000 / bulan" />
                <MiniStat label="Billing view" value="Dashboard" />
              </div>

              <div className="rounded-3xl border border-dashed border-border/70 bg-muted/20 p-5">
                <div className="flex items-center gap-2 text-sm font-medium text-foreground">
                  <BadgeCheck className="h-4 w-4 text-primary" />
                  Aturan pembelian
                </div>
                <ul className="mt-3 space-y-2 text-sm leading-6 text-muted-foreground">
                  <li>• Free plan langsung ke signup, tanpa checkout.</li>
                  <li>• Builder dan Studio dibeli lewat dashboard billing setelah login.</li>
                  <li>• Top up credits selalu minimal {TOPUP_MINIMUM_LABEL} untuk semua metode pembayaran.</li>
                </ul>
              </div>
            </CardContent>
          </Card>
        </section>

        <section className="grid gap-6 xl:grid-cols-[1.2fr,0.8fr]">
          <Card className="overflow-hidden border-border/70 shadow-sm">
            <CardHeader className="border-b border-border/70 bg-muted/20">
              <CardTitle>Perbandingan paket</CardTitle>
              <CardDescription>
                Lihat perbedaan inti dalam satu tampilan, supaya keputusan tidak terasa kabur.
              </CardDescription>
            </CardHeader>
            <CardContent className="overflow-x-auto p-0">
              <div className="min-w-[720px] p-6">
                <div className="grid grid-cols-[1.3fr_repeat(3,minmax(0,1fr))] gap-3 text-sm">
                  <div className="text-xs font-medium uppercase tracking-[0.24em] text-muted-foreground">
                    Feature
                  </div>
                  {plans.map((plan) => (
                    <div
                      key={plan.name}
                      className={cn(
                        "rounded-2xl border px-4 py-3 text-center",
                        plan.highlighted
                          ? "border-primary/30 bg-primary/10 text-foreground"
                          : "border-border/70 bg-background/60 text-muted-foreground"
                      )}
                    >
                      <div className="font-semibold text-foreground">{plan.name}</div>
                      <div className="mt-1 text-xs text-muted-foreground">{plan.price}</div>
                    </div>
                  ))}

                  {comparisonRows.map((row) => (
                    <Fragment key={row.label}>
                      <div
                        className="flex items-center rounded-2xl border border-border/70 bg-muted/20 px-4 py-4 font-medium text-foreground"
                      >
                        {row.label}
                      </div>
                      {row.values.map((value, index) => (
                        <div
                          key={`${row.label}-${index}`}
                          className="flex items-center justify-center rounded-2xl border border-border/70 bg-background/70 px-4 py-4 text-center text-sm text-foreground"
                        >
                          {value}
                        </div>
                      ))}
                    </Fragment>
                  ))}
                </div>
              </div>
            </CardContent>
          </Card>

          <Card className="overflow-hidden border-border/70 shadow-sm">
            <CardHeader className="border-b border-border/70 bg-muted/20">
              <CardTitle>Billing shortcuts</CardTitle>
              <CardDescription>
                Jalur tercepat untuk mulai, upgrade, atau top up saldo.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4 p-6">
              <div className="rounded-3xl border border-border/70 bg-background/70 p-5">
                <div className="flex items-center gap-2 text-sm font-medium text-foreground">
                  <Wallet className="h-4 w-4 text-primary" />
                  Top up sekarang
                </div>
                <p className="mt-2 text-sm leading-6 text-muted-foreground">
                  Buka dashboard billing untuk mengisi saldo credits dan melihat riwayat transaksi.
                </p>
                <Button asChild className="mt-4 w-full rounded-full">
                  <Link href="/dashboard/settings?tab=billing" className="inline-flex items-center justify-center gap-2">
                    Open billing
                    <ArrowRight className="h-4 w-4" />
                  </Link>
                </Button>
              </div>

              <div className="grid gap-3 sm:grid-cols-2">
                <Link href="/signup" className="block">
                  <Card className="h-full border-border/70 bg-card/80 transition-transform hover:-translate-y-0.5">
                    <CardContent className="p-4">
                      <div className="flex items-center gap-2 text-sm font-medium text-foreground">
                        <Users className="h-4 w-4 text-primary" />
                        Start free
                      </div>
                      <p className="mt-2 text-sm leading-6 text-muted-foreground">
                        Cocok untuk mencoba Swift sebelum masuk ke billing.
                      </p>
                    </CardContent>
                  </Card>
                </Link>
                <Link href="/dashboard/settings?tab=billing" className="block">
                  <Card className="h-full border-border/70 bg-card/80 transition-transform hover:-translate-y-0.5">
                    <CardContent className="p-4">
                      <div className="flex items-center gap-2 text-sm font-medium text-foreground">
                        <ShieldCheck className="h-4 w-4 text-primary" />
                        Existing user
                      </div>
                      <p className="mt-2 text-sm leading-6 text-muted-foreground">
                        Langsung top up dan lihat histori billing.
                      </p>
                    </CardContent>
                  </Card>
                </Link>
              </div>
            </CardContent>
          </Card>
        </section>

        <section className="grid gap-6 lg:grid-cols-[0.9fr,1.1fr]">
          <Card className="overflow-hidden border-border/70 shadow-sm">
            <CardHeader className="border-b border-border/70 bg-muted/20">
              <CardTitle>Ringkasan singkat</CardTitle>
              <CardDescription>
                Hal-hal yang perlu user lihat dalam 5 detik.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4 p-6">
              <SummaryLine label="Harga mulai" value="Rp 0" />
              <SummaryLine label="Top up minimum" value={TOPUP_MINIMUM_LABEL} />
              <SummaryLine label="Free credits" value="5.000 credits / bulan" />
              <SummaryLine label="Payment methods" value="Pakasir & Crypto" />
              <SummaryLine label="Target utama" value="Solo builder sampai tim kecil" />
            </CardContent>
          </Card>

          <Card className="overflow-hidden border-border/70 shadow-sm">
            <CardHeader className="border-b border-border/70 bg-muted/20">
              <CardTitle>Frequently asked questions</CardTitle>
              <CardDescription>
                Jawaban yang sering dicari sebelum orang mulai berlangganan atau top up.
              </CardDescription>
            </CardHeader>
            <CardContent className="p-0">
              <Accordion type="single" collapsible className="px-6">
                {faqItems.map((item, index) => (
                  <AccordionItem key={item.question} value={`item-${index}`}>
                    <AccordionTrigger>{item.question}</AccordionTrigger>
                    <AccordionContent className="text-muted-foreground">
                      {item.answer}
                    </AccordionContent>
                  </AccordionItem>
                ))}
              </Accordion>
            </CardContent>
          </Card>
        </section>

        <section className="relative overflow-hidden rounded-3xl border border-border/70 bg-card/90 px-6 py-8 shadow-sm sm:px-8 sm:py-10">
          <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_top_right,oklch(0.985_0_0_/_0.55),transparent_28%),radial-gradient(circle_at_bottom_left,oklch(0.97_0_0_/_0.35),transparent_24%)] dark:bg-[radial-gradient(circle_at_top_right,oklch(0.205_0_0_/_0.42),transparent_24%),radial-gradient(circle_at_bottom_left,oklch(0.269_0_0_/_0.28),transparent_22%)]" />
          <div className="relative flex flex-col gap-6 lg:flex-row lg:items-center lg:justify-between">
            <div className="max-w-2xl space-y-3">
              <div className="inline-flex items-center gap-2 rounded-full border border-border/70 bg-background/80 px-3 py-1.5 text-xs font-medium text-foreground">
                <Sparkles className="h-3.5 w-3.5" />
                Ready to start
              </div>
              <h2 className="text-3xl font-semibold tracking-tight text-foreground">
                Mulai gratis, lalu scale saat workflownya sudah terbukti.
              </h2>
              <p className="text-sm leading-6 text-muted-foreground sm:text-base">
                Pricing page ini harus membuat keputusan mudah: coba gratis, buka billing saat siap, dan tetap punya jalur yang jelas untuk top up credits kapan saja dengan floor {TOPUP_MINIMUM_LABEL}.
              </p>
            </div>
            <div className="flex flex-wrap gap-3">
              <Button asChild className="rounded-full px-5 shadow-sm">
                <Link href="/signup" className="inline-flex items-center gap-2">
                  Mulai gratis
                  <ArrowRight className="h-4 w-4" />
                </Link>
              </Button>
              <Button asChild variant="outline" className="rounded-full px-5 shadow-sm">
                <Link href="/dashboard/settings?tab=billing" className="inline-flex items-center gap-2">
                  Buka billing
                  <CreditCard className="h-4 w-4" />
                </Link>
              </Button>
            </div>
          </div>
        </section>
      </div>
    </main>
  )
}

function PlanCard({
  plan,
}: {
  plan: (typeof plans)[number]
}) {
  return (
    <Card
      className={cn(
        "relative flex h-full flex-col overflow-hidden border-border/70 shadow-sm transition-all hover:-translate-y-1 hover:shadow-lg",
        plan.highlighted && "border-primary/40 bg-primary/5 shadow-md shadow-primary/10"
      )}
    >
      {plan.highlighted && (
        <div className="absolute inset-x-0 top-0 h-1 bg-gradient-to-r from-primary via-primary/70 to-primary/30" />
      )}
      <CardHeader className="space-y-3">
        <div className="flex items-center justify-between gap-3">
          <CardTitle className="text-xl">{plan.name}</CardTitle>
          <Badge variant={plan.highlighted ? "default" : "secondary"} className="rounded-full px-2.5 py-1 text-[11px]">
            {plan.badge}
          </Badge>
        </div>
        <CardDescription className="min-h-12 leading-6 text-muted-foreground">
          {plan.description}
        </CardDescription>
        <div className="flex items-end gap-2">
          <span className="text-3xl font-semibold tracking-tight text-foreground">{plan.price}</span>
          <span className="pb-1 text-sm text-muted-foreground">{plan.period}</span>
        </div>
      </CardHeader>
      <CardContent className="flex flex-1 flex-col justify-between gap-6">
        <ul className="space-y-3 text-sm text-foreground">
          {plan.features.map((feature) => (
            <li key={feature} className="flex items-start gap-2">
              <Check className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
              <span className="leading-6 text-muted-foreground">{feature}</span>
            </li>
          ))}
        </ul>
        <div className="space-y-3">
          <Button asChild className="w-full rounded-full" variant={plan.highlighted ? "default" : "outline"}>
            <Link href={plan.href}>{plan.cta}</Link>
          </Button>
          {plan.highlighted && (
            <p className="text-center text-xs text-muted-foreground">
              Direkomendasikan untuk solo founder yang butuh volume credits lebih besar.
            </p>
          )}
        </div>
      </CardContent>
    </Card>
  )
}

function InfoPill({
  icon: Icon,
  text,
}: {
  icon: LucideIcon
  text: string
}) {
  return (
    <span className="inline-flex items-center gap-2 rounded-full border border-border/70 bg-card/80 px-4 py-2 text-sm text-muted-foreground shadow-sm">
      <Icon className="h-4 w-4 text-primary" />
      {text}
    </span>
  )
}

function MiniStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-2xl border border-border/70 bg-background/70 p-4">
      <div className="text-xs uppercase tracking-[0.2em] text-muted-foreground">{label}</div>
      <div className="mt-2 text-sm font-semibold text-foreground">{value}</div>
    </div>
  )
}

function SummaryLine({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-4 rounded-2xl border border-border/70 bg-background/70 px-4 py-3">
      <span className="text-sm text-muted-foreground">{label}</span>
      <span className="text-sm font-medium text-foreground">{value}</span>
    </div>
  )
}

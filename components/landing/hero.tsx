"use client"

import Link from "next/link"
import { ArrowRight, CheckCircle2, Code2, Play, Send, ShieldCheck, Sparkles } from "lucide-react"
import { Button } from "@/components/ui/button"

const trustItems = [
  "Validasi build sebelum preview",
  "Retry dan refund aman",
  "Sandbox terisolasi",
]

const generatedFiles = [
  "app/page.tsx",
  "app/api/leads/route.ts",
  "components/lead-form.tsx",
  "prisma/schema.prisma",
]

export function Hero() {
  return (
    <section className="relative border-b border-border bg-background pt-24 sm:pt-28">
      <div className="mx-auto grid min-h-[calc(100vh-4rem)] max-w-7xl items-center gap-10 px-4 py-10 sm:px-6 lg:grid-cols-[0.9fr,1.1fr] lg:px-8 lg:py-14">
        <div className="max-w-2xl">
          <div className="mb-6 inline-flex items-center gap-2 rounded-full border border-border bg-secondary/70 px-3 py-1.5 text-xs font-medium text-muted-foreground">
            <Sparkles className="h-3.5 w-3.5 text-primary" />
            Builder aplikasi AI untuk tim yang ingin rilis, bukan sekadar demo
          </div>

          <h1 className="text-balance text-5xl font-semibold tracking-tight text-foreground sm:text-6xl lg:text-7xl">
            Bangun aplikasi web dari satu prompt.
          </h1>

          <p className="mt-6 max-w-xl text-pretty text-lg leading-8 text-muted-foreground sm:text-xl">
            Swift AI mengubah ide menjadi project Next.js yang divalidasi, dipreview, diperbaiki otomatis, lalu siap disimpan dan dideploy.
          </p>

          <div className="mt-8 flex flex-col gap-3 sm:flex-row">
            <Link href="/dashboard">
              <Button size="lg" className="h-12 gap-2 rounded-lg px-5 text-sm font-semibold">
                Mulai membangun
                <ArrowRight className="h-4 w-4" />
              </Button>
            </Link>
            <Link href="#demo">
              <Button variant="outline" size="lg" className="h-12 gap-2 rounded-lg px-5 text-sm font-semibold">
                <Play className="h-4 w-4" />
                Lihat alur kerja
              </Button>
            </Link>
          </div>

          <div className="mt-8 grid gap-3 text-sm text-muted-foreground sm:grid-cols-3">
            {trustItems.map((item) => (
              <div key={item} className="flex items-start gap-2">
                <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
                <span>{item}</span>
              </div>
            ))}
          </div>
        </div>

        <div className="w-full">
          <div className="overflow-hidden rounded-xl border border-border bg-card shadow-2xl shadow-black/15">
            <div className="flex items-center justify-between border-b border-border bg-secondary/55 px-4 py-3">
              <div className="flex items-center gap-2">
                <div className="h-2.5 w-2.5 rounded-full bg-emerald-500" />
                <span className="text-xs font-medium uppercase tracking-[0.18em] text-muted-foreground">
                  Swift Builder
                </span>
              </div>
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <ShieldCheck className="h-3.5 w-3.5 text-primary" />
                  Gate produksi aktif
              </div>
            </div>

            <div className="grid lg:grid-cols-[0.92fr,1.08fr]">
              <div className="border-b border-border bg-background p-4 lg:border-b-0 lg:border-r">
                <div className="rounded-lg border border-border bg-card p-3">
                  <div className="mb-2 text-xs font-medium uppercase tracking-[0.18em] text-muted-foreground">
                    Prompt
                  </div>
                  <p className="min-h-28 text-sm leading-6 text-foreground">
                    Buat SaaS dashboard untuk tim sales dengan login, tabel lead, form tambah lead, dan grafik pipeline mingguan.
                  </p>
                  <div className="mt-4 flex items-center justify-between gap-3 border-t border-border pt-3">
                    <span className="text-xs text-muted-foreground">Mode: bangun</span>
                    <Button size="sm" className="h-9 gap-2 rounded-md px-3">
                      <Send className="h-3.5 w-3.5" />
                      Buat
                    </Button>
                  </div>
                </div>

                <div className="mt-4 space-y-2">
                  {["Rencana file", "Validasi import", "Build preview", "Repair otomatis"].map((step, index) => (
                    <div key={step} className="flex items-center gap-3 rounded-lg border border-border bg-card px-3 py-2.5">
                      <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-primary/10 text-xs font-semibold text-primary">
                        {index + 1}
                      </span>
                      <span className="text-sm text-foreground">{step}</span>
                    </div>
                  ))}
                </div>
              </div>

              <div className="bg-card p-4">
                <div className="mb-3 flex items-center justify-between">
                  <div>
                    <div className="text-xs font-medium uppercase tracking-[0.18em] text-muted-foreground">
                      Output
                    </div>
                    <div className="mt-1 text-sm font-semibold text-foreground">Aplikasi Pipeline Sales</div>
                  </div>
                  <div className="rounded-full border border-emerald-500/25 bg-emerald-500/10 px-2.5 py-1 text-[11px] font-medium text-emerald-600 dark:text-emerald-300">
                    Build lolos
                  </div>
                </div>

                <div className="rounded-lg border border-border bg-background p-4">
                  <div className="grid gap-3 sm:grid-cols-3">
                    <Metric label="Lead" value="1.284" />
                    <Metric label="Pipeline" value="Rp82M" />
                    <Metric label="Rasio menang" value="32%" />
                  </div>
                  <div className="mt-4 h-32 rounded-lg border border-border bg-card p-3">
                    <div className="flex h-full items-end gap-2">
                      {[42, 58, 49, 70, 61, 84, 76].map((height, index) => (
                        <div key={index} className="flex-1 rounded-t-md bg-primary/80" style={{ height: `${height}%` }} />
                      ))}
                    </div>
                  </div>
                </div>

                <div className="mt-4 rounded-lg border border-border bg-background">
                  <div className="flex items-center gap-2 border-b border-border px-3 py-2 text-xs font-medium text-muted-foreground">
                    <Code2 className="h-3.5 w-3.5" />
                    File yang dibuat
                  </div>
                  <div className="divide-y divide-border">
                    {generatedFiles.map((file) => (
                      <div key={file} className="px-3 py-2 font-mono text-xs text-muted-foreground">
                        {file}
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  )
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-border bg-card p-3">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="mt-1 text-lg font-semibold text-foreground">{value}</div>
    </div>
  )
}

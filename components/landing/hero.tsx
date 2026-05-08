"use client"

import Link from "next/link"
import { Button } from "@/components/ui/button"
import { ArrowRight, Play } from "lucide-react"

export function Hero() {
  return (
    <section className="relative overflow-hidden pt-40 pb-24 sm:pt-48 sm:pb-36">
      {/* Background gradient - warm terracotta accent */}
      <div className="pointer-events-none absolute inset-0 overflow-hidden">
        <div className="absolute -top-1/3 left-1/2 h-[900px] w-[900px] -translate-x-1/2 rounded-full bg-primary/8 blur-3xl" />
        <div className="absolute -bottom-1/4 right-0 h-[700px] w-[700px] rounded-full bg-accent/5 blur-3xl" />
      </div>

      <div className="relative mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
        <div className="mx-auto max-w-4xl text-center">
          <div className="mb-8 inline-flex items-center gap-2.5 rounded-full border border-primary/30 bg-primary/10 px-4 py-2 text-sm font-medium text-primary">
            <span className="flex h-2 w-2 rounded-full bg-primary animate-pulse" />
            Didukung oleh AI Modern
          </div>
          
          <h1 className="text-balance text-5xl font-bold tracking-tight text-foreground sm:text-7xl lg:text-8xl">
            Buat Web<br className="hidden sm:inline" /> dengan AI
          </h1>
          
          <p className="mx-auto mt-8 max-w-2xl text-pretty text-xl text-muted-foreground sm:text-2xl leading-relaxed">
            Berdayakan seluruh tim Anda untuk menciptakan dengan kecepatan pikiran. Jelaskan apa yang Anda inginkan, saksikan menjadi kenyataan.
          </p>

          <div className="mt-12 flex flex-col items-center justify-center gap-4 sm:flex-row">
            <Link href="/dashboard">
              <Button size="lg" className="gap-2 text-base font-semibold px-8 py-6">
                Mulai Membangun
                <ArrowRight className="h-5 w-5" />
              </Button>
            </Link>
            <Button variant="outline" size="lg" className="gap-2 text-base font-semibold px-8 py-6">
              <Play className="h-5 w-5" />
              Tonton Demo
            </Button>
          </div>
        </div>

        {/* Demo Preview */}
        <div className="mt-24">
          <div className="relative mx-auto max-w-5xl overflow-hidden rounded-2xl border border-border bg-card shadow-2xl">
            <div className="flex items-center gap-2 border-b border-border bg-secondary/70 px-4 py-3">
              <div className="flex gap-1.5">
                <div className="h-3 w-3 rounded-full bg-red-500/80" />
                <div className="h-3 w-3 rounded-full bg-yellow-500/80" />
                <div className="h-3 w-3 rounded-full bg-green-500/80" />
              </div>
              <div className="flex-1 text-center">
                <span className="text-xs text-muted-foreground">swift.dev/dashboard</span>
              </div>
            </div>
            <div className="grid grid-cols-1 lg:grid-cols-2">
              {/* Chat Panel */}
              <div className="border-r border-border p-6 bg-background/50">
                <div className="space-y-4">
                  <div className="flex gap-3">
                    <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-secondary">
                      <span className="text-xs font-medium">A</span>
                    </div>
                    <div className="rounded-lg bg-secondary/70 px-4 py-2.5 text-sm text-foreground">
                      Buat modal pendaftaran dengan form. Saat form dikirim, tampilkan notifikasi sukses.
                    </div>
                  </div>
                  <div className="flex gap-3">
                    <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-primary">
                      <Zap className="h-4 w-4 text-primary-foreground" />
                    </div>
                    <div className="space-y-2 text-sm text-muted-foreground">
                      <p>{"Saya akan membuat modal dengan form dan menampilkan notifikasi saat form dikirim. Menggunakan shadcn/ui, React dan Tailwind:"}</p>
                      <div className="rounded-lg border border-border bg-card p-3">
                        <div className="flex items-center justify-between">
                          <span className="text-xs text-muted-foreground">Modal Pendaftaran</span>
                          <span className="rounded bg-primary/20 px-2 py-0.5 text-xs text-primary font-medium">v1</span>
                        </div>
                        <div className="mt-2 flex items-center gap-2 text-xs text-muted-foreground">
                          <div className="h-3 w-3 animate-spin rounded-full border-2 border-muted-foreground border-t-transparent" />
                          Membuat...
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
              {/* Preview Panel */}
              <div className="bg-background p-6">
                <div className="mb-4 flex items-center gap-2">
                  <span className="text-sm font-semibold text-foreground">Modal Pendaftaran</span>
                </div>
                <div className="flex items-center gap-4 border-b border-border pb-3">
                  <button className="text-sm font-medium text-foreground">Pratinjau</button>
                  <button className="text-sm text-muted-foreground">modal.tsx</button>
                </div>
                <div className="mt-4 font-mono text-xs leading-relaxed">
                  <div><span className="text-muted-foreground">1</span> <span className="code-string">{"'use client'"}</span></div>
                  <div><span className="text-muted-foreground">2</span></div>
                  <div><span className="text-muted-foreground">3</span> <span className="code-keyword">import</span> {"{ useFormStatus }"} <span className="code-keyword">from</span> <span className="code-string">{'"react-dom"'}</span></div>
                  <div><span className="text-muted-foreground">4</span> <span className="code-keyword">import</span> {"{ Button }"} <span className="code-keyword">from</span> <span className="code-string">{'"@/components/ui/button"'}</span></div>
                  <div><span className="text-muted-foreground">5</span> <span className="code-keyword">import</span> {"{ Input }"} <span className="code-keyword">from</span> <span className="code-string">{'"@/components/ui/input"'}</span></div>
                  <div><span className="text-muted-foreground">6</span> <span className="code-keyword">import</span> {"{ Label }"} <span className="code-keyword">from</span> <span className="code-string">{'"@/components/ui/label"'}</span></div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  )
}

function Zap({ className }: { className?: string }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
    >
      <path d="M4 14a1 1 0 0 1-.78-1.63l9.9-10.2a.5.5 0 0 1 .86.46l-1.92 6.02A1 1 0 0 0 13 10h7a1 1 0 0 1 .78 1.63l-9.9 10.2a.5.5 0 0 1-.86-.46l1.92-6.02A1 1 0 0 0 11 14z" />
    </svg>
  )
}

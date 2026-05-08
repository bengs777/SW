import Link from "next/link"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { ArrowRight, CheckCircle2, Layers3, Sparkles, WandSparkles } from "lucide-react"

export function CTA() {
  return (
    <section className="border-t border-border py-24 sm:py-36">
      <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
        <div className="relative overflow-hidden rounded-3xl border border-border bg-card px-6 py-8 shadow-2xl shadow-black/5 sm:px-10 sm:py-12 lg:px-14 lg:py-14">
          <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_top_left,oklch(0.68_0.18_28_/_0.1),transparent_26%),radial-gradient(circle_at_top_right,oklch(0.65_0.16_25_/_0.08),transparent_24%),radial-gradient(circle_at_bottom_right,oklch(0.68_0.18_28_/_0.05),transparent_28%)] dark:bg-[radial-gradient(circle_at_top_left,oklch(0.68_0.18_28_/_0.15),transparent_24%),radial-gradient(circle_at_top_right,oklch(0.65_0.16_25_/_0.1),transparent_22%),radial-gradient(circle_at_bottom_right,oklch(0.7_0.18_25_/_0.08),transparent_26%)]" />
          <div className="relative grid items-center gap-12 lg:grid-cols-[1.05fr,0.95fr] lg:gap-14">
            <div className="space-y-8">
              <Badge className="gap-2 rounded-full border border-primary/30 bg-primary/10 px-4 py-2 text-xs font-medium text-primary">
                <Sparkles className="h-3.5 w-3.5" />
                Dibangun untuk tim yang siap meluncurkan
              </Badge>
              <div className="space-y-6">
                <h2 className="text-balance text-4xl font-bold tracking-tight text-foreground sm:text-5xl lg:text-5xl">
                  Siap berubah dari ide ke UI yang sempurna?
                </h2>
                <p className="max-w-xl text-pretty text-lg leading-8 text-muted-foreground">
                  Swift memberi Anda paket hasil konkret, bukan kanvas kosong. Mulai gratis, inspeksi output yang dihasilkan, dan terus ulangi hingga siap diproduksi.
                </p>
              </div>

              <div className="flex flex-wrap gap-4">
                <Link href="/signup">
                  <Button size="lg" className="gap-2 rounded-full px-6 shadow-sm text-base font-semibold">
                    Mulai Gratis
                    <ArrowRight className="h-5 w-5" />
                  </Button>
                </Link>
                <Link href="/pricing">
                  <Button variant="outline" size="lg" className="rounded-full px-6 shadow-sm text-base font-semibold">
                    Lihat Harga
                  </Button>
                </Link>
              </div>

              <div className="grid gap-4 sm:grid-cols-3">
                <MiniStat icon={WandSparkles} label="Prompt ke UI" value="Menit" />
                <MiniStat icon={Layers3} label="Paket hasil" value="Bagian + file" />
                <MiniStat icon={CheckCircle2} label="Siap produksi" value="Bawaan" />
              </div>
            </div>

            <div className="relative">
              <div className="absolute -inset-6 rounded-[2.25rem] bg-gradient-to-br from-primary/10 via-transparent to-accent/10 blur-2xl" />
              <div className="relative overflow-hidden rounded-[1.75rem] border border-border bg-background shadow-xl">
                <div className="flex items-center justify-between gap-3 border-b border-border px-4 py-3">
                  <div className="flex items-center gap-2">
                    <div className="h-2.5 w-2.5 rounded-full bg-emerald-500" />
                    <span className="text-xs font-medium uppercase tracking-[0.24em] text-muted-foreground">
                      Swift output preview
                    </span>
                  </div>
                  <Badge variant="secondary" className="rounded-full px-2.5 py-1 text-[11px]">
                    Ready to ship
                  </Badge>
                </div>

                <div className="grid gap-0 lg:grid-cols-[0.95fr,1.05fr]">
                  <div className="border-b border-border bg-secondary/30 p-5 lg:border-b-0 lg:border-r">
                    <div className="space-y-4">
                      <div className="rounded-2xl border border-border bg-card p-4 shadow-sm">
                        <div className="text-xs font-medium uppercase tracking-[0.24em] text-muted-foreground">
                          Prompt
                        </div>
                        <p className="mt-2 text-sm leading-6 text-foreground">
                          Buat modal pendaftaran dengan validasi dan toast sukses.
                        </p>
                      </div>

                      <div className="rounded-2xl border border-border bg-card p-4 shadow-sm">
                        <div className="flex items-center justify-between gap-3">
                          <span className="text-sm font-medium text-foreground">Output yang dihasilkan</span>
                          <span className="rounded-full bg-primary/10 px-2.5 py-1 text-[11px] font-medium text-primary">
                            4 blok
                          </span>
                        </div>
                        <div className="mt-4 space-y-3">
                          <PreviewRow title="Layout form" value="Field, label, teks bantuan" />
                          <PreviewRow title="Validasi" value="State dan error inline" />
                          <PreviewRow title="Sukses" value="Toast dan konfirmasi" />
                          <PreviewRow title="File" value="modal.tsx, toast.tsx" />
                        </div>
                      </div>
                    </div>
                  </div>

                  <div className="bg-background p-5">
                    <div className="rounded-[1.5rem] border border-border bg-card p-4 shadow-sm">
                      <div className="flex items-center justify-between gap-3 border-b border-border pb-3">
                        <div>
                          <div className="text-xs font-medium uppercase tracking-[0.24em] text-muted-foreground">
                            Pratinjau langsung
                          </div>
                          <div className="mt-1 text-sm font-semibold text-foreground">Modal dengan Form</div>
                        </div>
                        <Badge variant="outline" className="rounded-full px-2.5 py-1 text-[11px]">
                          v1
                        </Badge>
                      </div>

                      <div className="mt-4 space-y-3">
                        <div className="rounded-2xl border border-border bg-muted/25 p-3">
                          <div className="h-3.5 w-24 rounded-full bg-muted" />
                          <div className="mt-3 h-10 rounded-xl border border-border bg-background" />
                          <div className="mt-2 h-10 rounded-xl border border-border bg-background" />
                          <div className="mt-2 h-10 rounded-xl border border-border bg-background" />
                          <div className="mt-4 h-10 rounded-xl bg-primary" />
                        </div>

                        <div className="grid gap-3 sm:grid-cols-2">
                          <div className="rounded-2xl border border-border bg-background p-3">
                            <div className="text-xs uppercase tracking-[0.2em] text-muted-foreground">File</div>
                            <div className="mt-2 text-sm font-medium text-foreground">modal.tsx</div>
                          </div>
                          <div className="rounded-2xl border border-border bg-background p-3">
                            <div className="text-xs uppercase tracking-[0.2em] text-muted-foreground">Kondisi</div>
                            <div className="mt-2 text-sm font-medium text-foreground">Siap sukses</div>
                          </div>
                        </div>
                      </div>
                    </div>
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

function MiniStat({
  icon: Icon,
  label,
  value,
}: {
  icon: React.ComponentType<{ className?: string }>
  label: string
  value: string
}) {
  return (
    <div className="rounded-2xl border border-border bg-background/80 p-4 shadow-sm">
      <div className="flex items-start gap-3">
        <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-primary/10 text-primary">
          <Icon className="h-4 w-4" />
        </div>
        <div>
          <div className="text-xs uppercase tracking-[0.2em] text-muted-foreground">{label}</div>
          <div className="mt-1 text-sm font-semibold text-foreground">{value}</div>
        </div>
      </div>
    </div>
  )
}

function PreviewRow({ title, value }: { title: string; value: string }) {
  return (
    <div className="flex items-start justify-between gap-4 rounded-2xl border border-border bg-background px-3 py-3">
      <div>
        <div className="text-sm font-medium text-foreground">{title}</div>
        <div className="mt-1 text-xs leading-5 text-muted-foreground">{value}</div>
      </div>
      <div className="mt-1 h-2.5 w-2.5 rounded-full bg-primary" />
    </div>
  )
}

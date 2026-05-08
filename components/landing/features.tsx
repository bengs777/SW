import { Zap, Code2, Eye, Rocket, Sparkles, Shield } from "lucide-react"

const features = [
  {
    icon: Sparkles,
    title: "Generasi Bertenaga AI",
    description: "Jelaskan visi Anda dalam bahasa natural. AI kami memahami konteks dan menghasilkan kode siap produksi.",
  },
  {
    icon: Eye,
    title: "Pratinjau Langsung",
    description: "Lihat perubahan Anda secara real-time. Lingkungan pratinjau sandbox kami memungkinkan Anda berinteraksi dengan aplikasi secara instan.",
  },
  {
    icon: Code2,
    title: "Output Kode yang Bersih",
    description: "Ekspor komponen React yang bersih dan dapat dipelihara dengan TypeScript, Tailwind CSS, dan shadcn/ui.",
  },
  {
    icon: Zap,
    title: "Iterasi Instan",
    description: "Perbaiki dan ulangi dengan cepat. Minta perubahan dalam bahasa Inggris dan saksikan aplikasi Anda berkembang.",
  },
  {
    icon: Rocket,
    title: "Deploy Sekali Klik",
    description: "Deploy ke produksi dengan satu klik. Kami menangani hosting, CDN, dan SSL secara otomatis.",
  },
  {
    icon: Shield,
    title: "Siap Perusahaan",
    description: "Compliant SOC2, dukungan SSO, dan fitur kolaborasi tim untuk organisasi dari berbagai ukuran.",
  },
]

export function Features() {
  return (
    <section id="features" className="border-t border-border py-24 sm:py-36">
      <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
        <div className="mx-auto max-w-3xl text-center">
          <h2 className="text-balance text-4xl font-bold tracking-tight text-foreground sm:text-5xl">
            Semua yang Anda butuhkan untuk meluncurkan lebih cepat
          </h2>
          <p className="mt-6 text-pretty text-xl text-muted-foreground leading-relaxed">
            Dari ide hingga produksi dalam hitungan menit, bukan bulan. Swift memberi Anda alat untuk membangun dan deploy dengan percaya diri.
          </p>
        </div>

        <div className="mt-20 grid gap-8 sm:grid-cols-2 lg:grid-cols-3">
          {features.map((feature) => (
            <div
              key={feature.title}
              className="group relative rounded-xl border border-border bg-card p-6 transition-all hover:border-primary/40 hover:bg-card/80 hover:shadow-lg"
            >
              <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-lg bg-primary/10 group-hover:bg-primary/20 transition-colors">
                <feature.icon className="h-6 w-6 text-primary" />
              </div>
              <h3 className="text-lg font-semibold text-foreground">{feature.title}</h3>
              <p className="mt-3 text-sm text-muted-foreground leading-relaxed">{feature.description}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  )
}

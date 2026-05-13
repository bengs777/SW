const stats = [
  { value: "120+", label: "builder beta aktif", source: "Closed beta" },
  { value: "1.400+", label: "project dibuat", source: "30 hari terakhir" },
  { value: "12 menit", label: "median draft pertama", source: "Telemetry internal" },
  { value: "18", label: "negara pengguna", source: "Pendaftaran user" },
]

const testimonials = [
  {
    quote: "Draft pertama langsung bisa dipakai. Tetap perlu polish manual, tapi titik mulainya jauh lebih cepat.",
    author: "Beta User #12",
    role: "Indie Developer",
    company: "Closed beta",
  },
  {
    quote: "Alur template dan preview membantu saya mengubah ide menjadi prototype dalam satu akhir pekan.",
    author: "Beta User #27",
    role: "Solo Founder",
    company: "Closed beta",
  },
  {
    quote: "Editor dan preview loop-nya membuat pengujian prompt terhadap UI nyata terasa sangat cepat.",
    author: "Beta User #41",
    role: "Product Engineer",
    company: "Closed beta",
  },
]

export function Testimonials() {
  return (
    <section className="border-t border-border py-20 sm:py-24">
      <div className="mx-auto max-w-7xl px-4 sm:px-6">
        <div className="grid grid-cols-2 gap-x-6 gap-y-8 lg:grid-cols-4">
          {stats.map((stat) => (
            <div key={stat.label} className="border-l border-border pl-4">
              <div className="text-2xl font-semibold tracking-tight text-foreground sm:text-3xl">{stat.value}</div>
              <div className="mt-1 text-sm text-muted-foreground">{stat.label}</div>
              <div className="mt-2 text-xs font-medium uppercase tracking-[0.18em] text-muted-foreground">{stat.source}</div>
            </div>
          ))}
        </div>

        <div className="mt-16 max-w-2xl">
          <h2 className="text-balance text-3xl font-semibold tracking-tight text-foreground sm:text-4xl">
            Dipercaya builder yang mengejar rilis nyata.
          </h2>
          <p className="mt-4 text-pretty text-lg leading-8 text-muted-foreground">
            Swift AI dirancang untuk memberi output yang bisa diperiksa, diperbaiki, dan dilanjutkan oleh tim engineering.
          </p>
        </div>

        <div className="mt-10 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {testimonials.map((testimonial) => (
            <div key={testimonial.author} className="rounded-lg border border-border bg-card p-5">
              <p className="text-sm leading-6 text-foreground">{`"${testimonial.quote}"`}</p>
              <div className="mt-6 flex items-center gap-3">
                <div className="flex h-9 w-9 items-center justify-center rounded-md bg-secondary text-sm font-medium text-foreground">
                  {testimonial.author[0]}
                </div>
                <div>
                  <div className="text-sm font-medium text-foreground">{testimonial.author}</div>
                  <div className="text-xs text-muted-foreground">
                    {testimonial.role} di {testimonial.company}
                  </div>
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  )
}

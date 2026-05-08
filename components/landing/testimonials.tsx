const stats = [
  { value: "120+", label: "beta builders onboarded", company: "Closed beta" },
  { value: "1,400+", label: "projects scaffolded", company: "Last 30 days" },
  { value: "12 min", label: "median first draft time", company: "Internal telemetry" },
  { value: "18", label: "countries represented", company: "User signups" },
]

const testimonials = [
  {
    quote: "First usable draft in one sitting. We still polish manually, but the head start is massive.",
    author: "Beta User #12",
    role: "Indie Developer",
    company: "Closed beta",
  },
  {
    quote: "The template flow helped me move from idea to prototype over a weekend.",
    author: "Beta User #27",
    role: "Solo Founder",
    company: "Closed beta",
  },
  {
    quote: "The editor plus preview loop is the fastest way I've tested prompts against real UI output.",
    author: "Beta User #41",
    role: "Product Engineer",
    company: "Closed beta",
  },
]

export function Testimonials() {
  return (
    <section className="border-t border-border py-20 sm:py-32">
      <div className="mx-auto max-w-7xl px-4 sm:px-6">
        {/* Stats */}
        <div className="mb-20 grid grid-cols-2 gap-8 lg:grid-cols-4">
          {stats.map((stat) => (
            <div key={stat.company} className="border-l border-border pl-6">
              <div className="text-2xl font-bold text-foreground sm:text-3xl">{stat.value}</div>
              <div className="mt-1 text-sm text-muted-foreground">{stat.label}</div>
              <div className="mt-3 text-sm font-medium text-muted-foreground">{stat.company}</div>
            </div>
          ))}
        </div>

        {/* Testimonials */}
        <div className="mx-auto max-w-2xl text-center">
          <h2 className="text-balance text-3xl font-bold tracking-tight text-foreground sm:text-4xl">
            Trusted by builders everywhere
          </h2>
          <p className="mt-4 text-pretty text-lg text-muted-foreground">
            See what developers and teams are saying about building with Swift.
          </p>
        </div>

        <div className="mt-16 grid gap-8 sm:grid-cols-2 lg:grid-cols-3">
          {testimonials.map((testimonial) => (
            <div
              key={testimonial.author}
              className="rounded-xl border border-border bg-card p-6"
            >
              <p className="text-sm text-foreground">{`"${testimonial.quote}"`}</p>
              <div className="mt-6 flex items-center gap-3">
                <div className="flex h-10 w-10 items-center justify-center rounded-full bg-secondary text-sm font-medium text-foreground">
                  {testimonial.author[0]}
                </div>
                <div>
                  <div className="text-sm font-medium text-foreground">{testimonial.author}</div>
                  <div className="text-xs text-muted-foreground">
                    {testimonial.role} at {testimonial.company}
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

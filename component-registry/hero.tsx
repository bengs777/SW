export type HeroSectionProps = {
  title: string
  subtitle?: string
  eyebrow?: string
  primaryAction?: string
  secondaryAction?: string
}

const defaultProps = {
  subtitle: "Build a focused, production-ready page with clear sections and resilient rendering.",
  eyebrow: "Swift AI",
  primaryAction: "Get started",
  secondaryAction: "Learn more",
}

export function HeroSection(props: HeroSectionProps) {
  const merged = { ...defaultProps, ...props }

  return (
    <section className="px-6 py-16">
      <div className="mx-auto max-w-5xl">
        <p className="text-sm font-semibold uppercase tracking-wide text-slate-500">{merged.eyebrow}</p>
        <h1 className="mt-4 max-w-3xl text-4xl font-bold text-slate-950 md:text-6xl">{merged.title}</h1>
        {merged.subtitle ? <p className="mt-5 max-w-2xl text-lg text-slate-600">{merged.subtitle}</p> : null}
        <div className="mt-8 flex flex-wrap gap-3">
          <span className="rounded-md bg-slate-950 px-4 py-2 text-sm font-semibold text-white">{merged.primaryAction}</span>
          <span className="rounded-md border border-slate-300 px-4 py-2 text-sm font-semibold text-slate-800">{merged.secondaryAction}</span>
        </div>
      </div>
    </section>
  )
}

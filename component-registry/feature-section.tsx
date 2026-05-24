export type FeatureSectionProps = {
  title: string
  features?: Array<{ title: string; body: string }>
}

const defaultProps = {
  features: [
    { title: "Structured", body: "Sections compose from typed data and stable component contracts." },
    { title: "Validated", body: "Required props and dependencies are checked before runtime render." },
    { title: "Responsive", body: "Layouts stay simple, readable, and predictable across viewports." },
  ],
}

export function FeatureSection(props: FeatureSectionProps) {
  const features = props.features || defaultProps.features

  return (
    <section id="features" className="px-6 py-14">
      <div className="mx-auto max-w-6xl">
        <h2 className="text-3xl font-bold text-slate-950">{props.title}</h2>
        <div className="mt-8 grid gap-4 md:grid-cols-3">
          {features.map((feature) => (
            <article key={feature.title} className="rounded-lg border border-slate-200 bg-white p-5">
              <h3 className="font-semibold text-slate-950">{feature.title}</h3>
              <p className="mt-2 text-sm text-slate-600">{feature.body}</p>
            </article>
          ))}
        </div>
      </div>
    </section>
  )
}

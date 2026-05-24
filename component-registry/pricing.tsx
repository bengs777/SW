export type PricingProps = {
  plan: string
  price: string
  features?: string[]
}

const defaultProps = {
  features: ["Core pages", "Runtime validation", "Responsive layout"],
}

export function Pricing(props: PricingProps) {
  const features = props.features || defaultProps.features

  return (
    <section id="pricing" className="px-6 py-14">
      <div className="mx-auto max-w-md rounded-lg border border-slate-200 bg-white p-6 shadow-sm">
        <p className="text-sm font-semibold uppercase tracking-wide text-slate-500">{props.plan}</p>
        <p className="mt-3 text-4xl font-bold text-slate-950">{props.price}</p>
        <ul className="mt-6 space-y-2 text-sm text-slate-600">
          {features.map((feature) => (
            <li key={feature}>{feature}</li>
          ))}
        </ul>
      </div>
    </section>
  )
}

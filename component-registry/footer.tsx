export type FooterProps = {
  brand: string
  tagline?: string
}

const defaultProps = {
  tagline: "Reliable software generated with clear contracts.",
}

export function Footer(props: FooterProps) {
  return (
    <footer className="border-t border-slate-200 px-6 py-8">
      <div className="mx-auto flex max-w-6xl flex-col gap-2 text-sm text-slate-600 md:flex-row md:items-center md:justify-between">
        <p className="font-semibold text-slate-900">{props.brand}</p>
        <p>{props.tagline || defaultProps.tagline}</p>
      </div>
    </footer>
  )
}

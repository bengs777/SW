export type NavbarProps = {
  brand: string
  links?: Array<{ label: string; href: string }>
}

const defaultProps = {
  links: [
    { label: "Overview", href: "#" },
    { label: "Features", href: "#features" },
    { label: "Pricing", href: "#pricing" },
  ],
}

export function Navbar(props: NavbarProps) {
  const links = props.links || defaultProps.links

  return (
    <header className="border-b border-slate-200 px-6 py-4">
      <nav className="mx-auto flex max-w-6xl items-center justify-between gap-4">
        <a href="#" className="font-semibold text-slate-950">{props.brand}</a>
        <div className="flex flex-wrap items-center gap-4 text-sm text-slate-600">
          {links.map((link) => (
            <a key={link.href} href={link.href} className="hover:text-slate-950">{link.label}</a>
          ))}
        </div>
      </nav>
    </header>
  )
}

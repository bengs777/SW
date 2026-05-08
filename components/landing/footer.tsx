import Link from "next/link"
import { Zap } from "lucide-react"

const navigation = {
  product: [
    { name: "Fitur", href: "#features" },
    { name: "Harga", href: "/pricing" },
    { name: "Template", href: "/dashboard/templates" },
    { name: "Dashboard", href: "/dashboard" },
  ],
  resources: [
    { name: "Dokumentasi", href: "/docs" },
    { name: "Referensi API", href: "/docs/api" },
    { name: "Masuk", href: "/login" },
    { name: "Buat Akun", href: "/signup" },
  ],
  company: [
    { name: "Keamanan", href: "/security" },
    { name: "Kontak", href: "mailto:hello@swift.app" },
    { name: "Status", href: "/docs#status" },
  ],
  legal: [
    { name: "Privasi", href: "/privacy" },
    { name: "Syarat", href: "/terms" },
    { name: "Keamanan", href: "/security" },
  ],
}

export function Footer() {
  return (
    <footer className="border-t border-border">
      <div className="mx-auto max-w-7xl px-4 py-14 sm:px-6 lg:py-20">
        <div className="grid grid-cols-2 gap-8 md:grid-cols-5">
          <div className="col-span-2">
            <Link href="/" className="flex items-center gap-2">
              <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-primary">
                <Zap className="h-5 w-5 text-primary-foreground" />
              </div>
              <span className="text-xl font-bold text-foreground">Swift</span>
            </Link>
            <p className="mt-4 max-w-xs text-sm leading-relaxed text-muted-foreground">
              Bangun aplikasi web dengan AI. Jelaskan apa yang Anda inginkan, saksikan menjadi kenyataan.
            </p>
          </div>
          <div>
            <h3 className="text-sm font-semibold text-foreground">Produk</h3>
            <ul className="mt-4 space-y-3">
              {navigation.product.map((item) => (
                <li key={item.name}>
                  <Link href={item.href} className="text-sm text-muted-foreground transition-colors hover:text-foreground">
                    {item.name}
                  </Link>
                </li>
              ))}
            </ul>
          </div>
          <div>
            <h3 className="text-sm font-semibold text-foreground">Sumber Daya</h3>
            <ul className="mt-4 space-y-3">
              {navigation.resources.map((item) => (
                <li key={item.name}>
                  <Link href={item.href} className="text-sm text-muted-foreground transition-colors hover:text-foreground">
                    {item.name}
                  </Link>
                </li>
              ))}
            </ul>
          </div>
          <div>
            <h3 className="text-sm font-semibold text-foreground">Perusahaan</h3>
            <ul className="mt-4 space-y-3">
              {navigation.company.map((item) => (
                <li key={item.name}>
                  <Link href={item.href} className="text-sm text-muted-foreground transition-colors hover:text-foreground">
                    {item.name}
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        </div>
        <div className="mt-16 flex flex-col items-center justify-between gap-4 border-t border-border pt-10 sm:flex-row">
          <p className="text-sm text-muted-foreground">
            &copy; {new Date().getFullYear()} Swift. Semua hak dilindungi.
          </p>
          <div className="flex gap-6">
            {navigation.legal.map((item) => (
              <Link key={item.name} href={item.href} className="text-sm text-muted-foreground transition-colors hover:text-foreground">
                {item.name}
              </Link>
            ))}
          </div>
        </div>
      </div>
    </footer>
  )
}

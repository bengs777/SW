import type { Template } from "@/lib/types"

const landingFiles = [
  {
    path: "components/landing/site-header.tsx",
    language: "tsx" as const,
    content: String.raw`import Link from "next/link"
import { Sparkles } from "lucide-react"
import { Button } from "@/components/ui/button"

export function SiteHeader() {
  return (
    <header className="sticky top-0 z-20 border-b border-border/60 bg-background/80 backdrop-blur-xl">
      <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-4">
        <Link href="/" className="flex items-center gap-2 font-semibold text-foreground">
          <span className="flex h-9 w-9 items-center justify-center rounded-2xl bg-foreground text-background">
            <Sparkles className="h-4 w-4" />
          </span>
          NovaFlow
        </Link>
        <div className="flex items-center gap-3">
          <Button variant="ghost" asChild>
            <Link href="#features">Features</Link>
          </Button>
          <Button asChild>
            <Link href="#pricing">Get started</Link>
          </Button>
        </div>
      </div>
    </header>
  )
}
`,
  },
  {
    path: "components/landing/site-footer.tsx",
    language: "tsx" as const,
    content: String.raw`import Link from "next/link"

export function SiteFooter() {
  return (
    <footer className="border-t border-border/60 bg-background/70">
      <div className="mx-auto flex max-w-6xl flex-col gap-4 px-6 py-8 text-sm text-muted-foreground sm:flex-row sm:items-center sm:justify-between">
        <p>Built for teams that want to launch quickly without starting from zero.</p>
        <div className="flex items-center gap-4">
          <Link href="#features" className="hover:text-foreground">Features</Link>
          <Link href="#pricing" className="hover:text-foreground">Pricing</Link>
          <Link href="#contact" className="hover:text-foreground">Contact</Link>
        </div>
      </div>
    </footer>
  )
}
`,
  },
  {
    path: "app/page.tsx",
    language: "tsx" as const,
    content: String.raw`import Link from "next/link"
import { ArrowRight, CheckCircle2, Sparkles } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { SiteFooter } from "@/components/landing/site-footer"
import { SiteHeader } from "@/components/landing/site-header"

const features = [
  {
    title: "Launch faster",
    description: "Ship a polished homepage with hero, proof, and a clean CTA in one pass.",
  },
  {
    title: "Look premium",
    description: "Use a clear visual system with strong spacing, contrast, and responsive sections.",
  },
  {
    title: "Convert better",
    description: "Keep the call to action visible, the copy concise, and the path to signup obvious.",
  },
]

const metrics = [
  { value: "2.4x", label: "more demo requests" },
  { value: "48h", label: "to first launch" },
  { value: "99%", label: "template ready" },
]

export default function Page() {
  return (
    <main className="min-h-screen bg-gradient-to-b from-background via-background to-muted/20">
      <SiteHeader />

      <section className="mx-auto grid max-w-6xl gap-12 px-6 py-16 lg:grid-cols-[1.1fr_0.9fr] lg:items-center lg:py-24">
        <div>
          <Badge variant="secondary" className="mb-6 gap-2 rounded-full px-3 py-1.5">
            <Sparkles className="h-3.5 w-3.5" />
            Landing starter
          </Badge>
          <h1 className="max-w-3xl text-5xl font-semibold tracking-tight text-foreground sm:text-6xl">
            Build a product page that sells before the first demo.
          </h1>
          <p className="mt-6 max-w-2xl text-lg leading-8 text-muted-foreground">
            Launch a polished landing page with hero, social proof, benefits, pricing, and a clear call to action.
          </p>
          <div className="mt-8 flex flex-wrap gap-3">
            <Button asChild size="lg">
              <Link href="#pricing">
                Start free
                <ArrowRight className="ml-2 h-4 w-4" />
              </Link>
            </Button>
            <Button asChild variant="outline" size="lg">
              <Link href="#features">See features</Link>
            </Button>
          </div>
          <div className="mt-10 grid gap-4 sm:grid-cols-3">
            {metrics.map((metric) => (
              <Card key={metric.label} className="border-border/60 bg-card/80">
                <CardContent className="p-4">
                  <div className="text-2xl font-semibold text-foreground">{metric.value}</div>
                  <p className="mt-1 text-sm text-muted-foreground">{metric.label}</p>
                </CardContent>
              </Card>
            ))}
          </div>
        </div>

        <Card className="border-border/60 bg-card/90 shadow-xl shadow-black/5">
          <CardContent className="space-y-6 p-6">
            <div className="rounded-2xl border border-border/60 bg-muted/40 p-5">
              <p className="text-sm uppercase tracking-[0.24em] text-muted-foreground">Product story</p>
              <h2 className="mt-3 text-2xl font-semibold text-foreground">A landing page with a strong visual rhythm.</h2>
              <p className="mt-3 text-sm leading-6 text-muted-foreground">
                Designed for founders, agencies, and small product teams that need a clean first impression.
              </p>
            </div>
            <div id="features" className="grid gap-3">
              {features.map((feature) => (
                <div key={feature.title} className="flex gap-3 rounded-2xl border border-border/60 bg-background/70 p-4">
                  <CheckCircle2 className="mt-0.5 h-5 w-5 text-emerald-500" />
                  <div>
                    <h3 className="font-medium text-foreground">{feature.title}</h3>
                    <p className="mt-1 text-sm leading-6 text-muted-foreground">{feature.description}</p>
                  </div>
                </div>
              ))}
            </div>
            <div id="pricing" className="rounded-2xl border border-border/60 bg-foreground p-5 text-background">
              <div className="text-sm uppercase tracking-[0.24em] text-background/70">Pricing</div>
              <div className="mt-2 text-3xl font-semibold">Simple, transparent, scalable.</div>
              <p className="mt-3 text-sm leading-6 text-background/80">
                Replace this section with your real pricing table once the offer is finalized.
              </p>
            </div>
          </CardContent>
        </Card>
      </section>

      <SiteFooter />
    </main>
  )
}
`,
  },
] as const

const authFiles = [
  {
    path: "components/auth/auth-shell.tsx",
    language: "tsx" as const,
    content: String.raw`import type { ReactNode } from "react"
import Link from "next/link"
import { ShieldCheck, Sparkles } from "lucide-react"
import { Badge } from "@/components/ui/badge"

type AuthShellProps = {
  title: string
  description: string
  children: ReactNode
}

export function AuthShell({ title, description, children }: AuthShellProps) {
  return (
    <main className="min-h-screen bg-gradient-to-b from-background via-background to-muted/20 px-6 py-10">
      <div className="mx-auto grid min-h-[calc(100vh-5rem)] max-w-6xl gap-10 lg:grid-cols-[0.95fr_1.05fr] lg:items-center">
        <section className="rounded-[2rem] border border-border/60 bg-card/90 p-8 shadow-xl shadow-black/5">
          <Badge variant="secondary" className="gap-2 rounded-full px-3 py-1.5">
            <Sparkles className="h-3.5 w-3.5" />
            Auth starter
          </Badge>
          <h1 className="mt-6 text-4xl font-semibold tracking-tight text-foreground sm:text-5xl">{title}</h1>
          <p className="mt-4 max-w-xl text-base leading-7 text-muted-foreground">{description}</p>
          <div className="mt-8 flex items-center gap-3 text-sm text-muted-foreground">
            <ShieldCheck className="h-4 w-4 text-emerald-500" />
            Session ready, mobile friendly, and simple to extend.
          </div>
          <div className="mt-8 flex flex-wrap gap-3 text-sm">
            <Link href="/login" className="rounded-full border border-border/70 px-4 py-2 text-foreground hover:bg-muted/60">Login</Link>
            <Link href="/signup" className="rounded-full border border-border/70 px-4 py-2 text-foreground hover:bg-muted/60">Signup</Link>
            <Link href="/forgot-password" className="rounded-full border border-border/70 px-4 py-2 text-foreground hover:bg-muted/60">Reset password</Link>
          </div>
        </section>

        <section className="rounded-[2rem] border border-border/60 bg-background/90 p-6 shadow-xl shadow-black/5">
          {children}
        </section>
      </div>
    </main>
  )
}
`,
  },
  {
    path: "app/login/page.tsx",
    language: "tsx" as const,
    content: String.raw`import Link from "next/link"
import { ArrowRight } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { AuthShell } from "@/components/auth/auth-shell"

export default function LoginPage() {
  return (
    <AuthShell
      title="Welcome back"
      description="Use this login screen as the single entry point for returning users. Connect your preferred auth provider later."
    >
      <div className="space-y-5">
        <div>
          <label className="text-sm font-medium text-foreground">Email</label>
          <Input className="mt-2" type="email" placeholder="you@example.com" />
        </div>
        <div>
          <label className="text-sm font-medium text-foreground">Password</label>
          <Input className="mt-2" type="password" placeholder="Enter your password" />
        </div>
        <Button className="w-full gap-2">
          Sign in
          <ArrowRight className="h-4 w-4" />
        </Button>
        <p className="text-center text-sm text-muted-foreground">
          New here? <Link href="/signup" className="text-foreground underline">Create an account</Link>
        </p>
      </div>
    </AuthShell>
  )
}
`,
  },
  {
    path: "app/signup/page.tsx",
    language: "tsx" as const,
    content: String.raw`import Link from "next/link"
import { ArrowRight } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { AuthShell } from "@/components/auth/auth-shell"

export default function SignupPage() {
  return (
    <AuthShell
      title="Create your account"
      description="Use this signup flow for new users. Keep the form short, focused, and easy to complete on mobile."
    >
      <div className="space-y-5">
        <div>
          <label className="text-sm font-medium text-foreground">Full name</label>
          <Input className="mt-2" placeholder="Ari Wibowo" />
        </div>
        <div>
          <label className="text-sm font-medium text-foreground">Email</label>
          <Input className="mt-2" type="email" placeholder="you@example.com" />
        </div>
        <div>
          <label className="text-sm font-medium text-foreground">Password</label>
          <Input className="mt-2" type="password" placeholder="Create a strong password" />
        </div>
        <Button className="w-full gap-2">
          Create account
          <ArrowRight className="h-4 w-4" />
        </Button>
        <p className="text-center text-sm text-muted-foreground">
          Already have an account? <Link href="/login" className="text-foreground underline">Sign in</Link>
        </p>
      </div>
    </AuthShell>
  )
}
`,
  },
  {
    path: "app/forgot-password/page.tsx",
    language: "tsx" as const,
    content: String.raw`import Link from "next/link"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { AuthShell } from "@/components/auth/auth-shell"

export default function ForgotPasswordPage() {
  return (
    <AuthShell
      title="Reset your password"
      description="Keep the fallback recovery flow simple so users can regain access without contacting support."
    >
      <div className="space-y-5">
        <div>
          <label className="text-sm font-medium text-foreground">Email</label>
          <Input className="mt-2" type="email" placeholder="you@example.com" />
        </div>
        <Button className="w-full">Send reset link</Button>
        <p className="text-center text-sm text-muted-foreground">
          Remember your password? <Link href="/login" className="text-foreground underline">Back to login</Link>
        </p>
      </div>
    </AuthShell>
  )
}
`,
  },
] as const

const dashboardFiles = [
  {
    path: "components/dashboard/metric-card.tsx",
    language: "tsx" as const,
    content: String.raw`import type { ReactNode } from "react"

type MetricCardProps = {
  title: string
  value: string
  delta: string
  icon: ReactNode
}

export function MetricCard({ title, value, delta, icon }: MetricCardProps) {
  return (
    <div className="rounded-3xl border border-border/70 bg-card p-5 shadow-sm">
      <div className="flex items-center justify-between gap-4">
        <div>
          <p className="text-sm text-muted-foreground">{title}</p>
          <div className="mt-2 text-3xl font-semibold text-foreground">{value}</div>
        </div>
        <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-muted text-foreground">{icon}</div>
      </div>
      <p className="mt-4 text-sm text-emerald-600 dark:text-emerald-400">{delta}</p>
    </div>
  )
}
`,
  },
  {
    path: "components/dashboard/activity-item.tsx",
    language: "tsx" as const,
    content: String.raw`type ActivityItemProps = {
  title: string
  meta: string
  status: string
}

export function ActivityItem({ title, meta, status }: ActivityItemProps) {
  return (
    <div className="flex items-center justify-between gap-4 rounded-2xl border border-border/60 bg-background/80 px-4 py-3">
      <div>
        <div className="font-medium text-foreground">{title}</div>
        <div className="text-sm text-muted-foreground">{meta}</div>
      </div>
      <div className="rounded-full border border-border/70 px-3 py-1 text-xs text-muted-foreground">{status}</div>
    </div>
  )
}
`,
  },
  {
    path: "app/dashboard/page.tsx",
    language: "tsx" as const,
    content: String.raw`import { ArrowUpRight, BarChart3, FolderOpen, Zap } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { ActivityItem } from "@/components/dashboard/activity-item"
import { MetricCard } from "@/components/dashboard/metric-card"

const activities = [
  { title: "Landing Page", meta: "Updated 12 minutes ago", status: "Ready" },
  { title: "Billing Dashboard", meta: "Awaiting review", status: "In progress" },
  { title: "Auth Flow", meta: "Last preview passed", status: "Stable" },
]

export default function DashboardPage() {
  return (
    <main className="space-y-6 pb-8">
      <section className="rounded-3xl border border-border/70 bg-card/90 p-6 shadow-sm">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
          <div className="max-w-3xl space-y-3">
            <Badge variant="secondary" className="gap-2 rounded-full px-3 py-1.5">
              <Zap className="h-3.5 w-3.5" />
              Admin dashboard starter
            </Badge>
            <h1 className="text-4xl font-semibold tracking-tight text-foreground sm:text-5xl">
              Manage projects, metrics, and preview state from one polished dashboard.
            </h1>
            <p className="max-w-2xl text-base leading-7 text-muted-foreground">
              Use this dashboard as a foundation for analytics, product operations, and lightweight team workflows.
            </p>
          </div>
          <div className="flex gap-3">
            <Button variant="outline" className="gap-2">
              <FolderOpen className="h-4 w-4" />
              Projects
            </Button>
            <Button className="gap-2">
              <ArrowUpRight className="h-4 w-4" />
              Open report
            </Button>
          </div>
        </div>
      </section>

      <section className="grid gap-4 md:grid-cols-3">
        <MetricCard title="Active projects" value="18" delta="+4 this week" icon={<FolderOpen className="h-5 w-5" />} />
        <MetricCard title="Preview health" value="96%" delta="2 issues resolved today" icon={<BarChart3 className="h-5 w-5" />} />
        <MetricCard title="Automation" value="24" delta="Templates ready to reuse" icon={<Zap className="h-5 w-5" />} />
      </section>

      <div className="grid gap-6 lg:grid-cols-[1.2fr,0.8fr]">
        <Card className="border-border/70 shadow-sm">
          <CardContent className="space-y-4 p-6">
            <div>
              <p className="text-sm uppercase tracking-[0.24em] text-muted-foreground">Recent activity</p>
              <h2 className="mt-2 text-2xl font-semibold text-foreground">Keep the team focused on the highest impact work.</h2>
            </div>
            <div className="space-y-3">
              {activities.map((activity) => (
                <ActivityItem key={activity.title} {...activity} />
              ))}
            </div>
          </CardContent>
        </Card>

        <Card className="border-border/70 shadow-sm">
          <CardContent className="space-y-4 p-6">
            <p className="text-sm uppercase tracking-[0.24em] text-muted-foreground">Quick actions</p>
            <div className="space-y-3">
              <Button className="w-full justify-start">Create project</Button>
              <Button variant="outline" className="w-full justify-start">Review preview errors</Button>
              <Button variant="outline" className="w-full justify-start">Open analytics</Button>
            </div>
          </CardContent>
        </Card>
      </div>
    </main>
  )
}
`,
  },
] as const

const storefrontFiles = [
  {
    path: "components/storefront/product-card.tsx",
    language: "tsx" as const,
    content: String.raw`import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"

type ProductCardProps = {
  name: string
  price: string
  label: string
}

export function ProductCard({ name, price, label }: ProductCardProps) {
  return (
    <div className="rounded-3xl border border-border/70 bg-card p-5 shadow-sm">
      <div className="aspect-[4/3] rounded-2xl bg-gradient-to-br from-muted via-background to-muted/40" />
      <div className="mt-4 flex items-center justify-between gap-3">
        <div>
          <h3 className="font-semibold text-foreground">{name}</h3>
          <p className="text-sm text-muted-foreground">Premium quality, simple checkout, fast delivery.</p>
        </div>
        <Badge variant="secondary">{label}</Badge>
      </div>
      <div className="mt-4 flex items-center justify-between gap-3">
        <div className="text-lg font-semibold text-foreground">{price}</div>
        <Button size="sm">Add to cart</Button>
      </div>
    </div>
  )
}
`,
  },
  {
    path: "components/storefront/cart-summary.tsx",
    language: "tsx" as const,
    content: String.raw`import { Button } from "@/components/ui/button"

export function CartSummary() {
  return (
    <aside className="rounded-3xl border border-border/70 bg-card p-5 shadow-sm">
      <h2 className="text-xl font-semibold text-foreground">Cart summary</h2>
      <div className="mt-4 space-y-3 text-sm text-muted-foreground">
        <div className="flex items-center justify-between"><span>Subtotal</span><span>Rp 1.250.000</span></div>
        <div className="flex items-center justify-between"><span>Shipping</span><span>Rp 25.000</span></div>
        <div className="flex items-center justify-between"><span>Discount</span><span>- Rp 100.000</span></div>
      </div>
      <div className="mt-4 flex items-center justify-between border-t border-border/70 pt-4 text-base font-semibold text-foreground">
        <span>Total</span>
        <span>Rp 1.175.000</span>
      </div>
      <Button className="mt-5 w-full">Checkout now</Button>
    </aside>
  )
}
`,
  },
  {
    path: "app/page.tsx",
    language: "tsx" as const,
    content: String.raw`import { ShoppingBag } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { ProductCard } from "@/components/storefront/product-card"
import { CartSummary } from "@/components/storefront/cart-summary"

const products = [
  { name: "Everyday Jacket", price: "Rp 650.000", label: "Best seller" },
  { name: "Canvas Tote", price: "Rp 180.000", label: "New" },
  { name: "Minimal Sneakers", price: "Rp 890.000", label: "Trending" },
]

export default function Page() {
  return (
    <main className="mx-auto max-w-6xl px-6 py-12">
      <section className="rounded-[2rem] border border-border/70 bg-card/90 p-6 shadow-sm">
        <Badge variant="secondary" className="gap-2 rounded-full px-3 py-1.5">
          <ShoppingBag className="h-3.5 w-3.5" />
          Ecommerce starter
        </Badge>
        <h1 className="mt-6 text-4xl font-semibold tracking-tight text-foreground sm:text-5xl">
          Build a store that feels premium from the first scroll.
        </h1>
        <p className="mt-4 max-w-2xl text-base leading-7 text-muted-foreground">
          This storefront starter includes a product grid, a cart summary, and a clean layout for conversion focused commerce.
        </p>
      </section>

      <div className="mt-8 grid gap-6 lg:grid-cols-[1.1fr_0.9fr]">
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {products.map((product) => (
            <ProductCard key={product.name} {...product} />
          ))}
        </div>
        <CartSummary />
      </div>
    </main>
  )
}
`,
  },
] as const

const workspaceFiles = [
  {
    path: "components/workspace/file-browser.tsx",
    language: "tsx" as const,
    content: String.raw`const files = [
  "app/page.tsx",
  "components/hero.tsx",
  "components/features.tsx",
  "styles/globals.css",
]

export function FileBrowser() {
  return (
    <aside className="rounded-3xl border border-border/70 bg-card p-4 shadow-sm">
      <p className="text-sm uppercase tracking-[0.24em] text-muted-foreground">Files</p>
      <div className="mt-4 space-y-2">
        {files.map((file) => (
          <div key={file} className="rounded-2xl border border-border/60 bg-background/80 px-4 py-3 text-sm text-foreground">
            {file}
          </div>
        ))}
      </div>
    </aside>
  )
}
`,
  },
  {
    path: "components/workspace/preview-frame.tsx",
    language: "tsx" as const,
    content: String.raw`export function PreviewFrame() {
  return (
    <section className="rounded-3xl border border-border/70 bg-card p-4 shadow-sm">
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm uppercase tracking-[0.24em] text-muted-foreground">Preview</p>
        <div className="rounded-full border border-border/70 px-3 py-1 text-xs text-muted-foreground">Live</div>
      </div>
      <div className="mt-4 min-h-[320px] rounded-2xl border border-dashed border-border/70 bg-muted/30 p-6">
        <div className="grid gap-4 md:grid-cols-[0.9fr_1.1fr] md:items-center">
          <div>
            <p className="text-sm text-muted-foreground">Editor output</p>
            <h2 className="mt-2 text-2xl font-semibold text-foreground">A split layout that feels like a real builder.</h2>
            <p className="mt-3 text-sm leading-6 text-muted-foreground">
              Use this workspace starter to organize files, inspect the preview, and keep your iteration loop short.
            </p>
          </div>
          <div className="rounded-2xl border border-border/70 bg-background p-4">
            <div className="rounded-xl bg-gradient-to-br from-muted via-background to-muted/40 p-6 text-sm text-muted-foreground">
              Preview content goes here.
            </div>
          </div>
        </div>
      </div>
    </section>
  )
}
`,
  },
  {
    path: "app/page.tsx",
    language: "tsx" as const,
    content: String.raw`import { Blocks, Command, PanelLeftOpen, Sparkles } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { FileBrowser } from "@/components/workspace/file-browser"
import { PreviewFrame } from "@/components/workspace/preview-frame"

export default function Page() {
  return (
    <main className="min-h-screen bg-gradient-to-b from-background via-background to-muted/20 px-6 py-8">
      <section className="mx-auto max-w-7xl space-y-6">
        <div className="rounded-[2rem] border border-border/70 bg-card/90 p-6 shadow-sm">
          <Badge variant="secondary" className="gap-2 rounded-full px-3 py-1.5">
            <Sparkles className="h-3.5 w-3.5" />
            Workspace builder starter
          </Badge>
          <div className="mt-4 flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
            <div className="max-w-3xl space-y-3">
              <h1 className="text-4xl font-semibold tracking-tight text-foreground sm:text-5xl">
                A developer workspace with file browser, live preview, and a focused command bar.
              </h1>
              <p className="max-w-2xl text-base leading-7 text-muted-foreground">
                Use this as the starter for a Lovable style builder or an internal tool editor.
              </p>
            </div>
            <div className="flex flex-wrap gap-3">
              <Button variant="outline" className="gap-2">
                <PanelLeftOpen className="h-4 w-4" />
                Files
              </Button>
              <Button className="gap-2">
                <Command className="h-4 w-4" />
                Run command
              </Button>
            </div>
          </div>
        </div>

        <div className="grid gap-6 xl:grid-cols-[0.35fr_0.65fr]">
          <FileBrowser />
          <div className="space-y-6">
            <PreviewFrame />
            <div className="grid gap-4 md:grid-cols-2">
              <div className="rounded-3xl border border-border/70 bg-card p-5 shadow-sm">
                <div className="flex items-center gap-2 text-sm uppercase tracking-[0.24em] text-muted-foreground">
                  <Blocks className="h-4 w-4" />
                  Builder mode
                </div>
                <p className="mt-3 text-sm leading-6 text-muted-foreground">
                  This layout is ready for patch-first editing and preview driven iteration.
                </p>
              </div>
              <div className="rounded-3xl border border-border/70 bg-card p-5 shadow-sm">
                <div className="text-sm uppercase tracking-[0.24em] text-muted-foreground">Loop</div>
                <p className="mt-3 text-sm leading-6 text-muted-foreground">
                  Edit files, inspect preview, fix errors, and keep shipping without rebuilding the whole app.
                </p>
              </div>
            </div>
          </div>
        </div>
      </section>
    </main>
  )
}
`,
  },
] as const

export const TEMPLATE_CATALOG: Template[] = [
  {
    id: "landing-page",
    name: "Landing Page",
    description: "A polished SaaS landing page with hero, proof, features, pricing, and CTA sections.",
    category: "marketing",
    prompt: "Create a modern SaaS landing page with a hero section, social proof, features, pricing, FAQ, and a strong call to action.",
    files: [...landingFiles],
    featured: true,
    tags: ["No prompt", "Marketing", "Responsive"],
    stack: ["Next.js", "Tailwind CSS", "shadcn/ui"],
    difficulty: "beginner",
    estimatedMinutes: 12,
    previewNotes: "Best for SaaS, agency, or product launch pages.",
  },
  {
    id: "auth-suite",
    name: "Authentication Suite",
    description: "A login, signup, and password reset starter with clean forms and reusable shell layout.",
    category: "application",
    prompt: "Create login, signup, and password reset pages with a clean auth shell, strong form hierarchy, and mobile friendly layout.",
    files: [...authFiles],
    featured: true,
    tags: ["Auth", "Forms", "Mobile ready"],
    stack: ["Next.js", "React", "shadcn/ui"],
    difficulty: "beginner",
    estimatedMinutes: 10,
    previewNotes: "Great for onboarding flows and user account access.",
  },
  {
    id: "admin-dashboard",
    name: "Admin Dashboard",
    description: "A dashboard starter with metrics, recent activity, and quick actions.",
    category: "application",
    prompt: "Create an admin dashboard with overview cards, recent activity, and quick action sections.",
    files: [...dashboardFiles],
    featured: true,
    tags: ["Dashboard", "Analytics", "Operations"],
    stack: ["Next.js", "Tailwind CSS", "Lucide React"],
    difficulty: "intermediate",
    estimatedMinutes: 14,
    previewNotes: "Works well for internal tools and management panels.",
  },
  {
    id: "storefront",
    name: "Storefront",
    description: "An ecommerce product grid with a cart summary and a clear checkout path.",
    category: "ecommerce",
    prompt: "Create a storefront with featured products, a cart summary, and a conversion friendly checkout flow.",
    files: [...storefrontFiles],
    featured: false,
    tags: ["Commerce", "Products", "Checkout"],
    stack: ["Next.js", "Tailwind CSS", "shadcn/ui"],
    difficulty: "intermediate",
    estimatedMinutes: 15,
    previewNotes: "Good for product catalogs and simple online stores.",
  },
  {
    id: "workspace-builder",
    name: "Workspace Builder",
    description: "A split-pane developer workspace starter with file browser and live preview.",
    category: "workspace",
    prompt: "Create a Lovable style workspace builder with a file browser, live preview, command bar, and patch-first iteration loop.",
    files: [...workspaceFiles],
    featured: true,
    tags: ["Builder", "Preview", "Patch first"],
    stack: ["Next.js", "React", "Tailwind CSS"],
    difficulty: "advanced",
    estimatedMinutes: 18,
    previewNotes: "Best for the core product itself or code-centric internal tools.",
  },
]

export function listTemplates(category?: string) {
  const normalizedCategory = category?.trim().toLowerCase()

  if (!normalizedCategory || normalizedCategory === "all") {
    return TEMPLATE_CATALOG
  }

  return TEMPLATE_CATALOG.filter((template) => template.category.toLowerCase() === normalizedCategory)
}

export function getTemplateById(templateId: string) {
  return TEMPLATE_CATALOG.find((template) => template.id === templateId) ?? null
}
import { CTA } from "@/components/landing/cta"
import { Demo } from "@/components/landing/demo"
import { Features } from "@/components/landing/features"
import { Footer } from "@/components/landing/footer"
import { Header } from "@/components/landing/header"
import { Hero } from "@/components/landing/hero"

export default function HomePage() {
  return (
    <main className="min-h-screen bg-background text-foreground">
      <Header />
      <Hero />
      <Features />
      <Demo />
      <CTA />
      <Footer />
    </main>
  )
}

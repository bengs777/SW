"use client"

import Link from "next/link"
import { Button } from "@/components/ui/button"
import { ThemeToggle } from "@/components/ui/theme-toggle"
import { Zap } from "lucide-react"

export function Header() {
  return (
    <header className="fixed top-0 left-0 right-0 z-50 border-b border-border bg-background/70 backdrop-blur-lg">
      <div className="mx-auto flex h-16 max-w-7xl items-center justify-between px-4 sm:px-6 lg:px-8">
        <div className="flex items-center gap-10">
          <Link href="/" className="flex items-center gap-2.5 group">
            <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-primary group-hover:bg-primary/90 transition-colors">
              <Zap className="h-5 w-5 text-primary-foreground" />
            </div>
            <span className="text-xl font-bold tracking-tight text-foreground">Swift</span>
          </Link>
          <nav className="hidden items-center gap-8 lg:flex">
            <Link href="#features" className="text-sm font-medium text-muted-foreground transition-colors hover:text-foreground">
              Fitur
            </Link>
            <Link href="#demo" className="text-sm font-medium text-muted-foreground transition-colors hover:text-foreground">
              Demo
            </Link>
            <Link href="/pricing" className="text-sm font-medium text-muted-foreground transition-colors hover:text-foreground">
              Harga
            </Link>
            <Link href="/docs" className="text-sm font-medium text-muted-foreground transition-colors hover:text-foreground">
              Dokumentasi
            </Link>
          </nav>
        </div>
        <div className="flex items-center gap-3">
          <ThemeToggle />
          <Link href="/login">
            <Button variant="ghost" size="sm" className="text-sm font-medium">
              Masuk
            </Button>
          </Link>
          <Link href="/signup">
            <Button size="sm" className="text-sm font-medium">Mulai Sekarang</Button>
          </Link>
        </div>
      </div>
    </header>
  )
}

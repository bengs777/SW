"use client"

import Link from "next/link"
import { usePathname } from "next/navigation"
import { signOut, useSession } from "next-auth/react"
import {
  BookOpen,
  FolderOpen,
  LayoutDashboard,
  LogOut,
  MonitorCog,
  Settings,
  Sparkles,
  Zap,
} from "lucide-react"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { ThemeToggle } from "@/components/ui/theme-toggle"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { WorkspaceSwitcher } from "@/components/workspace-switcher"

const navigation = [
  { name: "Dashboard", href: "/dashboard", icon: LayoutDashboard },
  { name: "Projects", href: "/dashboard/projects", icon: FolderOpen },
  { name: "Templates", href: "/dashboard/templates", icon: BookOpen },
  { name: "Admin", href: "/dashboard/admin", icon: MonitorCog },
  { name: "Settings", href: "/dashboard/settings", icon: Settings },
]

export function DashboardSidebar() {
  const pathname = usePathname()
  const { data: session } = useSession()
  const displayName = session?.user?.name || session?.user?.email?.split("@")[0] || "User"

  const avatarInitial = displayName.charAt(0).toUpperCase() || "U"

  const handleSignOut = async () => {
    await signOut({ redirectTo: "/" })
  }

  return (
    <aside className="flex w-full flex-col border-b border-sidebar-border bg-sidebar/90 backdrop-blur-xl lg:sticky lg:top-0 lg:h-screen lg:w-80 lg:border-b-0 lg:border-r">
      <div className="flex items-center justify-between gap-3 px-4 py-4 lg:border-b lg:border-sidebar-border">
        <Link href="/" className="flex items-center gap-2">
          <div className="flex h-10 w-10 items-center justify-center rounded-2xl bg-sidebar-primary text-sidebar-primary-foreground shadow-sm shadow-black/10">
            <Zap className="h-5 w-5" />
          </div>
          <div>
            <div className="text-sm font-semibold text-sidebar-foreground">Swift</div>
            <div className="flex items-center gap-1 text-xs text-sidebar-foreground/60">
              <Sparkles className="h-3 w-3" />
              Studio dashboard
            </div>
          </div>
        </Link>
        <div className="flex items-center">
          <ThemeToggle />
        </div>
      </div>

      <div className="border-b border-sidebar-border px-4 pb-4">
        <div className="mb-2 flex items-center justify-between">
          <span className="text-[11px] font-medium uppercase tracking-[0.24em] text-sidebar-foreground/50">
            Workspace
          </span>
          <span className="text-xs text-sidebar-foreground/50">Live</span>
        </div>
        <WorkspaceSwitcher />
      </div>

      <nav className="flex gap-2 overflow-x-auto px-3 py-3 lg:flex-1 lg:flex-col lg:overflow-visible lg:px-3 lg:py-4">
        {navigation.map((item) => {
          const isActive = pathname === item.href || pathname.startsWith(item.href + "/")
          return (
            <Link
              key={item.name}
              href={item.href}
              className={cn(
                "flex min-w-max items-center gap-3 rounded-2xl border px-3 py-3 text-sm font-medium transition-all lg:min-w-0",
                isActive
                  ? "border-sidebar-accent/40 bg-sidebar-accent text-sidebar-accent-foreground shadow-sm"
                  : "border-transparent text-sidebar-foreground/70 hover:border-sidebar-accent/30 hover:bg-sidebar-accent/40 hover:text-sidebar-foreground"
              )}
            >
              <item.icon className="h-4 w-4 shrink-0" />
              {item.name}
            </Link>
          )
        })}
      </nav>

      <div className="border-t border-sidebar-border p-3">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              className="w-full justify-start gap-3 rounded-2xl border border-sidebar-border/80 px-3 py-3 text-left hover:bg-sidebar-accent/40"
            >
              <div className="flex h-9 w-9 items-center justify-center rounded-full bg-sidebar-accent text-sm font-medium text-sidebar-accent-foreground">
                {avatarInitial}
              </div>
              <div className="flex-1 text-left">
                <div className="text-sm font-medium text-sidebar-foreground">
                  {displayName}
                </div>
                <div className="text-xs text-sidebar-foreground/70">
                  {session?.user?.email || "user@example.com"}
                </div>
              </div>
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-56 rounded-2xl">
            <DropdownMenuItem asChild className="rounded-xl">
              <Link href="/dashboard/settings">
                <Settings className="mr-2 h-4 w-4" />
                Settings
              </Link>
            </DropdownMenuItem>
            <DropdownMenuItem asChild className="rounded-xl">
              <Link href="/docs">
                <BookOpen className="mr-2 h-4 w-4" />
                Help & Docs
              </Link>
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              className="rounded-xl"
              onClick={handleSignOut}
            >
              <LogOut className="mr-2 h-4 w-4" />
              Sign out
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </aside>
  )
}

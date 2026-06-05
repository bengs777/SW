"use client"

import { useState, useMemo } from "react"
import { useRouter } from "next/navigation"
import { Search, ArrowRight, Palette, BarChart3, ShoppingCart, ShieldCheck, Grid3x3, Loader2 } from "lucide-react"
import { Input } from "@/components/ui/input"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { useWorkspaces } from "@/hooks/use-workspaces"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"

interface Template {
  id: string
  name: string
  description: string
  category: string
  preview?: string
  complexity: "beginner" | "intermediate" | "advanced"
  icon: React.ComponentType<{ className?: string }>
}

const TEMPLATES: Template[] = [
  {
    id: "admin-dashboard",
    name: "Dashboard Operasional",
    description: "Dashboard admin dengan KPI, aktivitas terbaru, dan aksi cepat untuk tim operasional.",
    category: "Dashboard",
    complexity: "intermediate",
    icon: BarChart3,
  },
  {
    id: "landing-page",
    name: "Landing UMKM",
    description: "Landing page siap pakai dengan hero, benefit, pricing, testimonial, dan CTA.",
    category: "Marketing",
    complexity: "beginner",
    icon: Palette,
  },
  {
    id: "storefront",
    name: "Toko Online",
    description: "Storefront dengan katalog produk, ringkasan cart, dan alur checkout yang jelas.",
    category: "E-Commerce",
    complexity: "advanced",
    icon: ShoppingCart,
  },
  {
    id: "auth-suite",
    name: "Auth & Akun",
    description: "Halaman login, signup, dan reset password dengan shell auth yang rapi.",
    category: "Auth",
    complexity: "intermediate",
    icon: ShieldCheck,
  },
  {
    id: "workspace-builder",
    name: "Workspace Builder",
    description: "Starter workspace split-pane dengan file browser, preview, dan command bar.",
    category: "Builder",
    complexity: "advanced",
    icon: Grid3x3,
  },
]

const CATEGORIES = ["All", ...new Set(TEMPLATES.map((t) => t.category))]

export default function TemplatesPage() {
  const router = useRouter()
  const { workspaces, isLoading: isLoadingWorkspaces } = useWorkspaces()
  const [searchQuery, setSearchQuery] = useState("")
  const [selectedCategory, setSelectedCategory] = useState("All")
  const [creatingTemplateId, setCreatingTemplateId] = useState<string | null>(null)
  const [error, setError] = useState("")

  const filteredTemplates = useMemo(() => {
    return TEMPLATES.filter((template) => {
      const matchesSearch =
        template.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
        template.description.toLowerCase().includes(searchQuery.toLowerCase())

      const matchesCategory = selectedCategory === "All" || template.category === selectedCategory

      return matchesSearch && matchesCategory
    })
  }, [searchQuery, selectedCategory])

  const getComplexityColor = (complexity: string) => {
    switch (complexity) {
      case "beginner":
        return "bg-green-500/10 text-green-700 dark:text-green-400"
      case "intermediate":
        return "bg-yellow-500/10 text-yellow-700 dark:text-yellow-400"
      case "advanced":
        return "bg-red-500/10 text-red-700 dark:text-red-400"
      default:
        return "bg-gray-500/10 text-gray-700 dark:text-gray-400"
    }
  }

  const handleUseTemplate = async (template: Template) => {
    if (creatingTemplateId || isLoadingWorkspaces) return

    setCreatingTemplateId(template.id)
    setError("")

    try {
      const response = await fetch(`/api/templates/${encodeURIComponent(template.id)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          workspaceId: workspaces[0]?.id,
          projectName: template.name,
          description: template.description,
        }),
      })
      const data = await response.json().catch(() => ({}))

      if (!response.ok || !data.project?.id) {
        throw new Error(data.error || "Template gagal dibuat menjadi project.")
      }

      router.push(`/dashboard/project/${data.project.id}`)
      router.refresh()
    } catch (templateError) {
      setError(templateError instanceof Error ? templateError.message : "Template gagal dibuat menjadi project.")
    } finally {
      setCreatingTemplateId(null)
    }
  }

  return (
    <div className="flex min-h-screen flex-col gap-6">
      {/* Header */}
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Templates</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Start with production-ready templates and customize them for your needs.
        </p>
      </div>

      {/* Search and Filter */}
      {error && (
        <Alert variant="destructive" className="rounded-2xl border-destructive/30 bg-destructive/5">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:gap-3">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder="Search templates..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="pl-10"
          />
        </div>
        {CATEGORIES.length > 1 && (
          <Select value={selectedCategory} onValueChange={setSelectedCategory}>
            <SelectTrigger className="w-full sm:w-48">
              <SelectValue placeholder="Select category" />
            </SelectTrigger>
            <SelectContent>
              {CATEGORIES.map((category) => (
                <SelectItem key={category} value={category}>
                  {category}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
      </div>

      {/* Templates Grid */}
      {filteredTemplates.length === 0 ? (
        <div className="flex flex-col items-center justify-center rounded-3xl border border-dashed border-border/70 bg-muted/20 px-6 py-16 text-center">
          <div className="mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-background text-muted-foreground shadow-sm">
            <Grid3x3 className="h-7 w-7" />
          </div>
          <h3 className="text-lg font-semibold text-foreground">No templates found</h3>
          <p className="mt-2 max-w-md text-sm leading-6 text-muted-foreground">
            Try a different search term or select another category to see more templates.
          </p>
        </div>
      ) : (
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {filteredTemplates.map((template) => {
            const Icon = template.icon
            return (
              <Card
                key={template.id}
                className="group relative overflow-hidden border-border/70 transition-all duration-300 hover:-translate-y-1 hover:border-border hover:shadow-lg"
              >
                <div className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-primary/50 to-transparent" />
                <CardHeader>
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex h-10 w-10 items-center justify-center rounded-2xl bg-primary/10 text-primary">
                      <Icon className="h-5 w-5" />
                    </div>
                    <Badge className={`rounded-full px-2.5 py-1 text-xs ${getComplexityColor(template.complexity)}`}>
                      {template.complexity}
                    </Badge>
                  </div>
                  <CardTitle className="mt-3">{template.name}</CardTitle>
                  <CardDescription className="line-clamp-2">{template.description}</CardDescription>
                </CardHeader>
                <CardContent>
                  <div className="flex items-center justify-between">
                    <Badge variant="secondary" className="rounded-full px-2.5 py-1 text-xs">
                      {template.category}
                    </Badge>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="gap-2 rounded-full"
                      disabled={creatingTemplateId !== null || isLoadingWorkspaces}
                      onClick={() => void handleUseTemplate(template)}
                    >
                      {creatingTemplateId === template.id ? (
                        <>
                          <Loader2 className="h-3 w-3 animate-spin" />
                          Membuat...
                        </>
                      ) : (
                        <>
                          Pakai Template
                        <ArrowRight className="h-3 w-3" />
                        </>
                      )}
                    </Button>
                  </div>
                </CardContent>
              </Card>
            )
          })}
        </div>
      )}
    </div>
  )
}

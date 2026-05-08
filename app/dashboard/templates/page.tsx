"use client"

import { useEffect, useMemo, useState } from "react"
import { useRouter } from "next/navigation"
import { ArrowRight, CheckCircle2, Clock3, FileText, Layout, Loader2, Monitor, Search, Settings, ShoppingBag, Sparkles } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Textarea } from "@/components/ui/textarea"
import { cn } from "@/lib/utils"
import type { Template } from "@/lib/types"

type WorkspaceOption = {
  id: string
  name: string
  slug: string
}

const NEW_WORKSPACE_VALUE = "__new__"

const categories = [
  { id: "all", name: "All Templates", icon: Layout },
  { id: "featured", name: "Featured", icon: Sparkles },
  { id: "marketing", name: "Marketing", icon: Layout },
  { id: "application", name: "Application", icon: Settings },
  { id: "content", name: "Content", icon: FileText },
  { id: "ecommerce", name: "E-commerce", icon: ShoppingBag },
  { id: "workspace", name: "Workspace", icon: Monitor },
]

const categoryLabelMap = Object.fromEntries(categories.map((category) => [category.id, category.name]))

export default function TemplatesPage() {
  const router = useRouter()
  const [searchQuery, setSearchQuery] = useState("")
  const [activeCategory, setActiveCategory] = useState("all")
  const [templates, setTemplates] = useState<Template[]>([])
  const [workspaces, setWorkspaces] = useState<WorkspaceOption[]>([])
  const [selectedTemplateId, setSelectedTemplateId] = useState("")
  const [projectName, setProjectName] = useState("")
  const [projectDescription, setProjectDescription] = useState("")
  const [workspaceId, setWorkspaceId] = useState(NEW_WORKSPACE_VALUE)
  const [isLoading, setIsLoading] = useState(true)
  const [isCreating, setIsCreating] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let isMounted = true

    const loadTemplates = async () => {
      try {
        const [templatesResponse, workspacesResponse] = await Promise.all([
          fetch("/api/templates"),
          fetch("/api/workspaces"),
        ])

        const templatesPayload = await templatesResponse.json().catch(() => ({}))

        if (!templatesResponse.ok || !Array.isArray(templatesPayload.templates)) {
          throw new Error(templatesPayload.error || "Failed to load templates")
        }

        const workspacePayload = workspacesResponse.ok ? await workspacesResponse.json().catch(() => []) : []
        const workspaceOptions: WorkspaceOption[] = Array.isArray(workspacePayload)
          ? workspacePayload
              .map((membership: { workspace?: { id?: string; name?: string; slug?: string } }) => ({
                id: membership.workspace?.id || "",
                name: membership.workspace?.name || "Workspace",
                slug: membership.workspace?.slug || "",
              }))
              .filter((workspace) => workspace.id)
          : []

        if (!isMounted) return

        setTemplates(templatesPayload.templates)
        setWorkspaces(workspaceOptions)

        const defaultTemplate =
          templatesPayload.templates.find((template: Template) => template.featured) ||
          templatesPayload.templates[0] ||
          null

        if (defaultTemplate) {
          setSelectedTemplateId(defaultTemplate.id)
          setProjectName(defaultTemplate.name)
          setProjectDescription(defaultTemplate.previewNotes || defaultTemplate.description)
        }

        if (workspaceOptions.length > 0) {
          setWorkspaceId(workspaceOptions[0].id)
        } else {
          setWorkspaceId(NEW_WORKSPACE_VALUE)
        }
      } catch (loadError) {
        if (!isMounted) return
        const message = loadError instanceof Error ? loadError.message : "Failed to load templates"
        setError(message)
      } finally {
        if (isMounted) {
          setIsLoading(false)
        }
      }
    }

    void loadTemplates()

    return () => {
      isMounted = false
    }
  }, [])

  const filteredTemplates = useMemo(() => {
    return templates.filter((template) => {
      const search = searchQuery.trim().toLowerCase()
      const matchesSearch =
        !search ||
        template.name.toLowerCase().includes(search) ||
        template.description.toLowerCase().includes(search) ||
        template.tags?.some((tag) => tag.toLowerCase().includes(search)) ||
        template.stack?.some((stackItem) => stackItem.toLowerCase().includes(search))

      const matchesCategory =
        activeCategory === "all"
          ? true
          : activeCategory === "featured"
            ? Boolean(template.featured)
            : template.category === activeCategory

      return matchesSearch && matchesCategory
    })
  }, [activeCategory, searchQuery, templates])

  const selectedTemplate = useMemo(() => {
    if (selectedTemplateId) {
      return templates.find((template) => template.id === selectedTemplateId) || null
    }

    return filteredTemplates[0] || templates[0] || null
  }, [filteredTemplates, selectedTemplateId, templates])

  useEffect(() => {
    if (!selectedTemplate) {
      return
    }

    if (!selectedTemplateId) {
      setSelectedTemplateId(selectedTemplate.id)
      setProjectName(selectedTemplate.name)
      setProjectDescription(selectedTemplate.previewNotes || selectedTemplate.description)
    }
  }, [selectedTemplate, selectedTemplateId])

  useEffect(() => {
    if (!selectedTemplate) {
      return
    }

    setProjectName(selectedTemplate.name)
    setProjectDescription(selectedTemplate.previewNotes || selectedTemplate.description)
  }, [selectedTemplate])

  useEffect(() => {
    if (workspaceId !== NEW_WORKSPACE_VALUE && !workspaces.some((workspace) => workspace.id === workspaceId)) {
      setWorkspaceId(workspaces[0]?.id || NEW_WORKSPACE_VALUE)
    }
  }, [workspaceId, workspaces])

  const handleSelectTemplate = (template: Template) => {
    setSelectedTemplateId(template.id)
    setProjectName(template.name)
    setProjectDescription(template.previewNotes || template.description)
    setError(null)
  }

  const handleCreateFromTemplate = async () => {
    if (!selectedTemplate || isCreating) {
      return
    }

    setIsCreating(true)
    setError(null)

    try {
      const response = await fetch(`/api/templates/${selectedTemplate.id}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          projectName: projectName.trim() || selectedTemplate.name,
          description: projectDescription.trim() || undefined,
          workspaceId: workspaceId === NEW_WORKSPACE_VALUE ? undefined : workspaceId,
        }),
      })

      const payload = await response.json().catch(() => ({}))

      if (!response.ok) {
        throw new Error(payload.error || "Failed to create project from template")
      }

      const projectId = payload.project?.id
      if (!projectId) {
        throw new Error("Template was applied, but the project id was not returned")
      }

      router.push(`/dashboard/project/${projectId}`)
      router.refresh()
    } catch (createError) {
      const message = createError instanceof Error ? createError.message : "Failed to create project from template"
      setError(message)
    } finally {
      setIsCreating(false)
    }
  }

  const visibleCount = filteredTemplates.length
  const totalCount = templates.length

  return (
    <div className="space-y-6 pb-6">
      <section className="overflow-hidden rounded-3xl border border-border/70 bg-card/90 p-6 shadow-sm sm:p-8">
        <div className="flex flex-col gap-6 lg:flex-row lg:items-end lg:justify-between">
          <div className="max-w-3xl space-y-4">
            <Badge variant="secondary" className="w-fit gap-2 rounded-full border border-border/70 bg-background/70 px-3 py-1.5 text-xs font-medium tracking-wide text-foreground">
              <Sparkles className="h-3.5 w-3.5" />
              Templates for every authenticated user
            </Badge>
            <div className="space-y-3">
              <h1 className="max-w-2xl text-3xl font-semibold tracking-tight text-foreground sm:text-4xl">
                Pick a starter, launch a project, and skip the empty canvas.
              </h1>
              <p className="max-w-3xl text-sm leading-6 text-muted-foreground sm:text-base">
                Browse production-ready templates, choose a workspace, and generate a ready-to-edit project without writing a new prompt.
              </p>
            </div>
            <div className="flex flex-wrap gap-2 text-xs text-muted-foreground">
              <span className="inline-flex items-center gap-2 rounded-full border border-border/70 bg-background/70 px-3 py-2">
                <Clock3 className="h-3.5 w-3.5" />
                {totalCount} starter kits
              </span>
              <span className="inline-flex items-center gap-2 rounded-full border border-border/70 bg-background/70 px-3 py-2">
                <CheckCircle2 className="h-3.5 w-3.5" />
                No prompt required on first use
              </span>
            </div>
          </div>
        </div>
      </section>

      <section className="grid gap-6 xl:grid-cols-[1.15fr,0.85fr]">
        <div className="space-y-4">
          <Card className="border-border/70 shadow-sm">
            <CardContent className="space-y-4 p-5">
              <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
                <div className="relative max-w-md flex-1">
                  <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                  <Input
                    placeholder="Search templates, tags, or stack..."
                    value={searchQuery}
                    onChange={(event) => setSearchQuery(event.target.value)}
                    className="pl-9"
                  />
                </div>
                <div className="flex flex-wrap gap-2">
                  {categories.map((category) => (
                    <Button
                      key={category.id}
                      variant={activeCategory === category.id ? "secondary" : "ghost"}
                      size="sm"
                      onClick={() => setActiveCategory(category.id)}
                      className="gap-2"
                    >
                      <category.icon className="h-4 w-4" />
                      {category.name}
                    </Button>
                  ))}
                </div>
              </div>
              <div className="flex items-center justify-between text-sm text-muted-foreground">
                <span>
                  Showing {visibleCount} of {totalCount} templates
                  {activeCategory !== "all" && categoryLabelMap[activeCategory] ? ` in ${categoryLabelMap[activeCategory]}` : ""}
                </span>
                {selectedTemplate && (
                  <span className="rounded-full border border-border/70 px-3 py-1 text-xs">
                    Selected: {selectedTemplate.name}
                  </span>
                )}
              </div>
            </CardContent>
          </Card>

          {isLoading ? (
            <Card className="border-border/70 shadow-sm">
              <CardContent className="grid gap-4 p-6 sm:grid-cols-2 lg:grid-cols-3">
                {Array.from({ length: 6 }).map((_, index) => (
                  <div key={index} className="h-80 animate-pulse rounded-3xl border border-border/60 bg-muted/40" />
                ))}
              </CardContent>
            </Card>
          ) : error && templates.length === 0 ? (
            <Card className="border-border/70 shadow-sm">
              <CardContent className="flex flex-col items-center justify-center gap-3 py-16 text-center">
                <Layout className="h-12 w-12 text-muted-foreground" />
                <h3 className="text-lg font-semibold text-foreground">Templates could not be loaded</h3>
                <p className="max-w-md text-sm text-muted-foreground">{error}</p>
              </CardContent>
            </Card>
          ) : filteredTemplates.length === 0 ? (
            <Card className="border-border/70 shadow-sm">
              <CardContent className="flex flex-col items-center justify-center gap-3 py-16 text-center">
                <Layout className="h-12 w-12 text-muted-foreground" />
                <h3 className="text-lg font-semibold text-foreground">No templates matched your filters</h3>
                <p className="max-w-md text-sm text-muted-foreground">
                  Try another keyword or switch to a different category to find a starter you can use immediately.
                </p>
                <Button variant="outline" onClick={() => {
                  setSearchQuery("")
                  setActiveCategory("all")
                }}>
                  Reset filters
                </Button>
              </CardContent>
            </Card>
          ) : (
            <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
              {filteredTemplates.map((template) => {
                const isSelected = selectedTemplate?.id === template.id

                return (
                  <button
                    key={template.id}
                    type="button"
                    onClick={() => handleSelectTemplate(template)}
                    className={cn(
                      "group overflow-hidden rounded-3xl border bg-card text-left shadow-sm transition-all hover:-translate-y-0.5 hover:border-foreground/20 hover:shadow-md",
                      isSelected ? "border-foreground/20 ring-1 ring-foreground/10" : "border-border/70"
                    )}
                  >
                    <div className="aspect-[4/3] bg-gradient-to-br from-muted via-background to-muted/60 p-5">
                      <div className="flex h-full flex-col justify-between rounded-[1.5rem] border border-border/60 bg-background/80 p-4">
                        <div className="flex items-start justify-between gap-3">
                          <div>
                            <div className="text-xs uppercase tracking-[0.24em] text-muted-foreground">
                              {template.category}
                            </div>
                            <h3 className="mt-2 text-xl font-semibold text-foreground">{template.name}</h3>
                          </div>
                          {template.featured && (
                            <Badge variant="secondary" className="shrink-0 rounded-full px-2.5 py-1 text-[11px]">
                              Featured
                            </Badge>
                          )}
                        </div>

                        <div className="grid gap-2 text-sm text-muted-foreground">
                          {template.stack?.slice(0, 3).map((stackItem) => (
                            <span key={stackItem} className="inline-flex w-fit rounded-full border border-border/70 px-2.5 py-1 text-[11px] text-foreground/80">
                              {stackItem}
                            </span>
                          ))}
                        </div>
                      </div>
                    </div>

                    <div className="space-y-4 p-5">
                      <p className="line-clamp-3 text-sm leading-6 text-muted-foreground">{template.description}</p>

                      <div className="flex flex-wrap gap-2">
                        {template.tags?.slice(0, 3).map((tag) => (
                          <Badge key={tag} variant="outline" className="rounded-full px-2.5 py-1 text-[11px] font-normal">
                            {tag}
                          </Badge>
                        ))}
                      </div>

                      <div className="flex items-center justify-between text-xs text-muted-foreground">
                        <span>{template.files.length} starter files</span>
                        <span>{template.estimatedMinutes || 10} min setup</span>
                      </div>

                      <div className="flex items-center justify-between rounded-2xl border border-border/70 bg-muted/20 px-4 py-3 text-sm text-foreground">
                        <span>{template.previewNotes || "Ready to launch"}</span>
                        <ArrowRight className="h-4 w-4" />
                      </div>
                    </div>
                  </button>
                )
              })}
            </div>
          )}
        </div>

        <div className="lg:sticky lg:top-6 lg:self-start">
          <Card className="border-border/70 shadow-sm">
            <CardContent className="space-y-5 p-6">
              {selectedTemplate ? (
                <>
                  <div className="space-y-2">
                    <Badge variant="secondary" className="w-fit rounded-full px-3 py-1.5 text-xs font-medium">
                      {selectedTemplate.featured ? "Featured starter" : "Template details"}
                    </Badge>
                    <h2 className="text-2xl font-semibold tracking-tight text-foreground">
                      {selectedTemplate.name}
                    </h2>
                    <p className="text-sm leading-6 text-muted-foreground">
                      {selectedTemplate.description}
                    </p>
                  </div>

                  <div className="grid gap-3 sm:grid-cols-2">
                    <div className="rounded-2xl border border-border/70 bg-muted/20 p-4">
                      <div className="text-xs uppercase tracking-[0.24em] text-muted-foreground">Difficulty</div>
                      <div className="mt-2 font-medium text-foreground capitalize">{selectedTemplate.difficulty || "beginner"}</div>
                    </div>
                    <div className="rounded-2xl border border-border/70 bg-muted/20 p-4">
                      <div className="text-xs uppercase tracking-[0.24em] text-muted-foreground">Setup time</div>
                      <div className="mt-2 font-medium text-foreground">{selectedTemplate.estimatedMinutes || 10} minutes</div>
                    </div>
                  </div>

                  <div className="space-y-3">
                    <div className="text-xs uppercase tracking-[0.24em] text-muted-foreground">Included stack</div>
                    <div className="flex flex-wrap gap-2">
                      {(selectedTemplate.stack || ["Next.js", "Tailwind CSS"]).map((stackItem) => (
                        <Badge key={stackItem} variant="outline" className="rounded-full px-2.5 py-1 text-[11px] font-normal">
                          {stackItem}
                        </Badge>
                      ))}
                    </div>
                  </div>

                  <div className="space-y-3">
                    <div className="text-xs uppercase tracking-[0.24em] text-muted-foreground">Starter files</div>
                    <div className="space-y-2">
                      {selectedTemplate.files.slice(0, 5).map((file) => (
                        <div key={file.path} className="rounded-2xl border border-border/70 bg-background/80 px-4 py-3 text-sm text-foreground">
                          {file.path}
                        </div>
                      ))}
                    </div>
                  </div>

                  <div className="space-y-3">
                    <div className="text-xs uppercase tracking-[0.24em] text-muted-foreground">No-code launch settings</div>
                    <div>
                      <label className="text-sm font-medium text-foreground">Project name</label>
                      <Input
                        className="mt-2"
                        value={projectName}
                        onChange={(event) => setProjectName(event.target.value)}
                        disabled={isCreating}
                      />
                    </div>
                    <div>
                      <label className="text-sm font-medium text-foreground">Project description</label>
                      <Textarea
                        className="mt-2 min-h-[100px]"
                        value={projectDescription}
                        onChange={(event) => setProjectDescription(event.target.value)}
                        disabled={isCreating}
                      />
                    </div>
                    <div>
                      <label className="text-sm font-medium text-foreground">Workspace target</label>
                      <Select value={workspaceId} onValueChange={setWorkspaceId} disabled={isCreating}>
                        <SelectTrigger className="mt-2">
                          <SelectValue placeholder="Choose a workspace" />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value={NEW_WORKSPACE_VALUE}>Create a new workspace automatically</SelectItem>
                          {workspaces.map((workspace) => (
                            <SelectItem key={workspace.id} value={workspace.id}>
                              {workspace.name}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <p className="mt-2 text-xs text-muted-foreground">
                        If you have no workspace or choose the auto option, the app creates one for you.
                      </p>
                    </div>
                  </div>

                  {error && (
                    <div className="rounded-2xl border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">
                      {error}
                    </div>
                  )}

                  <div className="flex flex-col gap-3 sm:flex-row">
                    <Button className="flex-1 gap-2" onClick={() => void handleCreateFromTemplate()} disabled={isCreating}>
                      {isCreating ? (
                        <>
                          <Loader2 className="h-4 w-4 animate-spin" />
                          Creating project...
                        </>
                      ) : (
                        <>
                          Use template
                          <ArrowRight className="h-4 w-4" />
                        </>
                      )}
                    </Button>
                    <Button
                      variant="outline"
                      onClick={() => {
                        setSearchQuery("")
                        setActiveCategory("all")
                      }}
                      disabled={isCreating}
                    >
                      Reset filters
                    </Button>
                  </div>
                </>
              ) : (
                <div className="flex flex-col items-center justify-center gap-3 py-16 text-center">
                  <Layout className="h-12 w-12 text-muted-foreground" />
                  <h3 className="text-lg font-semibold text-foreground">Choose a template</h3>
                  <p className="max-w-sm text-sm leading-6 text-muted-foreground">
                    Select any starter on the left to see its files, settings, and one-click launch controls.
                  </p>
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      </section>
    </div>
  )
}

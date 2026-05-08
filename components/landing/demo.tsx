"use client"

import { useState } from "react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import {
  ArrowRight,
  BarChart3,
  Check,
  CheckCircle2,
  Copy,
  FileText,
  Layers3,
  LayoutDashboard,
  Sparkles,
  Table2,
  type LucideIcon,
} from "lucide-react"

type PreviewVariant = "dashboard" | "pricing" | "blog" | "contact"

type PromptSample = {
  prompt: string
  label: string
  summary: string
  preview: PreviewVariant
  sections: string[]
  files: string[]
  deliverables: string[]
  stats: Array<{ label: string; value: string }>
}

const promptSamples: PromptSample[] = [
  {
    prompt: "Build a dashboard with charts showing user analytics",
    label: "Analytics dashboard",
    summary: "Turns the prompt into KPI cards, a growth chart, and an activity table.",
    preview: "dashboard",
    sections: ["Hero metrics", "Growth chart", "Activity table", "Quick actions"],
    files: [
      "app/dashboard/page.tsx",
      "components/dashboard/metric-card.tsx",
      "components/dashboard/activity-table.tsx",
    ],
    deliverables: ["4 KPI cards", "Trend chart", "Recent activity table", "Action CTA"],
    stats: [
      { label: "Sections", value: "6" },
      { label: "Components", value: "8" },
      { label: "Files", value: "3" },
    ],
  },
  {
    prompt: "Create a pricing page with monthly and annual toggles",
    label: "Pricing page",
    summary: "Returns pricing cards, a comparison table, FAQ, and billing CTA.",
    preview: "pricing",
    sections: ["Pricing cards", "Comparison table", "FAQ", "Billing CTA"],
    files: ["app/pricing/page.tsx", "components/pricing/pricing-card.tsx", "components/pricing/faq.tsx"],
    deliverables: ["Credit packs", "Monthly toggle", "Billing copy", "FAQ answers"],
    stats: [
      { label: "Plans", value: "3" },
      { label: "Sections", value: "5" },
      { label: "Files", value: "3" },
    ],
  },
  {
    prompt: "Design a blog layout with featured posts sidebar",
    label: "Blog layout",
    summary: "Creates a content-led homepage with a featured story and sidebar stack.",
    preview: "blog",
    sections: ["Hero story", "Featured posts", "Sidebar", "Subscribe CTA"],
    files: ["app/blog/page.tsx", "components/blog/featured-post.tsx", "components/blog/sidebar.tsx"],
    deliverables: ["Featured article", "Post grid", "Categories", "Subscribe form"],
    stats: [
      { label: "Stories", value: "6" },
      { label: "Components", value: "7" },
      { label: "Files", value: "3" },
    ],
  },
  {
    prompt: "Make a contact form with validation and success state",
    label: "Contact form",
    summary: "Builds a validated form with helper text and a success confirmation state.",
    preview: "contact",
    sections: ["Form fields", "Validation", "Success state", "Support CTA"],
    files: ["app/contact/page.tsx", "components/forms/contact-form.tsx", "components/ui/toast.tsx"],
    deliverables: ["Validated form", "Success toast", "Helper copy", "Response state"],
    stats: [
      { label: "Fields", value: "5" },
      { label: "States", value: "3" },
      { label: "Files", value: "3" },
    ],
  },
]

const metricIcons: LucideIcon[] = [BarChart3, Layers3, FileText]

export function Demo() {
  const [copied, setCopied] = useState(false)
  const [selectedPrompt, setSelectedPrompt] = useState(0)

  const current = promptSamples[selectedPrompt]

  const handleCopy = () => {
    navigator.clipboard.writeText(current.prompt)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  return (
    <section id="demo" className="border-t border-border py-20 sm:py-32">
      <div className="mx-auto max-w-7xl px-4 sm:px-6">
        <div className="grid items-start gap-12 lg:grid-cols-[0.95fr,1.05fr]">
          <div className="space-y-6">
            <Badge className="gap-2 rounded-full border border-border bg-secondary px-4 py-1.5 text-xs font-medium text-muted-foreground">
              <Sparkles className="h-3.5 w-3.5" />
              Prompt result explorer
            </Badge>
            <div className="space-y-4">
              <h2 className="text-balance text-3xl font-bold tracking-tight text-foreground sm:text-4xl">
                See exactly what each prompt produces.
              </h2>
              <p className="text-pretty text-lg leading-7 text-muted-foreground">
                Swift does not just accept a prompt. It returns a structured result pack with sections, files, states, and a visual preview so users know what they are getting before they continue.
              </p>
            </div>

            <div className="space-y-3">
              {promptSamples.map((sample, index) => {
                const isSelected = selectedPrompt === index

                return (
                  <button
                    key={sample.prompt}
                    onClick={() => setSelectedPrompt(index)}
                    aria-pressed={isSelected}
                    className={cn(
                      "group block w-full rounded-3xl border p-4 text-left transition-all duration-200",
                      isSelected
                        ? "border-primary/40 bg-primary/5 shadow-md shadow-primary/5"
                        : "border-border bg-background hover:-translate-y-0.5 hover:border-border/80 hover:bg-secondary/40"
                    )}
                  >
                    <div className="flex items-start gap-4">
                      <div
                        className={cn(
                          "flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl border text-sm font-semibold transition-colors",
                          isSelected
                            ? "border-primary/20 bg-primary text-primary-foreground"
                            : "border-border bg-secondary text-foreground"
                        )}
                      >
                        0{index + 1}
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <div>
                            <div className="text-sm font-semibold text-foreground">{sample.label}</div>
                            <p className="mt-1 text-sm leading-6 text-muted-foreground">{sample.summary}</p>
                          </div>
                          <ArrowRight
                            className={cn(
                              "h-4 w-4 shrink-0 transition-transform",
                              isSelected ? "text-primary" : "text-muted-foreground/60 group-hover:translate-x-1"
                            )}
                          />
                        </div>
                        <div className="mt-3 flex flex-wrap gap-2">
                          {sample.stats.map((stat) => (
                            <span
                              key={stat.label}
                              className={cn(
                                "inline-flex items-center rounded-full border px-2.5 py-1 text-[11px] font-medium",
                                isSelected
                                  ? "border-primary/20 bg-background text-foreground"
                                  : "border-border bg-secondary/70 text-muted-foreground"
                              )}
                            >
                              {stat.label}: {stat.value}
                            </span>
                          ))}
                        </div>
                      </div>
                    </div>
                  </button>
                )
              })}
            </div>

            <div className="rounded-3xl border border-border bg-card p-5 shadow-sm">
              <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.24em] text-muted-foreground">
                <Layers3 className="h-3.5 w-3.5" />
                Result pack
              </div>
              <div className="mt-4 grid gap-3 sm:grid-cols-3">
                {current.stats.map((stat) => (
                  <div key={stat.label} className="rounded-2xl border border-border bg-secondary/40 p-4">
                    <div className="text-xs uppercase tracking-[0.2em] text-muted-foreground">{stat.label}</div>
                    <div className="mt-2 text-2xl font-semibold tracking-tight text-foreground">{stat.value}</div>
                  </div>
                ))}
              </div>
              <div className="mt-4 flex flex-wrap gap-2">
                {current.deliverables.map((item) => (
                  <span key={item} className="inline-flex items-center gap-2 rounded-full border border-border bg-background px-3 py-1.5 text-xs font-medium text-foreground">
                    <CheckCircle2 className="h-3.5 w-3.5 text-primary" />
                    {item}
                  </span>
                ))}
              </div>
              <div className="mt-5 flex items-center gap-3">
                <Button onClick={handleCopy} variant="outline" size="sm" className="gap-2 rounded-full">
                  {copied ? (
                    <>
                      <Check className="h-4 w-4" />
                      Copied prompt
                    </>
                  ) : (
                    <>
                      <Copy className="h-4 w-4" />
                      Copy prompt
                    </>
                  )}
                </Button>
                <div className="text-sm text-muted-foreground">Switch the prompt to change the output pack.</div>
              </div>
            </div>
          </div>

          <div className="relative">
            <div className="overflow-hidden rounded-[2rem] border border-border bg-card shadow-2xl shadow-black/5">
              <div className="flex items-center gap-3 border-b border-border bg-secondary/55 px-4 py-3">
                <div className="flex gap-1.5">
                  <div className="h-3 w-3 rounded-full bg-red-500/80" />
                  <div className="h-3 w-3 rounded-full bg-yellow-500/80" />
                  <div className="h-3 w-3 rounded-full bg-green-500/80" />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="text-xs font-medium uppercase tracking-[0.24em] text-muted-foreground">Output preview</div>
                  <div className="truncate text-sm font-semibold text-foreground">{current.label}</div>
                </div>
                <Badge variant="secondary" className="rounded-full px-2.5 py-1 text-[11px]">
                  {current.sections.length} outputs
                </Badge>
              </div>

              <div className="space-y-6 p-6">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <div className="text-sm font-medium text-muted-foreground">Generated result</div>
                    <h3 className="mt-1 text-2xl font-semibold tracking-tight text-foreground">{current.label}</h3>
                  </div>
                  <Badge className="gap-2 rounded-full border border-border bg-background px-3 py-1 text-xs font-medium text-foreground">
                    <Sparkles className="h-3.5 w-3.5 text-primary" />
                    Ready to review
                  </Badge>
                </div>

                <div className="grid gap-3 sm:grid-cols-3">
                  {current.stats.map((stat, index) => (
                    <ResultMetric key={stat.label} icon={metricIcons[index]} label={stat.label} value={stat.value} />
                  ))}
                </div>

                <div className="rounded-[1.5rem] border border-border bg-background p-4">
                  {renderPreview(current.preview)}
                </div>

                <div className="rounded-[1.5rem] border border-border bg-secondary/30 p-4">
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <div className="text-sm font-semibold text-foreground">What the user gets</div>
                      <div className="text-xs text-muted-foreground">
                        Sections, files, and interaction states that ship with the output.
                      </div>
                    </div>
                    <Badge variant="secondary" className="rounded-full px-2.5 py-1 text-[11px]">
                      {current.files.length} files
                    </Badge>
                  </div>

                  <div className="mt-4 flex flex-wrap gap-2">
                    {current.sections.map((section) => (
                      <span
                        key={section}
                        className="inline-flex items-center rounded-full border border-border bg-background px-3 py-1.5 text-xs font-medium text-foreground"
                      >
                        {section}
                      </span>
                    ))}
                  </div>

                  <div className="mt-4 grid gap-2 sm:grid-cols-2">
                    {current.files.map((file) => (
                      <div
                        key={file}
                        className="rounded-2xl border border-border bg-background px-3 py-2 font-mono text-[11px] text-muted-foreground"
                      >
                        {file}
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  )
}

function ResultMetric({
  icon: Icon,
  label,
  value,
}: {
  icon: LucideIcon
  label: string
  value: string
}) {
  return (
    <div className="rounded-2xl border border-border bg-card p-4 shadow-sm">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="text-xs uppercase tracking-[0.2em] text-muted-foreground">{label}</div>
          <div className="mt-2 text-2xl font-semibold tracking-tight text-foreground">{value}</div>
        </div>
        <div className="flex h-10 w-10 items-center justify-center rounded-2xl bg-primary/10 text-primary">
          <Icon className="h-5 w-5" />
        </div>
      </div>
    </div>
  )
}

function renderPreview(variant: PreviewVariant) {
  switch (variant) {
    case "dashboard":
      return <DashboardPreview />
    case "pricing":
      return <PricingPreview />
    case "blog":
      return <BlogPreview />
    case "contact":
      return <ContactPreview />
    default:
      return null
  }
}

function DashboardPreview() {
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-2xl bg-primary/10 text-primary">
            <LayoutDashboard className="h-5 w-5" />
          </div>
          <div>
          <div className="text-xs font-medium uppercase tracking-[0.24em] text-muted-foreground">Analytics dashboard</div>
          <div className="mt-1 text-lg font-semibold text-foreground">Live user analytics</div>
          </div>
        </div>
        <Badge variant="outline" className="rounded-full px-2.5 py-1 text-[11px]">
          Real-time view
        </Badge>
      </div>

      <div className="grid gap-3 sm:grid-cols-3">
        <PreviewTile label="Active users" value="24.8k" note="+18.4%" tone="bg-cyan-500/10" />
        <PreviewTile label="Conversion" value="7.2%" note="+2.1%" tone="bg-emerald-500/10" />
        <PreviewTile label="Revenue" value="Rp 48.2M" note="This month" tone="bg-amber-500/10" />
      </div>

      <div className="grid gap-4 lg:grid-cols-[1.2fr,0.8fr]">
        <div className="rounded-2xl border border-border p-4">
          <div className="flex items-center justify-between gap-3">
            <div className="text-sm font-medium text-foreground">Growth chart</div>
            <div className="text-xs text-muted-foreground">Last 30 days</div>
          </div>
          <div className="mt-4 flex h-32 items-end gap-2">
            {[34, 52, 44, 68, 58, 76, 64, 84].map((height, index) => (
              <div key={index} className="flex-1 rounded-t-2xl bg-primary/80" style={{ height: `${height}%` }} />
            ))}
          </div>
        </div>

        <div className="rounded-2xl border border-border p-4">
          <div className="text-sm font-medium text-foreground">Generated sections</div>
          <div className="mt-3 space-y-2 text-sm text-muted-foreground">
            <PreviewBullet text="Metric strip" />
            <PreviewBullet text="Growth chart" />
            <PreviewBullet text="Activity feed" />
            <PreviewBullet text="Quick action CTA" />
          </div>
        </div>
      </div>
    </div>
  )
}

function PricingPreview() {
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <div className="text-xs font-medium uppercase tracking-[0.24em] text-muted-foreground">Pricing page</div>
          <div className="mt-1 text-lg font-semibold text-foreground">Pricing with monthly and annual toggles</div>
        </div>
        <div className="flex items-center rounded-full border border-border bg-secondary p-1 text-xs font-medium">
          <span className="rounded-full bg-background px-3 py-1 text-foreground shadow-sm">Monthly</span>
          <span className="px-3 py-1 text-muted-foreground">Annual</span>
        </div>
      </div>

      <div className="grid gap-3 md:grid-cols-3">
        <PlanPreviewCard title="Free" price="Rp 0" tone="bg-secondary" />
        <PlanPreviewCard title="Builder" price="Rp 99k" tone="bg-primary/10 ring-1 ring-primary/20" highlighted />
        <PlanPreviewCard title="Studio" price="Rp 249k" tone="bg-secondary" />
      </div>

      <div className="rounded-2xl border border-border bg-muted/20 p-4">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2 text-sm font-medium text-foreground">
            <Table2 className="h-4 w-4 text-primary" />
            Feature comparison
          </div>
          <Badge variant="secondary" className="rounded-full px-2.5 py-1 text-[11px]">
            Credits-first billing
          </Badge>
        </div>
        <div className="mt-3 space-y-2 text-sm">
          <ComparisonRow label="Credits" free="5k" builder="50k" studio="250k" />
          <ComparisonRow label="Top up" free="No" builder="Yes" studio="Yes" />
          <ComparisonRow label="Support" free="Community" builder="Priority" studio="Priority chat" />
        </div>
      </div>
    </div>
  )
}

function BlogPreview() {
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <div className="text-xs font-medium uppercase tracking-[0.24em] text-muted-foreground">Blog layout</div>
          <div className="mt-1 text-lg font-semibold text-foreground">Featured post and sidebar</div>
        </div>
        <Badge variant="outline" className="rounded-full px-2.5 py-1 text-[11px]">
          Content ready
        </Badge>
      </div>

      <div className="grid gap-4 lg:grid-cols-[1.2fr,0.8fr]">
        <div className="overflow-hidden rounded-2xl border border-border">
          <div className="h-32 bg-[linear-gradient(135deg,rgba(59,130,246,0.22),rgba(99,102,241,0.08),rgba(15,23,42,0.08))]" />
          <div className="space-y-3 p-4">
            <Badge variant="secondary" className="rounded-full px-2.5 py-1 text-[11px]">
              Featured article
            </Badge>
            <div className="text-base font-semibold text-foreground">Designing a blog that keeps readers scrolling</div>
            <p className="text-sm leading-6 text-muted-foreground">
              Hero story, excerpt, tags, and a strong subscribe call to action.
            </p>
          </div>
        </div>

        <div className="space-y-3">
          <SidebarPost title="Remote team rituals" meta="4 min read" />
          <SidebarPost title="How to structure content clusters" meta="6 min read" />
          <SidebarPost title="Editor workflow checklist" meta="3 min read" />
        </div>
      </div>
    </div>
  )
}

function ContactPreview() {
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <div className="text-xs font-medium uppercase tracking-[0.24em] text-muted-foreground">Contact form</div>
          <div className="mt-1 text-lg font-semibold text-foreground">Validation plus success state</div>
        </div>
        <Badge variant="secondary" className="rounded-full px-2.5 py-1 text-[11px]">
          Form flow
        </Badge>
      </div>

      <div className="grid gap-4 lg:grid-cols-[1fr,0.8fr]">
        <div className="space-y-3 rounded-2xl border border-border p-4">
          <FieldBlock label="Name" value="John" />
          <FieldBlock label="Email" value="john@studio.io" />
          <FieldBlock label="Message" value="Need a redesign with validation and success state." large />
          <div className="h-10 rounded-xl bg-primary/90" />
        </div>

        <div className="rounded-2xl border border-emerald-500/20 bg-emerald-500/8 p-4">
          <div className="flex items-center gap-2 text-sm font-medium text-emerald-700 dark:text-emerald-300">
            <CheckCircle2 className="h-4 w-4" />
            Submission success
          </div>
          <div className="mt-3 rounded-2xl border border-emerald-500/20 bg-background p-4">
            <div className="text-sm font-semibold text-foreground">Thanks, we received your message.</div>
            <p className="mt-2 text-sm leading-6 text-muted-foreground">
              A confirmation toast and follow-up state are included in the generated result.
            </p>
          </div>
        </div>
      </div>
    </div>
  )
}

function PreviewTile({
  label,
  value,
  note,
  tone,
}: {
  label: string
  value: string
  note: string
  tone: string
}) {
  return (
    <div className={cn("rounded-2xl border border-border p-4", tone)}>
      <div className="text-xs uppercase tracking-[0.2em] text-muted-foreground">{label}</div>
      <div className="mt-2 text-2xl font-semibold tracking-tight text-foreground">{value}</div>
      <div className="mt-1 text-xs text-muted-foreground">{note}</div>
    </div>
  )
}

function PlanPreviewCard({
  title,
  price,
  tone,
  highlighted,
}: {
  title: string
  price: string
  tone: string
  highlighted?: boolean
}) {
  return (
    <div className={cn("rounded-2xl border border-border p-4", tone, highlighted && "shadow-md")}>
      <div className="text-sm font-medium text-foreground">{title}</div>
      <div className="mt-2 text-2xl font-semibold tracking-tight text-foreground">{price}</div>
      <div className="mt-3 space-y-2 text-sm text-muted-foreground">
        <div className="flex items-center gap-2">
          <Check className="h-3.5 w-3.5 text-primary" />
          Credits included
        </div>
        <div className="flex items-center gap-2">
          <Check className="h-3.5 w-3.5 text-primary" />
          Billing ready
        </div>
      </div>
    </div>
  )
}

function ComparisonRow({
  label,
  free,
  builder,
  studio,
}: {
  label: string
  free: string
  builder: string
  studio: string
}) {
  return (
    <div className="grid grid-cols-[1.2fr_repeat(3,minmax(0,1fr))] gap-2 text-xs sm:text-sm">
      <div className="rounded-xl border border-border bg-background px-3 py-2 font-medium text-foreground">{label}</div>
      <div className="rounded-xl border border-border bg-background px-3 py-2 text-center text-muted-foreground">{free}</div>
      <div className="rounded-xl border border-border bg-background px-3 py-2 text-center text-muted-foreground">{builder}</div>
      <div className="rounded-xl border border-border bg-background px-3 py-2 text-center text-muted-foreground">{studio}</div>
    </div>
  )
}

function SidebarPost({ title, meta }: { title: string; meta: string }) {
  return (
    <div className="rounded-2xl border border-border bg-background p-4">
      <div className="text-sm font-medium text-foreground">{title}</div>
      <div className="mt-1 text-xs text-muted-foreground">{meta}</div>
    </div>
  )
}

function FieldBlock({
  label,
  value,
  large = false,
}: {
  label: string
  value: string
  large?: boolean
}) {
  return (
    <div className="space-y-2">
      <div className="text-xs uppercase tracking-[0.2em] text-muted-foreground">{label}</div>
      <div
        className={cn(
          "rounded-xl border border-border bg-background px-3 py-2 text-sm text-muted-foreground",
          large && "min-h-24"
        )}
      >
        {value}
      </div>
    </div>
  )
}

function PreviewBullet({ text }: { text: string }) {
  return (
    <div className="flex items-center gap-2">
      <div className="h-1.5 w-1.5 rounded-full bg-primary" />
      <span>{text}</span>
    </div>
  )
}

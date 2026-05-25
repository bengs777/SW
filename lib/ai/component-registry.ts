import type { GeneratedFile } from "@/lib/types"
import { buildImportGraph } from "@/lib/ai/import-graph"

export type ComponentPropType = "string" | "string[]" | "link[]" | "feature[]"

export type ComponentPropContract = {
  name: string
  type: ComponentPropType
  required: boolean
  defaultValue?: unknown
}

export type ComponentContract = {
  name: string
  importPath: string
  filePath: string
  implementationPaths: string[]
  requiredProps: string[]
  optionalProps: string[]
  defaultProps: Record<string, unknown>
  importDependencies: string[]
  type: "client" | "server"
  props: ComponentPropContract[]
}

export type ComponentContractValidationResult = {
  ok: boolean
  failures: Array<{
    code: "required_prop_missing" | "prop_type_invalid" | "component_dependency_missing" | "freeform_standard_component"
    file: string
    component?: string
    prop?: string
    message: string
  }>
  componentUsage: Array<{ file: string; component: string; importPath: string }>
  dependencyGraph: Array<{ source: string; target: string }>
  usage: ComponentRegistryUsage
}

const REGISTRY_ROOT = "component-registry"

export type ComponentGenerationCategory =
  | "registry_reused"
  | "registry_missing"
  | "custom_generated"
  | "duplicate_component"
  | "invalid_contract"

export type ComponentRegistryUsage = {
  selectedTemplate: string | null
  selectedRegistryComponents: string[]
  generatedComponents: string[]
  reusedComponentNames: string[]
  customGeneratedComponentNames: string[]
  reusedComponents: number
  customGeneratedComponents: number
  totalComponents: number
  registryUsageRate: number
  componentGenerationAnalytics: Record<ComponentGenerationCategory, number>
}

export const STANDARD_COMPONENT_CONTRACTS: ComponentContract[] = [
  contract("HeroSection", "hero", "server", [
    prop("title", "string", true),
    prop("subtitle", "string", false, "Build a focused, production-ready page with clear sections and resilient rendering."),
    prop("eyebrow", "string", false, "Swift AI"),
    prop("primaryAction", "string", false, "Get started"),
    prop("secondaryAction", "string", false, "Learn more"),
  ], ["sections/hero-section.tsx", "sections/HeroSection.tsx"]),
  contract("Navbar", "navbar", "server", [
    prop("brand", "string", true),
    prop("links", "link[]", false, []),
  ], ["components/site-header.tsx", "components/header.tsx"]),
  contract("Footer", "footer", "server", [
    prop("brand", "string", true),
    prop("tagline", "string", false, "Reliable software generated with clear contracts."),
  ], ["components/site-footer.tsx", "components/footer.tsx"]),
  contract("DashboardCard", "dashboard-card", "server", [
    prop("label", "string", true),
    prop("value", "string", true),
    prop("detail", "string", false, "Updated recently"),
  ]),
  contract("FeatureSection", "feature-section", "server", [
    prop("title", "string", true),
    prop("features", "feature[]", false, []),
  ], ["sections/features-section.tsx", "sections/feature-section.tsx", "sections/FeaturesSection.tsx"]),
  contract("Testimonial", "testimonial", "server", [
    prop("quote", "string", true),
    prop("author", "string", true),
    prop("role", "string", false, "Customer"),
  ]),
  contract("Pricing", "pricing", "server", [
    prop("plan", "string", true),
    prop("price", "string", true),
    prop("features", "string[]", false, []),
  ]),
]

const TEMPLATE_COMPONENTS: Record<string, string[]> = {
  landing: ["Navbar", "HeroSection", "FeatureSection", "Testimonial", "Pricing", "Footer"],
  dashboard: ["Navbar", "DashboardCard", "FeatureSection", "Footer"],
  marketplace: ["Navbar", "HeroSection", "FeatureSection", "Pricing", "Footer"],
  saas: ["Navbar", "HeroSection", "DashboardCard", "FeatureSection", "Pricing", "Footer"],
  crm: ["Navbar", "DashboardCard", "FeatureSection", "Footer"],
  restaurant: ["Navbar", "HeroSection", "FeatureSection", "Testimonial", "Footer"],
  clinic: ["Navbar", "HeroSection", "DashboardCard", "FeatureSection", "Footer"],
  laundry: ["Navbar", "HeroSection", "FeatureSection", "Pricing", "Footer"],
  blog: ["Navbar", "HeroSection", "FeatureSection", "Footer"],
  portfolio: ["Navbar", "HeroSection", "FeatureSection", "Testimonial", "Footer"],
}

export const STANDARD_COMPONENT_REGISTRY_FILES: GeneratedFile[] = [
  registryFile("hero.tsx", `export type HeroSectionProps = {
  title: string
  subtitle?: string
  eyebrow?: string
  primaryAction?: string
  secondaryAction?: string
}

const defaultProps = {
  subtitle: "Build a focused, production-ready page with clear sections and resilient rendering.",
  eyebrow: "Swift AI",
  primaryAction: "Get started",
  secondaryAction: "Learn more",
}

export function HeroSection(props: HeroSectionProps) {
  const merged = { ...defaultProps, ...props }

  return (
    <section className="px-6 py-16">
      <div className="mx-auto max-w-5xl">
        <p className="text-sm font-semibold uppercase tracking-wide text-slate-500">{merged.eyebrow}</p>
        <h1 className="mt-4 max-w-3xl text-4xl font-bold text-slate-950 md:text-6xl">{merged.title}</h1>
        {merged.subtitle ? <p className="mt-5 max-w-2xl text-lg text-slate-600">{merged.subtitle}</p> : null}
        <div className="mt-8 flex flex-wrap gap-3">
          <span className="rounded-md bg-slate-950 px-4 py-2 text-sm font-semibold text-white">{merged.primaryAction}</span>
          <span className="rounded-md border border-slate-300 px-4 py-2 text-sm font-semibold text-slate-800">{merged.secondaryAction}</span>
        </div>
      </div>
    </section>
  )
}
`),
  registryFile("navbar.tsx", `export type NavbarProps = {
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
`),
  registryFile("footer.tsx", `export type FooterProps = {
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
`),
  registryFile("dashboard-card.tsx", `export type DashboardCardProps = {
  label: string
  value: string
  detail?: string
}

const defaultProps = {
  detail: "Updated recently",
}

export function DashboardCard(props: DashboardCardProps) {
  return (
    <article className="rounded-lg border border-slate-200 bg-white p-5 shadow-sm">
      <p className="text-sm font-medium text-slate-500">{props.label}</p>
      <p className="mt-2 text-3xl font-bold text-slate-950">{props.value}</p>
      <p className="mt-2 text-sm text-slate-600">{props.detail || defaultProps.detail}</p>
    </article>
  )
}
`),
  registryFile("feature-section.tsx", `export type FeatureSectionProps = {
  title: string
  features?: Array<{ title: string; body: string }>
}

const defaultProps = {
  features: [
    { title: "Structured", body: "Sections compose from typed data and stable component contracts." },
    { title: "Validated", body: "Required props and dependencies are checked before runtime render." },
    { title: "Responsive", body: "Layouts stay simple, readable, and predictable across viewports." },
  ],
}

export function FeatureSection(props: FeatureSectionProps) {
  const features = props.features || defaultProps.features

  return (
    <section id="features" className="px-6 py-14">
      <div className="mx-auto max-w-6xl">
        <h2 className="text-3xl font-bold text-slate-950">{props.title}</h2>
        <div className="mt-8 grid gap-4 md:grid-cols-3">
          {features.map((feature) => (
            <article key={feature.title} className="rounded-lg border border-slate-200 bg-white p-5">
              <h3 className="font-semibold text-slate-950">{feature.title}</h3>
              <p className="mt-2 text-sm text-slate-600">{feature.body}</p>
            </article>
          ))}
        </div>
      </div>
    </section>
  )
}
`),
  registryFile("testimonial.tsx", `export type TestimonialProps = {
  quote: string
  author: string
  role?: string
}

const defaultProps = {
  role: "Customer",
}

export function Testimonial(props: TestimonialProps) {
  return (
    <figure className="rounded-lg border border-slate-200 bg-slate-50 p-6">
      <blockquote className="text-lg font-medium text-slate-900">"{props.quote}"</blockquote>
      <figcaption className="mt-4 text-sm text-slate-600">
        <span className="font-semibold text-slate-900">{props.author}</span>
        <span> - {props.role || defaultProps.role}</span>
      </figcaption>
    </figure>
  )
}
`),
  registryFile("pricing.tsx", `export type PricingProps = {
  plan: string
  price: string
  features?: string[]
}

const defaultProps = {
  features: ["Core pages", "Runtime validation", "Responsive layout"],
}

export function Pricing(props: PricingProps) {
  const features = props.features || defaultProps.features

  return (
    <section id="pricing" className="px-6 py-14">
      <div className="mx-auto max-w-md rounded-lg border border-slate-200 bg-white p-6 shadow-sm">
        <p className="text-sm font-semibold uppercase tracking-wide text-slate-500">{props.plan}</p>
        <p className="mt-3 text-4xl font-bold text-slate-950">{props.price}</p>
        <ul className="mt-6 space-y-2 text-sm text-slate-600">
          {features.map((feature) => (
            <li key={feature}>{feature}</li>
          ))}
        </ul>
      </div>
    </section>
  )
}
`),
]

export function ensureComponentRegistryFiles(files: GeneratedFile[]) {
  const byPath = new Map(files.map((file) => [normalizePath(file.path), file]))
  const next = [...files]
  for (const file of STANDARD_COMPONENT_REGISTRY_FILES) {
    if (!byPath.has(file.path)) next.push(file)
  }
  return next
}

export function componentRegistryPromptPayload() {
  return STANDARD_COMPONENT_CONTRACTS.map((item) => ({
    name: item.name,
    importPath: item.importPath,
    implementationPaths: item.implementationPaths,
    requiredProps: item.requiredProps,
    optionalProps: item.optionalProps,
    defaultProps: item.defaultProps,
    importDependencies: item.importDependencies,
    type: item.type,
  }))
}

export function selectedRegistryComponentsForTemplate(templateId?: string | null) {
  const selected = templateId ? TEMPLATE_COMPONENTS[templateId] : null
  return selected ? [...selected] : ["Navbar", "HeroSection", "FeatureSection", "Footer"]
}

export function analyzeComponentRegistryUsage(files: GeneratedFile[], selectedTemplate?: string | null): ComponentRegistryUsage {
  const normalized = files.map((file) => ({
    ...file,
    path: normalizePath(file.path),
    content: String(file.content || ""),
  }))
  const graph = buildImportGraph(normalized)
  const selectedRegistryComponents = selectedRegistryComponentsForTemplate(selectedTemplate)
  const registryNames = new Set(STANDARD_COMPONENT_CONTRACTS.map((item) => item.name))
  const reused = new Set<string>()
  const duplicate = new Set<string>()
  const generated = new Set<string>()
  const custom = new Set<string>()

  for (const item of STANDARD_COMPONENT_CONTRACTS) {
    for (const usage of findComponentUsages(normalized, item)) {
      if (importsComponentImplementation(graph, usage.file.path, item)) reused.add(item.name)
    }
  }

  for (const file of normalized) {
    if (!/\.(tsx|jsx)$/i.test(file.path) || file.path.startsWith(`${REGISTRY_ROOT}/`)) continue
    for (const name of declaredComponentNames(file.content)) {
      generated.add(name)
      const standardContract = STANDARD_COMPONENT_CONTRACTS.find((item) => item.name === name)
      if (standardContract?.implementationPaths.includes(file.path)) continue
      if (registryNames.has(name)) duplicate.add(name)
      else if (!["Page", "RootLayout", "Layout", "Loading", "Error", "NotFound"].includes(name)) custom.add(name)
    }
  }

  const missing = selectedRegistryComponents.filter((name) => !reused.has(name))
  const totalComponents = reused.size + custom.size
  return {
    selectedTemplate: selectedTemplate || null,
    selectedRegistryComponents,
    generatedComponents: Array.from(generated).sort(),
    reusedComponentNames: Array.from(reused).sort(),
    customGeneratedComponentNames: Array.from(custom).sort(),
    reusedComponents: reused.size,
    customGeneratedComponents: custom.size,
    totalComponents,
    registryUsageRate: totalComponents === 0 ? 0 : Math.round((reused.size / totalComponents) * 1000) / 10,
    componentGenerationAnalytics: {
      registry_reused: reused.size,
      registry_missing: missing.length,
      custom_generated: custom.size,
      duplicate_component: duplicate.size,
      invalid_contract: 0,
    },
  }
}

export function validateComponentContracts(files: GeneratedFile[], options?: { selectedTemplate?: string | null }): ComponentContractValidationResult {
  const normalized = files.map((file) => ({
    ...file,
    path: normalizePath(file.path),
    content: String(file.content || ""),
  }))
  const graph = buildImportGraph(normalized)
  const failures: ComponentContractValidationResult["failures"] = []
  const componentUsage: ComponentContractValidationResult["componentUsage"] = []
  const usage = analyzeComponentRegistryUsage(normalized, options?.selectedTemplate)

  for (const missing of graph.missingLocalImports) {
    failures.push({
      code: "component_dependency_missing",
      file: missing.file,
      message: `${missing.file} imports ${missing.specifier}, but no matching dependency file exists.`,
    })
  }

  for (const item of STANDARD_COMPONENT_CONTRACTS) {
    for (const file of normalized) {
      if (item.implementationPaths.includes(file.path)) continue
      if (declaresComponent(file.content, item.name)) {
        failures.push({
          code: "freeform_standard_component",
          file: file.path,
          component: item.name,
          message: `${item.name} is available in the component registry and must be imported from ${item.importPath}, not recreated from scratch.`,
        })
      }
    }

    for (const usage of findComponentUsages(normalized, item)) {
      const implementation = importsComponentImplementation(graph, usage.file.path, item)
      componentUsage.push({ file: usage.file.path, component: item.name, importPath: implementation?.specifier || item.importPath })
      if (!implementation) {
        failures.push({
          code: "component_dependency_missing",
          file: usage.file.path,
          component: item.name,
          message: `${usage.file.path} renders ${item.name} but does not import a valid implementation (${item.importPath} or ${item.implementationPaths.filter((filePath) => filePath !== item.filePath).join(", ")}).`,
        })
        continue
      }

      if (implementation.kind === "registry") {
        for (const required of item.requiredProps) {
          if (!hasProp(usage.attributes, required)) {
            failures.push({
              code: "required_prop_missing",
              file: usage.file.path,
              component: item.name,
              prop: required,
              message: `${usage.file.path} renders ${item.name} without required prop ${required}.`,
            })
          }
        }

        for (const propContract of item.props) {
          const value = readPropValue(usage.attributes, propContract.name)
          if (value && !isPropValueCompatible(value, propContract.type)) {
            failures.push({
              code: "prop_type_invalid",
              file: usage.file.path,
              component: item.name,
              prop: propContract.name,
              message: `${usage.file.path} passes an invalid ${propContract.type} value to ${item.name}.${propContract.name}.`,
            })
          }
        }
      }
    }
  }

  return {
    ok: failures.length === 0,
    failures,
    componentUsage,
    dependencyGraph: graph.localEdges.map((edge) => ({
      source: edge.source,
      target: edge.resolvedPath || edge.specifier,
    })),
    usage: {
      ...usage,
      componentGenerationAnalytics: {
        ...usage.componentGenerationAnalytics,
        invalid_contract: failures.length,
      },
    },
  }
}

function contract(
  name: string,
  slug: string,
  type: ComponentContract["type"],
  props: ComponentPropContract[],
  implementationAliases: string[] = []
): ComponentContract {
  const filePath = `${REGISTRY_ROOT}/${slug}.tsx`

  return {
    name,
    importPath: `@/${REGISTRY_ROOT}/${slug}`,
    filePath,
    implementationPaths: uniquePaths([filePath, ...implementationAliases]),
    requiredProps: props.filter((item) => item.required).map((item) => item.name),
    optionalProps: props.filter((item) => !item.required).map((item) => item.name),
    defaultProps: Object.fromEntries(props.filter((item) => !item.required).map((item) => [item.name, item.defaultValue])),
    importDependencies: [],
    type,
    props,
  }
}

function prop(name: string, type: ComponentPropType, required: boolean, defaultValue?: unknown): ComponentPropContract {
  return { name, type, required, defaultValue }
}

function registryFile(fileName: string, content: string): GeneratedFile {
  return {
    path: `${REGISTRY_ROOT}/${fileName}`,
    language: "tsx",
    content,
  }
}

function declaresComponent(content: string, name: string) {
  const escaped = escapeRegExp(name)
  return new RegExp(`(?:export\\s+)?(?:default\\s+)?function\\s+${escaped}\\b|(?:export\\s+)?const\\s+${escaped}\\s*=`).test(content)
}

function declaredComponentNames(content: string) {
  const names = new Set<string>()
  for (const match of content.matchAll(/(?:export\s+)?(?:default\s+)?function\s+([A-Z][A-Za-z0-9_]*)\b|(?:export\s+)?const\s+([A-Z][A-Za-z0-9_]*)\s*=/g)) {
    const name = match[1] || match[2]
    if (name) names.add(name)
  }
  return Array.from(names)
}

function findComponentUsages(files: Array<GeneratedFile & { path: string; content: string }>, contract: ComponentContract) {
  const usages: Array<{ file: GeneratedFile & { path: string; content: string }; attributes: string }> = []
  const tagRe = new RegExp(`<${escapeRegExp(contract.name)}\\b([^>]*)\\/?>(?:</${escapeRegExp(contract.name)}>)?`, "g")
  for (const file of files) {
    if (contract.implementationPaths.includes(file.path) || !/\.(tsx|jsx)$/i.test(file.path)) continue
    for (const match of file.content.matchAll(tagRe)) {
      usages.push({ file, attributes: match[1] || "" })
    }
  }
  return usages
}

function importsComponentImplementation(graph: ReturnType<typeof buildImportGraph>, source: string, contract: ComponentContract) {
  const node = graph.byFile.get(normalizePath(source))
  if (!node) return null

  for (const edge of node.imports) {
    const resolvedPath = edge.resolvedPath ? normalizePath(edge.resolvedPath) : null
    if (resolvedPath && contract.implementationPaths.includes(resolvedPath)) {
      return {
        kind: resolvedPath === contract.filePath ? "registry" as const : "local" as const,
        path: resolvedPath,
        specifier: edge.specifier,
      }
    }
    if (edge.specifier === contract.importPath) {
      return {
        kind: "registry" as const,
        path: contract.filePath,
        specifier: edge.specifier,
      }
    }
  }

  return null
}

function hasProp(attributes: string, name: string) {
  return new RegExp(`\\b${escapeRegExp(name)}\\s*=`).test(attributes)
}

function readPropValue(attributes: string, name: string) {
  const match = attributes.match(new RegExp(`\\b${escapeRegExp(name)}\\s*=\\s*("[^"]*"|'[^']*'|\\{[^}]*\\})`))
  return match?.[1] || null
}

function isPropValueCompatible(value: string, type: ComponentPropType) {
  const trimmed = value.trim()
  if (type === "string") {
    if (/^["'][\s\S]*["']$/.test(trimmed)) return true
    if (/^\{\s*`[\s\S]*`\s*\}$/.test(trimmed)) return true
    if (/^\{\s*["'][\s\S]*["']\s*\}$/.test(trimmed)) return true
    if (/^\{\s*[A-Za-z_$][A-Za-z0-9_$.]*\s*\}$/.test(trimmed)) return true
    return false
  }
  if (type === "string[]") {
    return /^\{[\s\S]*\}$/.test(trimmed)
  }
  if (type === "link[]" || type === "feature[]") {
    return /^\{[\s\S]*\}$/.test(trimmed)
  }
  return true
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

function normalizePath(value: string) {
  return String(value || "").replace(/\\/g, "/").replace(/^\/+/, "").replace(/^\.\//, "").trim()
}

function uniquePaths(paths: string[]) {
  return Array.from(new Set(paths.map(normalizePath).filter(Boolean)))
}

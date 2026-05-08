import type { GeneratedFile } from "@/lib/types"

const VOID_TAGS = new Set([
  "area",
  "base",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "param",
  "source",
  "track",
  "wbr",
])

export function buildBrowserPreviewFiles(files: GeneratedFile[]) {
  const previewLookup = new Map(
    files.map((file) => [normalizePreviewPath(file.path), file] as const)
  )
  const importResolver = createImportResolver(files)

  return files.map((file) => {
    const previewVariant = findPreviewVariant(file.path, previewLookup)
    const sourceContent = autoFixPreviewSource(
      String(previewVariant?.content ?? file.content ?? ""),
      file.path,
      importResolver
    )

    if (isPreviewJsonFile(file.path)) {
      try {
        const parsed = JSON.parse(sourceContent || "{}")
        return {
          ...file,
          content: `const __default_export = ${JSON.stringify(parsed, null, 2)}\n`,
        }
      } catch {
        return {
          ...file,
          content: `const __default_export = {}\n`,
        }
      }
    }

    if (isPreviewAssetFile(file.path)) {
      return {
        ...file,
        content: `const __default_export = {}\n`,
      }
    }

    if (!isPreviewExecutableFile(file.path)) {
      return file
    }

    if (!needsBrowserSafeRewrite(sourceContent)) {
      return {
        ...file,
        content: sourceContent,
      }
    }

    const browserSafeContent = makeBrowserSafePreviewContent(sourceContent)

    if (needsBrowserSafeRewrite(browserSafeContent) || /\bawait\b/.test(browserSafeContent)) {
      return {
        ...file,
        content: buildPreviewFallbackModule(file.path, "Preview disabled for server-only generated code."),
      }
    }

    return {
      ...file,
      content: browserSafeContent,
    }
  })
}

function autoFixPreviewSource(
  content: string,
  filePath: string,
  importResolver: ReturnType<typeof createImportResolver>
) {
  let output = repairCommonJsxAttributeStrings(String(content))
  output = repairCommonImportTypos(output, filePath, importResolver)
  output = repairUnclosedJsxTags(output)
  return output
}

function findPreviewVariant(path: string, previewLookup: Map<string, GeneratedFile>) {
  const normalized = normalizePreviewPath(path)
  const candidates = [
    normalized.replace(/(\.[^/.]+)$/, ".preview$1"),
    `preview/${normalized}`,
    normalized.replace(/^app\//, "preview/app/"),
  ]

  for (const candidate of candidates) {
    const found = previewLookup.get(candidate)
    if (found) {
      return found
    }
  }

  return null
}

function normalizePreviewPath(path: string) {
  return path.replace(/\\/g, "/").toLowerCase()
}

function isPreviewJsonFile(path: string) {
  return /\.json$/i.test(path)
}

function isPreviewAssetFile(path: string) {
  return /\.(css|scss|sass|less|md|env|prisma|html|txt|csv|yml|yaml|svg|png|jpe?g|gif|webp|avif|ico|bmp|mp4|webm|mp3|wav|ogg|woff2?|ttf|otf|lock|toml|ini|xml|pdf|webmanifest|manifest|d\.ts|d\.mts|d\.cts)$/i.test(path)
}

function isPreviewExecutableFile(path: string) {
  return /\.(tsx?|jsx?|mjs|cjs)$/i.test(path)
}

function needsBrowserSafeRewrite(content: string) {
  return /export\s+default\s+async|export\s+default\s+async\s*\(|\basync\s+function\b|@prisma\/client|prisma|next\/headers|next\/cookies|@\/lib\/db|node:fs|node:path|fs\b|path\b|process\.env|generateStaticParams|generateMetadata|getServerSideProps|getStaticProps|getInitialProps/i.test(content)
}

function buildPreviewFallbackModule(filePath: string, detail: string) {
  return `export default function PreviewFallback() {
  return (
    <div className="flex min-h-[240px] items-center justify-center rounded-xl border border-dashed border-border bg-background p-6 text-center">
      <div className="max-w-xl space-y-2">
        <h2 className="text-base font-semibold text-foreground">Preview disabled for ${JSON.stringify(filePath)}</h2>
        <p className="text-sm text-muted-foreground">${JSON.stringify(detail)}</p>
      </div>
    </div>
  )
}
`
}

function makeBrowserSafePreviewContent(content: string) {
  let s = repairCommonJsxAttributeStrings(String(content))

  const previewMockObject = `({
    id: "preview",
    name: "Preview item",
    title: "Preview item",
    slug: "preview-item",
    description: "Preview data generated for browser sandbox.",
    content: "Preview data",
    image: "/placeholder.svg",
    price: 0,
    amount: 0,
    value: 0,
    trend: "0%",
    features: [],
    items: [],
    ingredients: [],
    reviews: [],
    testimonials: [],
    gallery: [],
    beforeAfter: [],
    cta: { label: "Preview CTA", href: "#" },
  })`

  s = s.replace(/import\s+[\s\S]*?from\s+['"][^'"]*fs[^'"]*['"];?\s*/gi, "")
  s = s.replace(/import\s+[\s\S]*?from\s+['"][^'"]*path[^'"]*['"];?\s*/gi, "")
  s = s.replace(/import\s+[\s\S]*?from\s+['"][^'"]*prisma[^'"]*['"];?\s*/gi, "")
  s = s.replace(/import\s+[\s\S]*?from\s+['"][^'"]*@prisma\/client[^'"]*['"];?\s*/gi, "")
  s = s.replace(/import\s+[\s\S]*?from\s+['"][^'"]*node:fs[^'"]*['"];?\s*/gi, "")
  s = s.replace(/import\s+[\s\S]*?from\s+['"][^'"]*node:path[^'"]*['"];?\s*/gi, "")
  s = s.replace(/import\s+[\s\S]*?from\s+['"][^'"]*next\/headers[^'"]*['"];?\s*/gi, "")
  s = s.replace(/import\s+[\s\S]*?from\s+['"][^'"]*next\/cookies[^'"]*['"];?\s*/gi, "")
  s = s.replace(/import\s+[\s\S]*?from\s+['"][^'"]*@\/lib\/db[^'"]*['"];?\s*/gi, "")

  s = s.replace(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*await\s+prisma\.[A-Za-z0-9_$]+\.(findFirst|findUnique|findMany|count|aggregate)\([\s\S]*?\)\s*;?/g,
    (_full, bindingName: string, method: string) => {
      if (method === "findMany") {
        return `const ${bindingName} = [];`
      }

      if (method === "count") {
        return `const ${bindingName} = 0;`
      }

      return `const ${bindingName} = ${previewMockObject};`
    }
  )

  s = s.replace(/export\s+async\s+function\s+(getServerSideProps|getStaticProps|getInitialProps|generateStaticParams|generateMetadata)\s*\([\s\S]*?\)\s*\{[\s\S]*?\}\s*/gi, "")
  s = s.replace(/export\s+const\s+(dynamic|revalidate|runtime)\s*=\s*[^;\n]+;?\s*/gi, "")
  s = s.replace(/export\s+default\s+async\s+function/gi, "export default function")
  s = s.replace(/export\s+default\s+async\s*\(/gi, "export default (")
  s = s.replace(/\basync\s+(function\s+[A-Za-z0-9_$]+\s*\()/gi, "$1")
  s = s.replace(/\bawait\s+(\([^\)\n]+\)|[^\s;\n]+)/g, "null")
  s = s.replace(/new\s+Promise\s*\([\s\S]*?\)/g, "null")
  s = s.replace(/Promise\.[A-Za-z0-9_$]+\s*\(/g, "/*Promise*/ (function(){return Promise})(")
  s = s.replace(/\bprocess\.env\.[A-Za-z0-9_]+/g, "undefined")

  return repairUnclosedJsxTags(s)
}

function repairCommonJsxAttributeStrings(content: string) {
  return String(content).replace(
    /([A-Za-z_$][\w:-]*)=\{\s*'([\s\S]*?\$\{[\s\S]*?\}[\s\S]*?)'\s*\}/g,
    (_full, attributeName: string, attributeValue: string) => {
      const normalizedValue = attributeValue.replace(/\\\$\{/g, "${")
      return `${attributeName}={\`${normalizedValue}\`}`
    }
  )
}

function repairCommonImportTypos(
  content: string,
  filePath: string,
  importResolver: ReturnType<typeof createImportResolver>
) {
  return String(content).replace(
    /(from\s+|import\s*)['"]([^'"]+)['"]/g,
    (full, prefix: string, specifier: string) => {
      const fixedCommon = fixCommonImportSpecifierTypos(specifier)
      const fixedResolved = importResolver(filePath, fixedCommon)
      const nextSpecifier = fixedResolved || fixedCommon
      return nextSpecifier === specifier ? full : `${prefix}"${nextSpecifier}"`
    }
  )
}

function fixCommonImportSpecifierTypos(specifier: string) {
  return specifier
    .replace(/^@\/component(\/|$)/, "@/components$1")
    .replace(/^@\/compnents(\/|$)/, "@/components$1")
    .replace(/^@\/componets(\/|$)/, "@/components$1")
    .replace(/^@\/lib\/utlis(\/|$)/, "@/lib/utils$1")
    .replace(/^@\/lib\/util(\/|$)/, "@/lib/utils$1")
    .replace(/^lucide-reacts$/, "lucide-react")
    .replace(/^lucide$/, "lucide-react")
}

function repairUnclosedJsxTags(content: string) {
  const source = String(content)
  const stack = getUnclosedJsxTagStack(source)
  if (stack.length === 0 || stack.length > 4) {
    return source
  }

  const closingTags = stack.reverse().map((tag) => `</${tag}>`).join("")
  const returnCloseMatch = source.match(/\n(\s*)\)(\s*;?\s*(?:\n\s*}|\n\s*$))/)

  if (returnCloseMatch?.index != null) {
    const insertAt = returnCloseMatch.index
    return `${source.slice(0, insertAt)}${closingTags}${source.slice(insertAt)}`
  }

  return `${source}\n${closingTags}\n`
}

function getUnclosedJsxTagStack(content: string) {
  const stripped = String(content)
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
    .replace(/<!--[\s\S]*?-->/g, "")
  const stack: string[] = []
  const tagPattern = /<\/?([A-Za-z][\w.]*)\b([^<>]*)>/g

  for (const match of stripped.matchAll(tagPattern)) {
    const [fullTag, rawName, rawAttributes] = match
    const tagName = rawName.split(".")[0]
    const isClosing = fullTag.startsWith("</")
    const isSelfClosing = /\/\s*>$/.test(fullTag) || VOID_TAGS.has(tagName.toLowerCase())

    if (isSelfClosing) {
      continue
    }

    if (isClosing) {
      const lastIndex = stack.lastIndexOf(tagName)
      if (lastIndex >= 0) {
        stack.splice(lastIndex, 1)
      }
      continue
    }

    if (rawAttributes.includes("=") || /^[A-Z]/.test(tagName) || /^[a-z]/.test(tagName)) {
      stack.push(tagName)
    }
  }

  return stack
}

function createImportResolver(files: GeneratedFile[]) {
  const existingPaths = files.map((file) => normalizeFilePath(file.path))
  const importTargets = new Map<string, string>()

  for (const filePath of existingPaths) {
    for (const key of getImportTargetKeys(filePath)) {
      importTargets.set(key, filePath)
    }
  }

  return (fromPath: string, specifier: string) => {
    if (!specifier.startsWith("@/") && !specifier.startsWith(".")) {
      return null
    }

    const resolvedPath = resolveImportPath(fromPath, specifier)
    if (!resolvedPath) {
      return null
    }

    const exact = findExistingImportTarget(resolvedPath, importTargets)
    if (exact) {
      return null
    }

    const closest = findClosestImportTarget(resolvedPath, Array.from(importTargets.keys()))
    if (!closest) {
      return null
    }

    return specifier.startsWith("@/")
      ? `@/${closest}`
      : relativeImportSpecifier(fromPath, closest)
  }
}

function findExistingImportTarget(resolvedPath: string, importTargets: Map<string, string>) {
  return getImportTargetKeys(resolvedPath).some((key) => importTargets.has(key))
}

function findClosestImportTarget(resolvedPath: string, candidates: string[]) {
  const normalized = stripImportExtension(normalizeFilePath(resolvedPath))
  const sameAreaCandidates = candidates.filter((candidate) => {
    const normalizedCandidate = stripImportExtension(candidate)
    const sameBasename = basename(normalizedCandidate)[0] === basename(normalized)[0]
    const sameTopLevel = normalizedCandidate.split("/")[0] === normalized.split("/")[0]
    return sameBasename || sameTopLevel
  })

  let best: { candidate: string; distance: number } | null = null
  for (const candidate of sameAreaCandidates) {
    const distance = levenshteinDistance(normalized, stripImportExtension(candidate))
    if (distance <= 3 && (!best || distance < best.distance)) {
      best = { candidate: stripImportExtension(candidate), distance }
    }
  }

  return best?.candidate || null
}

function resolveImportPath(fromPath: string, specifier: string) {
  const normalizedSpecifier = specifier.replace(/\\/g, "/")
  if (normalizedSpecifier.startsWith("@/")) {
    return normalizedSpecifier.slice(2)
  }

  if (!normalizedSpecifier.startsWith(".")) {
    return null
  }

  const baseDir = dirname(normalizeFilePath(fromPath))
  return normalizeFilePath(joinPath(baseDir, normalizedSpecifier))
}

function relativeImportSpecifier(fromPath: string, targetPath: string) {
  const baseDir = dirname(normalizeFilePath(fromPath))
  let relative = relativePath(baseDir, stripImportExtension(targetPath))
  if (!relative.startsWith(".")) {
    relative = `./${relative}`
  }
  return relative
}

function getImportTargetKeys(filePath: string) {
  const normalized = normalizeFilePath(filePath)
  const stripped = stripImportExtension(normalized)
  const keys = new Set([normalized, stripped])

  if (/\/index$/i.test(stripped)) {
    keys.add(stripped.replace(/\/index$/i, ""))
  }

  return Array.from(keys)
}

function stripImportExtension(filePath: string) {
  return normalizeFilePath(filePath).replace(/\.(tsx?|jsx?|mjs|cjs|json)$/i, "")
}

function normalizeFilePath(filePath: string) {
  return filePath.replace(/\\/g, "/").replace(/^\.\//, "").toLowerCase()
}

function basename(filePath: string) {
  const segments = normalizeFilePath(filePath).split("/").filter(Boolean)
  return segments[segments.length - 1] || ""
}

function dirname(filePath: string) {
  const segments = normalizeFilePath(filePath).split("/").filter(Boolean)
  segments.pop()
  return segments.join("/") || "."
}

function joinPath(...parts: string[]) {
  const output: string[] = []
  const joined = parts.join("/")

  for (const part of joined.split("/")) {
    if (!part || part === ".") {
      continue
    }

    if (part === "..") {
      output.pop()
      continue
    }

    output.push(part)
  }

  return output.join("/")
}

function relativePath(fromDir: string, toPath: string) {
  const fromParts = normalizeFilePath(fromDir).split("/").filter(Boolean)
  const toParts = normalizeFilePath(toPath).split("/").filter(Boolean)

  while (fromParts.length > 0 && toParts.length > 0 && fromParts[0] === toParts[0]) {
    fromParts.shift()
    toParts.shift()
  }

  return [...fromParts.map(() => ".."), ...toParts].join("/") || "."
}

function levenshteinDistance(left: string, right: string) {
  const matrix = Array.from({ length: left.length + 1 }, () =>
    Array.from({ length: right.length + 1 }, () => 0)
  )

  for (let i = 0; i <= left.length; i += 1) matrix[i][0] = i
  for (let j = 0; j <= right.length; j += 1) matrix[0][j] = j

  for (let i = 1; i <= left.length; i += 1) {
    for (let j = 1; j <= right.length; j += 1) {
      const cost = left[i - 1] === right[j - 1] ? 0 : 1
      matrix[i][j] = Math.min(
        matrix[i - 1][j] + 1,
        matrix[i][j - 1] + 1,
        matrix[i - 1][j - 1] + cost
      )
    }
  }

  return matrix[left.length][right.length]
}

import { validateRuntimeImports } from "@/lib/ai/runtime-tsx-validator"
import { repairRuntimeImportGraph } from "@/lib/ai/import-repair"
import type { GeneratedFile } from "@/lib/types"

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

const brokenImports: GeneratedFile[] = [
  {
    path: "app/page.tsx",
    language: "tsx",
    content: `import { Button } from "@/components/Button"
import { Button as ButtonAgain } from "@/components/Button"
import Missing from "@/components/Missing"
export default function Page() {
  return <Button />
}
`,
  },
  {
    path: "components/Button.tsx",
    language: "tsx",
    content: `export function Button() {
  return <button>OK</button>
}
`,
  },
]

const tsconfig: GeneratedFile = {
  path: "tsconfig.json",
  language: "json",
  content: JSON.stringify({ compilerOptions: { paths: { "@/*": ["./*"] } } }),
}

const result = validateRuntimeImports([...brokenImports, tsconfig], { requireTsconfigAlias: true })
assert(!result.ok, "broken imports should fail runtime import validation")
assert(result.diagnostics.some((item) => item.message.includes("Missing local import")), "missing local import diagnostic should be emitted")
assert(result.diagnostics.some((item) => item.message.includes("Duplicate import")), "duplicate import diagnostic should be emitted")

const validImports: GeneratedFile[] = [
  {
    path: "app/page.tsx",
    language: "tsx",
    content: `import { Button } from "@/components/Button"
export default function Page() {
  return <Button />
}
`,
  },
  brokenImports[1],
  tsconfig,
]

assert(validateRuntimeImports(validImports, { requireTsconfigAlias: true }).ok, "valid imports should pass")

const missingAliasConfig = validateRuntimeImports(validImports, { requireTsconfigAlias: true })
assert(missingAliasConfig.ok, "valid tsconfig alias should satisfy production alias check")

const aliasRepair = repairRuntimeImportGraph(validImports, { plannedPaths: ["components/Button.tsx"], createMissing: false })
const repairedPage = aliasRepair.files.find((file) => file.path === "app/page.tsx")
assert(repairedPage?.content.includes('from "../components/Button"'), "alias repair should rewrite @/ imports to relative imports")
assert(validateRuntimeImports(aliasRepair.files, { requireTsconfigAlias: true }).ok, "relative import fallback should pass validation")

const srcAliasRepair = repairRuntimeImportGraph([
  {
    path: "src/app/page.tsx",
    language: "tsx",
    content: `import { Button } from "@/components/Button"
export default function Page() {
  return <Button />
}
`,
  },
  {
    path: "src/components/Button.tsx",
    language: "tsx",
    content: `export function Button() {
  return <button>OK</button>
}
`,
  },
])
const repairedSrcPage = srcAliasRepair.files.find((file) => file.path === "src/app/page.tsx")
assert(repairedSrcPage?.content.includes('from "../components/Button"'), "alias repair should resolve src/ app router files too")

const missingPlanned = validateRuntimeImports(brokenImports, {
  plannedPaths: ["components/Missing.tsx"],
  deferPlannedMissing: true,
})
assert(missingPlanned.diagnostics.every((item) => !item.message.includes("Missing local import")), "planned missing imports should be deferrable")

const createdMissing = repairRuntimeImportGraph(brokenImports, {
  plannedPaths: ["components/Missing.tsx"],
  createMissing: true,
})
assert(createdMissing.createdFiles.some((file) => file.path === "components/Missing.tsx"), "repair pass should generate planned missing import files")

const circularFiles: GeneratedFile[] = [
  {
    path: "lib/a.ts",
    language: "ts",
    content: 'import { b } from "./b"\nexport const a = b\n',
  },
  {
    path: "lib/b.ts",
    language: "ts",
    content: 'import { a } from "./a"\nexport const b = a\n',
  },
]
const circularResult = validateRuntimeImports(circularFiles)
assert(!circularResult.ok, "circular imports should fail validation")
assert(circularResult.diagnostics.some((item) => item.message.includes("Circular import")), "circular import diagnostic should be emitted")

console.log("runtime-import-validation-regression-ok")

import { validateRuntimeImports } from "@/lib/ai/runtime-tsx-validator"
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

const result = validateRuntimeImports(brokenImports)
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
]

assert(validateRuntimeImports(validImports).ok, "valid imports should pass")

console.log("runtime-import-validation-regression-ok")

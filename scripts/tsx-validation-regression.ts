import {
  autoRepairAdjacentJsxFragments,
  validateRuntimeSyntax,
} from "@/lib/ai/runtime-tsx-validator"
import type { GeneratedFile } from "@/lib/types"

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

const adjacent: GeneratedFile[] = [
  {
    path: "components/Button.tsx",
    language: "tsx",
    content: `export function Button() {
  return (
    <button>One</button>
    <button>Two</button>
  )
}
`,
  },
]

const adjacentResult = validateRuntimeSyntax(adjacent)
assert(!adjacentResult.ok, "adjacent JSX should fail syntax validation")
assert(adjacentResult.diagnostics[0].message.includes("Adjacent JSX elements"), "adjacent JSX diagnostic should be human readable")
const repaired = autoRepairAdjacentJsxFragments(adjacent, adjacentResult.diagnostics[0])
assert(repaired.repaired, "adjacent JSX should be auto repaired with a fragment")
assert(validateRuntimeSyntax(repaired.files).ok, "auto fragment repair should pass syntax validation")

const repairCases: Array<{ label: string; content: string }> = [
  {
    label: "conditional sibling JSX",
    content: `export function Panel({ active }: { active: boolean }) {
  return (
    active ? (
      <section>One</section>
      <section>Two</section>
    ) : <aside>None</aside>
  )
}
`,
  },
  {
    label: "mapped sibling JSX",
    content: `export function List() {
  return (
    <main>
      {[1, 2].map((item) => (
        <span>{item}</span>
        <strong>!</strong>
      ))}
    </main>
  )
}
`,
  },
  {
    label: "nested fragment wrapping",
    content: `export function Nested() {
  return (
    <main>
      {true && (
        <section>One</section>
        <section>Two</section>
      )}
    </main>
  )
}
`,
  },
  {
    label: "multiline return sibling JSX",
    content: `export function Multi() {
  return (
    <header>
      <h1>A</h1>
    </header>
    <main>
      <p>B</p>
    </main>
  )
}
`,
  },
]

for (const item of repairCases) {
  const files: GeneratedFile[] = [{ path: "components/Case.tsx", language: "tsx", content: item.content }]
  const before = validateRuntimeSyntax(files)
  assert(!before.ok, `${item.label} should fail before repair`)
  const fixed = autoRepairAdjacentJsxFragments(files, before.diagnostics[0])
  assert(fixed.repaired, `${item.label} should be auto repaired`)
  assert(fixed.repairedNodeType, `${item.label} should report repaired AST node type`)
  assert(validateRuntimeSyntax(fixed.files).ok, `${item.label} should pass after repair`)
}

const malformedClosing: GeneratedFile[] = [
  {
    path: "app/page.tsx",
    language: "tsx",
    content: `export default function Page() {
  return <main><section>Broken</main>
}
`,
  },
]
const closingResult = validateRuntimeSyntax(malformedClosing)
assert(!closingResult.ok, "missing closing tag should fail")

const malformedExport: GeneratedFile[] = [
  {
    path: "app/page.tsx",
    language: "tsx",
    content: `export default function Page() { return <main /> }
export default function Other() { return <main /> }
`,
  },
]
const exportResult = validateRuntimeSyntax(malformedExport)
assert(!exportResult.ok, "duplicate default export should fail")

const invalidHook: GeneratedFile[] = [
  {
    path: "app/page.tsx",
    language: "tsx",
    content: `"use client"
import { useState } from "react"
export default function Page() {
  if (Math.random() > 0.5) {
    useState(0)
  }
  return <main />
}
`,
  },
]
const hookResult = validateRuntimeSyntax(invalidHook)
assert(!hookResult.ok, "conditional hook should fail runtime syntax validation")
assert(hookResult.diagnostics[0].message.includes("hooks cannot be called conditionally"), "invalid hook diagnostic should be explicit")

console.log("tsx-validation-regression-ok")

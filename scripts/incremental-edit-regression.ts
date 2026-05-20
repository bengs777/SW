import {
  applyDeterministicIncrementalPatch,
  buildIncrementalEditPlan,
  validateIncrementalPatch,
} from "@/lib/ai/incremental-edit"
import type { GeneratedFile } from "@/lib/types"

const baseFiles: GeneratedFile[] = [
  {
    path: "app/page.tsx",
    language: "tsx",
    content: `export default function HomePage() {
  return (
    <main>
      <h1>Welcome to My Portfolio</h1>
      <p>Selected work and notes.</p>
    </main>
  )
}
`,
  },
]

const cases = [
  {
    prompt: "ganti judul jadi Coffee Bun",
    expected: "Coffee Bun",
  },
  {
    prompt: "ubah heading menjadi Coffee Bun",
    expected: "Coffee Bun",
  },
  {
    prompt: 'ganti "Welcome to My Portfolio" menjadi "Welcome to Coffee Bun"',
    expected: "Welcome to Coffee Bun",
  },
  {
    prompt: "Welcome to My Portfolio\nganti jadi\nWelcome to Coffee Bun",
    expected: "Welcome to Coffee Bun",
  },
]

for (const item of cases) {
  const plan = buildIncrementalEditPlan({
    prompt: item.prompt,
    files: baseFiles,
  })
  const patch = applyDeterministicIncrementalPatch({
    prompt: item.prompt,
    files: baseFiles,
    plan,
  })
  const validation = validateIncrementalPatch({
    files: patch.files,
    changedFiles: patch.changedFiles,
    plan,
  })
  const page = patch.files.find((file) => file.path === "app/page.tsx")
  if (!patch.applied || !validation.ok || !page?.content.includes(item.expected)) {
    console.error(JSON.stringify({ prompt: item.prompt, plan, patch, validation }, null, 2))
    process.exit(1)
  }
  if (patch.changedFiles.length !== 1 || patch.changedFiles[0].path !== "app/page.tsx") {
    console.error(JSON.stringify({ prompt: item.prompt, changedFiles: patch.changedFiles }, null, 2))
    process.exit(1)
  }
}

console.log("incremental-edit-regression-ok")

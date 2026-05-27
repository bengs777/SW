import { buildPartialEditPlan } from "@/lib/ai/edit-planner"
import type { GeneratedFile } from "@/lib/types"

const existingFiles: GeneratedFile[] = [
  {
    path: "app/page.tsx",
    language: "tsx",
    content: "export default function Page() { return <main>Empty</main> }",
  },
  {
    path: "components/header.tsx",
    language: "tsx",
    content: "export function Header() { return <header /> }",
  },
]

const broadCommercePrompt = "Buat web e-commerce dengan nama jbb untuk role admin user seller dan kurir"
const smallPatchPrompt = "ganti teks judul menjadi JBB Store"

const broadPlan = buildPartialEditPlan({
  prompt: broadCommercePrompt,
  existingFiles,
  collaborationMode: "edit",
})

if (broadPlan.mode !== "full") {
  throw new Error(`Expected broad e-commerce prompt to use full generation, got ${broadPlan.mode}`)
}

const patchPlan = buildPartialEditPlan({
  prompt: smallPatchPrompt,
  existingFiles,
  collaborationMode: "edit",
})

if (patchPlan.mode !== "partial") {
  throw new Error(`Expected small text edit to use partial generation, got ${patchPlan.mode}`)
}

console.log(JSON.stringify({
  broadCommerceMode: broadPlan.mode,
  broadCommerceReason: broadPlan.reason,
  smallPatchMode: patchPlan.mode,
  smallPatchTargets: patchPlan.targetPaths,
}))

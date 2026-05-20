import { parseGeneratedArtifact } from "@/lib/ai/generated-artifact"

const valid = parseGeneratedArtifact(
  JSON.stringify({
    files: [
      {
        path: "app/page.tsx",
        content: "export default function Page() { return <main>Hello</main> }",
      },
    ],
  }),
  { strictFilesOnly: true, requiredFiles: ["app/page.tsx"] }
)

if (valid.files.length !== 1 || valid.files[0].path !== "app/page.tsx") {
  throw new Error("valid files envelope did not parse")
}

const fenced = parseGeneratedArtifact(
  "```json\n{\"files\":[{\"path\":\"app/page.tsx\",\"content\":\"export default function Page() { return <main>Hello</main> }\"}]}\n```",
  { strictFilesOnly: true, requiredFiles: ["app/page.tsx"] }
)

if (fenced.files.length !== 1) {
  throw new Error("markdown fenced JSON was not recovered")
}

const cases = [
  {
    label: "missing required file",
    input: { files: [{ path: "app/page.tsx", content: "x" }] },
    options: { strictFilesOnly: true, requiredFiles: ["app/layout.tsx"] },
    includes: "Missing required file: app/layout.tsx",
  },
  {
    label: "duplicate path",
    input: { files: [{ path: "app/page.tsx", content: "x" }, { path: "app/page.tsx", content: "y" }] },
    options: { strictFilesOnly: true },
    includes: "Duplicate file path: app/page.tsx",
  },
  {
    label: "task graph rejected",
    input: { files: [], taskGraph: { operations: [{ action: "create", path: "app/page.tsx", content: "x" }] } },
    options: { strictFilesOnly: true },
    includes: "Empty files array",
  },
]

for (const item of cases) {
  try {
    parseGeneratedArtifact(JSON.stringify(item.input), item.options)
    throw new Error(`${item.label} unexpectedly parsed`)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (!message.includes(item.includes)) {
      throw new Error(`${item.label} diagnostic mismatch: ${message}`)
    }
  }
}

console.log("artifact-parser-regression-ok")

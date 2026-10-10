import assert from "node:assert"
import { getControlledAppBlueprint } from "@/lib/ai/app-blueprints"
import { runDeterministicAutomatedRepair, assertGenerationInvariants } from "@/lib/ai/generation-stabilization"
import type { GeneratedFile } from "@/lib/types"

async function runRegressionTest() {
  console.log("=== RUNNING REGRESSION TEST: AI output -> automated repair -> validation.files -> workingFiles -> invariant check ===")

  const blueprint = getControlledAppBlueprint("laundry_service")
  assert(blueprint, "laundry_service blueprint must exist")

  // 1. Simulate AI output: Missing @prisma/client and prisma in package.json
  const rawAiFiles: GeneratedFile[] = [
    {
      path: "package.json",
      language: "json",
      content: JSON.stringify({
        name: "test-laundry-app",
        version: "0.1.0",
        dependencies: {
          next: "16.2.6",
          react: "19.2.5",
          "react-dom": "19.2.5",
          typescript: "5.7.3",
          tailwindcss: "^4.2.0",
        },
      }),
    },
    {
      path: "app/page.tsx",
      language: "tsx",
      content: "export default function Page() { return <div>Laundry Kasir</div> }",
    },
    {
      path: "app/layout.tsx",
      language: "tsx",
      content: "export default function Layout({ children }: { children: React.ReactNode }) { return <html><body>{children}</body></html> }",
    },
    {
      path: "app/globals.css",
      language: "css",
      content: "@tailwind base;\n@tailwind components;\n@tailwind utilities;",
    },
    {
      path: "tsconfig.json",
      language: "json",
      content: "{}",
    },
  ]

  // 2. Verify that testing rawAiFiles directly against assertGenerationInvariants FAILS due to missing @prisma/client & prisma
  const rawInvariantResult = assertGenerationInvariants({
    files: rawAiFiles,
    blueprint,
    allowedScope: ["package.json", "app/page.tsx", "app/layout.tsx", "app/globals.css", "tsconfig.json"],
    expandedScope: [],
    authActive: false,
    prismaActive: false,
  })

  console.log("Raw AI files invariant ok:", rawInvariantResult.ok)
  assert.strictEqual(rawInvariantResult.ok, false, "Raw AI files must fail invariant check before repair")
  const missingPrismaHardFailures = rawInvariantResult.hardFailures.filter(f => f.code === "missing_blueprint_dependency")
  assert(missingPrismaHardFailures.some(f => f.message.includes("@prisma/client")), "Must report missing @prisma/client")
  assert(missingPrismaHardFailures.some(f => f.message.includes("prisma")), "Must report missing prisma")
  console.log("-> Proved: Raw AI output fails invariant as expected:", missingPrismaHardFailures.map(f => f.message))

  // 3. Automated repair runs (as done inside runValidationLifecycle)
  const repairResult = runDeterministicAutomatedRepair({
    files: rawAiFiles,
    blueprint,
    allowedScope: ["package.json", "app/page.tsx", "app/layout.tsx", "app/globals.css", "tsconfig.json"],
    expandedScope: [],
    authActive: false,
    prismaActive: false,
  })

  const validationFiles = repairResult.files

  // 4. Synchronization step: workingFiles = validation.files
  let workingFiles = rawAiFiles
  // Without synchronization, workingFiles fails.
  // With synchronization:
  workingFiles = validationFiles

  // 5. Verify package.json now contains @prisma/client and prisma
  const repairedPkgFile = workingFiles.find(f => f.path === "package.json")
  assert(repairedPkgFile, "package.json must exist in workingFiles")
  const repairedPkg = JSON.parse(repairedPkgFile.content)
  assert(repairedPkg.dependencies["@prisma/client"], "package.json must contain @prisma/client")
  assert(repairedPkg.devDependencies?.prisma || repairedPkg.dependencies?.prisma, "package.json must contain prisma")
  console.log("-> Proved: Automated repair injected dependencies:", {
    "@prisma/client": repairedPkg.dependencies["@prisma/client"],
    prisma: repairedPkg.devDependencies?.prisma || repairedPkg.dependencies?.prisma,
  })

  // 6. Final invariant gate check on workingFiles (identical to orchestrator line 10550)
  const finalInvariantResult = assertGenerationInvariants({
    files: workingFiles,
    blueprint,
    allowedScope: ["package.json", "app/page.tsx", "app/layout.tsx", "app/globals.css", "tsconfig.json"],
    expandedScope: [],
    authActive: false,
    prismaActive: false,
  })

  console.log("Final invariant result ok:", finalInvariantResult.ok)
  assert.strictEqual(finalInvariantResult.ok, true, "Final invariant check on synchronized workingFiles MUST PASS")
  assert.strictEqual(finalInvariantResult.hardFailures.length, 0, "No hard failures allowed")
  console.log("-> Proved: Invariant PASS with synchronized workingFiles")

  console.log("\n=== ALL REGRESSION ASSERTIONS PASSED ===")
}

runRegressionTest().catch(err => {
  console.error("Regression test failed:", err)
  process.exit(1)
})

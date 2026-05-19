const http = require("node:http")
const fs = require("node:fs")
const path = require("node:path")
const ts = require("typescript")
const { chromium } = require("playwright")

const root = process.cwd()
const sourcePath = path.join(root, "lib", "sandbox", "runtime-smoke.ts")
const source = fs.readFileSync(sourcePath, "utf8")

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

assert(/dynamicImport\("playwright"\)/.test(source), "runtime smoke validator must load Playwright dynamically")
assert(/page\.goto\(/.test(source), "runtime smoke validator must execute page.goto")
assert(fs.existsSync(chromium.executablePath()), `Chromium binary is missing: ${chromium.executablePath()}`)

const compiled = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2020,
    esModuleInterop: true,
  },
  fileName: sourcePath,
}).outputText

const runtimeModule = { exports: {} }
new Function("exports", "module", "require", compiled)(runtimeModule.exports, runtimeModule, require)

const { verifyRuntimeSmoke } = runtimeModule.exports
assert(typeof verifyRuntimeSmoke === "function", "verifyRuntimeSmoke export was not loaded")

const files = [
  {
    path: "app/page.tsx",
    content: "export default function Page() { return <main>Runtime smoke home</main> }",
  },
  {
    path: "app/about/page.tsx",
    content: "export default function Page() { return <main>Runtime smoke about</main> }",
  },
  {
    path: "app/api/ping/route.ts",
    content: "export async function GET() { return Response.json({ ok: true }) }",
  },
]

const server = http.createServer((request, response) => {
  if (request.url === "/api/ping") {
    response.writeHead(200, { "content-type": "application/json" })
    response.end(JSON.stringify({ ok: true }))
    return
  }

  response.writeHead(200, { "content-type": "text/html" })
  response.end(`<!doctype html><html><body><main>Runtime smoke ${request.url}</main></body></html>`)
})

async function main() {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  const previewUrl = `http://127.0.0.1:${address.port}`

  try {
    const result = await verifyRuntimeSmoke({ previewUrl, files })
    if (!result.ok) {
      console.error(JSON.stringify(result, null, 2))
      throw new Error(result.error || result.failureCategory || "runtime smoke failed")
    }

    console.log(JSON.stringify({
      runtimeSmoke: "passed",
      rootCause: null,
      checks: result.checks.map((check) => check.name),
    }))
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})

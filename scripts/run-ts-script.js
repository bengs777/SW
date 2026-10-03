const fs = require("node:fs")
const path = require("node:path")
const ts = require("typescript")

const root = process.cwd()
const entry = process.argv[2]

function loadEnvFile(file) {
  try {
    const raw = fs.readFileSync(path.join(root, file), "utf8")
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith("#")) continue
      const eq = trimmed.indexOf("=")
      if (eq <= 0) continue
      const key = trimmed.slice(0, eq).trim()
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue
      if (process.env[key] !== undefined) continue
      let value = trimmed.slice(eq + 1).trim()
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1)
      }
      process.env[key] = value
    }
  } catch {
    // file optional
  }
}

loadEnvFile(".env")
loadEnvFile(".env.local")

if (!entry) {
  console.error("Usage: node scripts/run-ts-script.js <script.ts> [...args]")
  process.exit(1)
}

function compileTypeScript(module, filename) {
  const source = fs.readFileSync(filename, "utf8")
  const output = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
      jsx: ts.JsxEmit.ReactJSX,
      moduleResolution: ts.ModuleResolutionKind.NodeJs,
      resolveJsonModule: true,
    },
    fileName: filename,
  }).outputText

  module._compile(output, filename)
}

require.extensions[".ts"] = compileTypeScript
require.extensions[".tsx"] = compileTypeScript

const Module = require("node:module")
const originalResolveFilename = Module._resolveFilename
Module._resolveFilename = function resolveFilename(request, parent, isMain, options) {
  if (request.startsWith("@/") || request.startsWith("~/")) {
    const rest = request.slice(2)
    const candidates = [path.resolve(root, "src", rest), path.resolve(root, rest)]
    let firstError
    for (const candidate of candidates) {
      try {
        return originalResolveFilename.call(this, candidate, parent, isMain, options)
      } catch (error) {
        if (!firstError) firstError = error
      }
    }
    throw firstError
  }
  return originalResolveFilename.call(this, request, parent, isMain, options)
}

process.argv = [process.argv[0], path.resolve(entry), ...process.argv.slice(3)]
require(path.resolve(entry))

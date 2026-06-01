const fs = require("node:fs")
const path = require("node:path")
const ts = require("typescript")

const root = process.cwd()
const entry = process.argv[2]

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
  if (request.startsWith("@/")) {
    return originalResolveFilename.call(this, path.join(root, request.slice(2)), parent, isMain, options)
  }
  if (request.startsWith("~/")) {
    return originalResolveFilename.call(this, path.join(root, request.slice(2)), parent, isMain, options)
  }
  return originalResolveFilename.call(this, request, parent, isMain, options)
}

process.argv = [process.argv[0], path.resolve(entry), ...process.argv.slice(3)]
require(path.resolve(entry))

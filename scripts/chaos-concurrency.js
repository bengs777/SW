const path = require("node:path")

process.argv = [process.argv[0], process.argv[1], path.resolve(__dirname, "chaos-concurrency.ts"), ...process.argv.slice(3)]

require("./run-ts-script.js")

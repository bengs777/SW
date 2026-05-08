const { loadEnvConfig } = require('@next/env')

loadEnvConfig(process.cwd())

const args = new Set(process.argv.slice(2))
const jsonMode = args.has('--json')
const strictMode = args.has('--strict')

function getLineAndColumn(text, index) {
  const safeIndex = Math.max(0, Math.min(index, text.length))
  const prefix = text.slice(0, safeIndex)
  const lines = prefix.split('\n')
  const line = lines.length
  const column = (lines[lines.length - 1] || '').length + 1
  return { line, column }
}

async function main() {
  const { PrismaClient } = require('@prisma/client')
  const { PrismaLibSQL } = require('@prisma/adapter-libsql')
  const { createClient } = require('@libsql/client')

  const databaseUrl = process.env.TURSO_DATABASE_URL || ''
  if (!databaseUrl) {
    throw new Error('TURSO_DATABASE_URL is required')
  }

  const prisma = new PrismaClient({
    adapter: new PrismaLibSQL(
      createClient({
        url: databaseUrl,
        authToken: process.env.TURSO_AUTH_TOKEN || undefined,
      })
    ),
    log: ['warn', 'error'],
  })
  try {
    const histories = await prisma.generationHistory.findMany({ orderBy: { createdAt: 'desc' }, take: 100 })
    if (!histories || histories.length === 0) {
      const empty = {
        ok: true,
        strict: strictMode,
        scannedHistories: 0,
        parseFailures: 0,
        scannedCodeFiles: 0,
        flaggedHistories: 0,
        flaggedFiles: 0,
        findings: [],
      }
      if (jsonMode) {
        console.log(JSON.stringify(empty, null, 2))
      } else {
        console.log('No generation histories')
      }
      return
    }

    const codePathPattern = /\.(tsx|ts|jsx|js|mjs|cjs|html|css)$/i

    function findInvalidObjectLiteralPatterns(content) {
      const src = String(content || '')
      const findings = []

      // key,123  | key,+8.1%  (likely missing ':')
      const numericPattern = /([,{]\s*)([A-Za-z_$][\w$]*)\s*,\s*([+\-]?\d[\d,]*(?:\.\d+)?%?)(?=\s*[,}\]])/g
      // key,"text" | key,'text' (likely missing ':')
      const stringPattern = /([,{]\s*)([A-Za-z_$][\w$]*)\s*,\s*("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')(?=\s*[,}\]])/g
      // key,{ ... } or key,[ ... ] (likely missing ':')
      const structurePattern = /([,{]\s*)([A-Za-z_$][\w$]*)\s*,\s*([\[{])/g
      // key,481' or key,481" (broken quote tail)
      const brokenTailQuotePattern = /([,{]\s*)([A-Za-z_$][\w$]*)\s*,\s*([+\-]?\d[\d,]*(?:\.\d+)?)(['"])(?=\s*[,}\]])/g

      const patterns = [
        { kind: 'numeric', re: numericPattern },
        { kind: 'string', re: stringPattern },
        { kind: 'structure', re: structurePattern },
        { kind: 'broken-tail-quote', re: brokenTailQuotePattern },
      ]

      for (const p of patterns) {
        let m
        while ((m = p.re.exec(src)) !== null) {
          findings.push({
            kind: p.kind,
            index: m.index,
            match: m[0],
          })
        }
      }

      findings.sort((a, b) => a.index - b.index)
      return findings
    }

    let flaggedFiles = 0
    let flaggedHistories = 0
    let scannedCodeFiles = 0
    let parseFailures = 0
    const outputFindings = []

    for (const h of histories) {
      let files
      try { files = JSON.parse(h.result) } catch (e) {
        parseFailures += 1
        continue
      }

      let hasFlagInHistory = false
      for (const f of files) {
        const filePath = String(f.path || '')
        if (!codePathPattern.test(filePath)) {
          continue
        }

        scannedCodeFiles += 1

        const content = String(f.content || '')
        const findings = findInvalidObjectLiteralPatterns(content)

        if (findings.length > 0) {
          hasFlagInHistory = true
          flaggedFiles += 1

          for (const finding of findings) {
            const loc = getLineAndColumn(content, finding.index)
            const start = Math.max(0, finding.index - 120)
            const end = Math.min(content.length, finding.index + 260)
            outputFindings.push({
              historyId: h.id,
              projectId: h.projectId,
              filePath,
              kind: finding.kind,
              pattern: finding.match,
              line: loc.line,
              column: loc.column,
              snippet: content.slice(start, end),
            })
          }

          if (!jsonMode) {
            console.log(`History ${h.id} project ${h.projectId} file ${filePath} appears suspicious`)
            console.log('--- snippet ---')
            const first = findings[0]
            const idx = Math.max(0, first.index)
            const loc = getLineAndColumn(content, idx)
            console.log(`reason=${first.kind} line=${loc.line} col=${loc.column} pattern=${first.match.replace(/\s+/g, ' ').slice(0, 120)}`)
            console.log(content.slice(Math.max(0, idx - 120), Math.min(content.length, idx + 260)))
            console.log('--------------')
          }
        }
      }

      if (hasFlagInHistory) {
        flaggedHistories += 1
      }
    }

    const summary = {
      ok: flaggedFiles === 0,
      strict: strictMode,
      scannedHistories: histories.length,
      parseFailures,
      scannedCodeFiles,
      flaggedHistories,
      flaggedFiles,
      findings: outputFindings,
    }

    if (jsonMode) {
      console.log(JSON.stringify(summary, null, 2))
    } else if (flaggedFiles === 0) {
      console.log('No invalid object-literal patterns found in code files.')
    } else {
      console.log(`Summary: flagged ${flaggedFiles} file(s) across ${flaggedHistories} history item(s).`)
    }

    if (strictMode && flaggedFiles > 0) {
      if (!jsonMode) {
        console.error('Strict mode failed: invalid object-literal pattern(s) detected.')
      }
      process.exitCode = 2
    }
  } finally {
    await prisma.$disconnect()
  }
}

main().catch((e) => { console.error(e); process.exit(1) })

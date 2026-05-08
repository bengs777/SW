const { loadEnvConfig } = require('@next/env')

loadEnvConfig(process.cwd())

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
      console.log('No generation history found.')
      return
    }

    console.log(`Scanning ${histories.length} generation history entries...`)

    // Sanitizers
    function escapeForString(s) {
      return String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"')
    }

    function findMatchingBracket(src, start) {
      let depth = 0
      let inString = null
      for (let i = start; i < src.length; i++) {
        const ch = src[i]
        if (inString) {
          if (ch === '\\' && i + 1 < src.length) {
            i++
            continue
          }
          if (ch === inString) {
            inString = null
          }
          continue
        }
        if (ch === '"' || ch === "'" || ch === '`') {
          inString = ch
          continue
        }
        if (ch === '[') {
          depth++
          continue
        }
        if (ch === ']') {
          depth--
          if (depth === 0) return i
        }
      }
      return -1
    }

    function sanitizeInlineArrays(input) {
      const src = String(input)
      let out = src
      const declRegex = /(?:const|let|var)\s+([A-Za-z_$][\\w$]*)\s*=\s*\[/g
      let m
      const replacements = []

      while ((m = declRegex.exec(src)) !== null) {
        const varName = m[1]
        const bracketPos = src.indexOf('[', m.index)
        if (bracketPos === -1) continue
        const endPos = findMatchingBracket(src, bracketPos)
        if (endPos === -1) continue

        const arrayContent = src.slice(bracketPos + 1, endPos)
        if (!/label\s*(?::|,)/i.test(arrayContent)) continue

        const labelRegex = /label\s*(?::|,)\s*["']([^"']+)["']/gi
        const labels = []
        let lm
        while ((lm = labelRegex.exec(arrayContent)) !== null) {
          labels.push(lm[1])
        }

        if (labels.length === 0) continue

        const items = labels.map((lab) => `  { label: "${escapeForString(lab)}", value: "0", trend: "0%" }`)
        const sanitizedArray = `[\n${items.join(',\n')}\n]`

        const before = src.slice(m.index, src.indexOf('[', m.index) + 1)
        const replacementText = before + sanitizedArray
        replacements.push({ start: m.index, end: endPos + 1, text: replacementText })
      }

      if (replacements.length > 0) {
        replacements.sort((a, b) => b.start - a.start)
        for (const r of replacements) {
          out = out.slice(0, r.start) + r.text + out.slice(r.end)
        }
      }

      return out
    }

    function repairCommonObjectLiteralMistakes(input) {
      let out = String(input)
      const keys = ['value', 'trend', 'label', 'title', 'orders', 'revenue', 'count', 'amount', 'total', 'percent', 'change']
      const keyPattern = keys.join('|')

      // key, 'str' or key, "str"
      out = out.replace(new RegExp(`\\b(${keyPattern})\\s*,\\s*["']([^"']+)["']`, 'gi'), '$1: "$2"')

      // key, 2,481 -> key: "2,481"
      out = out.replace(new RegExp(`\\b(${keyPattern})\\s*,\\s*([+\\-]?\\d{1,3}(?:,\\d{3})*(?:\\.\\d+)?%?)`, 'gi'), '$1: "$2"')

      // Generic quoted string fix: id, 'str' -> id: "str"
      out = out.replace(/(\b[A-Za-z_$][\\w$]*)\s*,\s*'([^']*)'/g, '$1: "$2"')
      out = out.replace(/(\b[A-Za-z_$][\\w$]*)\s*,\s*"([^"]*)"/g, '$1: "$2"')

      // Generic numeric fix for identifier,number -> id: "number"
      out = out.replace(/(\b[A-Za-z_$][\\w$]*)\s*,\s*([+\-]?\d{1,3}(?:,\d{3})*(?:\.\d+)?%?)/g, '$1: "$2"')

      // Tidy up stray patterns like value,481' (missing quote closing)
      out = out.replace(new RegExp(`\\b(${keyPattern})\\s*,\\s*([0-9,]+)'`, 'gi'), '$1: "$2"')

      return out
    }

    function sanitizeContent(content) {
      let s = String(content)
      // Apply inline-array sanitizer first
      try {
        s = sanitizeInlineArrays(s)
      } catch (e) {
        // ignore
      }
      try {
        s = repairCommonObjectLiteralMistakes(s)
      } catch (e) {}
      return s
    }

    for (const history of histories) {
      let files
      try {
        files = JSON.parse(history.result)
      } catch (e) {
        continue
      }

      if (!Array.isArray(files) || files.length === 0) continue

      const updatesForHistory = []

      for (const file of files) {
        const original = String(file.content || '')
        const sanitized = sanitizeContent(original)
        if (sanitized !== original) {
          updatesForHistory.push({ path: file.path, original, sanitized })
        }
      }

      if (updatesForHistory.length === 0) continue

      console.log(`Applying ${updatesForHistory.length} fixes for history ${history.id} (project ${history.projectId})`)

      for (const u of updatesForHistory) {
        try {
          const res = await prisma.projectFile.updateMany({
            where: { projectId: history.projectId, path: u.path },
            data: { content: u.sanitized },
          })
          console.log(`Updated projectFile ${u.path}:`, res)
        } catch (e) {
          console.error(`Failed to update projectFile for ${u.path}:`, e.message)
        }
      }

      // Update generationHistory.result for this history
      try {
        const newResult = files.map((file) => {
          const found = updatesForHistory.find((x) => x.path === file.path)
          return found ? { ...file, content: found.sanitized } : file
        })
        await prisma.generationHistory.update({ where: { id: history.id }, data: { result: JSON.stringify(newResult) } })
        console.log(`Updated generationHistory.result for ${history.id}`)
      } catch (e) {
        console.error('Failed to update generationHistory:', e.message)
      }
    }

    console.log('Done scanning and applying fixes.')
  } finally {
    await prisma.$disconnect()
  }
}

main().catch((err) => {
  console.error('Script error:', err)
  process.exit(1)
})

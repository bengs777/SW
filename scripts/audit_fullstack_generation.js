const fs = require('node:fs')
const path = require('node:path')
const { loadEnvConfig } = require('@next/env')

loadEnvConfig(process.cwd())

const args = process.argv.slice(2)
const jsonMode = args.includes('--json')
const strictMode = args.includes('--strict')

function readArg(name) {
  const index = args.indexOf(name)
  if (index === -1) return ''
  return args[index + 1] || ''
}

function normalizePath(value) {
  return String(value || '').replace(/\\/g, '/').replace(/^\.\//, '').trim()
}

function inferLanguage(filePath) {
  const lower = filePath.toLowerCase()
  if (lower.endsWith('.tsx')) return 'tsx'
  if (lower.endsWith('.ts')) return 'ts'
  if (lower.endsWith('.css')) return 'css'
  if (lower.endsWith('.json')) return 'json'
  if (lower.endsWith('.prisma')) return 'prisma'
  if (lower.endsWith('.md')) return 'md'
  if (lower.endsWith('.env')) return 'env'
  return 'txt'
}

function walkFiles(rootDir) {
  const root = path.resolve(rootDir)
  const out = []
  const ignored = new Set(['node_modules', '.next', '.git', 'dist', 'build'])

  function visit(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (ignored.has(entry.name)) continue
      const absolute = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        visit(absolute)
        continue
      }

      const relative = normalizePath(path.relative(root, absolute))
      if (!/\.(tsx|ts|css|json|prisma|md|env|mjs|js)$/i.test(relative) && path.basename(relative) !== '.env.example') {
        continue
      }

      out.push({
        path: relative,
        language: inferLanguage(relative),
        content: fs.readFileSync(absolute, 'utf8'),
      })
    }
  }

  visit(root)
  return out
}

async function loadHistoryFiles() {
  const projectId = readArg('--project-id')
  const { PrismaClient } = require('@prisma/client')

  const databaseUrl = process.env.DATABASE_URL || ''
  if (!/^postgres(?:ql)?:\/\//i.test(databaseUrl)) {
    throw new Error('DATABASE_URL must be a PostgreSQL connection string for --history mode')
  }

  const prisma = new PrismaClient({
    log: ['warn', 'error'],
  })

  try {
    const history = await prisma.generationHistory.findFirst({
      where: projectId ? { projectId } : undefined,
      orderBy: { createdAt: 'desc' },
    })

    if (!history) {
      throw new Error(projectId ? `No generation history found for project ${projectId}` : 'No generation history found')
    }

    const parsed = JSON.parse(history.result)
    return {
      source: `history:${history.id}`,
      files: Array.isArray(parsed) ? parsed : [],
    }
  } finally {
    await prisma.$disconnect()
  }
}

function fileByPath(files, pattern) {
  return files.filter((file) => pattern.test(normalizePath(file.path)))
}

function hasAny(files, pattern) {
  return files.some((file) => pattern.test(file.content))
}

function hasTodoModel(schema) {
  return /model\s+Todo\s*\{[\s\S]*?\}/i.test(schema)
}

function hasUserModel(schema) {
  return /model\s+User\s*\{[\s\S]*?\}/i.test(schema)
}

function audit(files, source) {
  const normalizedFiles = files.map((file) => ({
    path: normalizePath(file.path),
    content: String(file.content || ''),
    language: file.language || inferLanguage(file.path),
  }))
  const prismaFiles = fileByPath(normalizedFiles, /^prisma\/schema\.prisma$/i)
  const apiTodoFiles = fileByPath(normalizedFiles, /^app\/api\/.*todo.*\/route\.ts$/i)
  const frontendFiles = fileByPath(normalizedFiles, /^app\/(?:.+\/)?page\.tsx$/i)
  const schema = prismaFiles.map((file) => file.content).join('\n')
  const apiText = apiTodoFiles.map((file) => file.content).join('\n')
  const frontendText = frontendFiles.map((file) => file.content).join('\n')

  const checks = [
    {
      key: 'prisma_schema',
      label: 'Prisma schema has User and Todo models',
      pass: prismaFiles.length > 0 && hasUserModel(schema) && hasTodoModel(schema),
      evidence: prismaFiles.map((file) => file.path),
    },
    {
      key: 'todo_api_crud',
      label: 'Todo API exposes create, list, and delete handlers',
      pass:
        apiTodoFiles.length > 0 &&
        /export\s+async\s+function\s+GET\s*\(/.test(apiText) &&
        /export\s+async\s+function\s+POST\s*\(/.test(apiText) &&
        /export\s+async\s+function\s+DELETE\s*\(/.test(apiText),
      evidence: apiTodoFiles.map((file) => file.path),
    },
    {
      key: 'api_uses_prisma',
      label: 'Todo API uses Prisma instead of local arrays',
      pass:
        /\bprisma\.todo\.(findMany|create|delete|deleteMany|update)/i.test(apiText) &&
        !/(const|let|var)\s+todos\s*=\s*\[/i.test(apiText),
      evidence: apiTodoFiles.map((file) => file.path),
    },
    {
      key: 'frontend_fetches_api',
      label: 'Frontend fetches todo data from API',
      pass: /fetch\s*\(\s*['"`][^'"`]*\/api\/[^'"`]*todo/i.test(frontendText),
      evidence: frontendFiles.map((file) => file.path),
    },
    {
      key: 'frontend_not_local_only',
      label: 'Frontend is not local-state-only for todo source of truth',
      pass:
        /fetch\s*\(\s*['"`][^'"`]*\/api\/[^'"`]*todo/i.test(frontendText) &&
        !/setTodos\s*\(\s*\[\s*\.{3}\s*todos\s*,/i.test(frontendText),
      evidence: frontendFiles.map((file) => file.path),
    },
    {
      key: 'user_scoped_todos',
      label: 'Todo queries appear scoped to current user',
      pass: /userId|user\.id|session\.user|ownerId|createdById/i.test(apiText),
      evidence: apiTodoFiles.map((file) => file.path),
    },
    {
      key: 'backend_filter',
      label: 'Status filter is implemented in backend query',
      pass:
        /searchParams|get\(['"`](status|done|completed)['"`]\)/i.test(apiText) &&
        /where\s*:\s*\{[\s\S]*(done|completed|status)/i.test(apiText),
      evidence: apiTodoFiles.map((file) => file.path),
    },
    {
      key: 'frontend_sends_filter',
      label: 'Frontend sends filter state to API',
      pass:
        /(status|filter|done|completed)/i.test(frontendText) &&
        /fetch\s*\(\s*[`"][^`"]*\?/i.test(frontendText),
      evidence: frontendFiles.map((file) => file.path),
    },
    {
      key: 'edit_todo_api',
      label: 'Edit todo support uses API update handler',
      pass:
        /export\s+async\s+function\s+PATCH\s*\(/.test(apiText) &&
        /\bprisma\.todo\.update/i.test(apiText),
      evidence: apiTodoFiles.map((file) => file.path),
    },
    {
      key: 'env_and_deps',
      label: 'Project includes env/dependency hints needed to run',
      pass:
        hasAny(fileByPath(normalizedFiles, /(^|\/)\.env\.example$/i), /DATABASE_URL|NEXTAUTH_SECRET|AUTH_SECRET/i) &&
        hasAny(fileByPath(normalizedFiles, /(^|\/)package\.json$/i), /@prisma\/client|prisma|next-auth|bcrypt/i),
      evidence: fileByPath(normalizedFiles, /(^|\/)(\.env\.example|package\.json)$/i).map((file) => file.path),
    },
  ]

  const failed = checks.filter((check) => !check.pass)
  const scorecard = {
    fullStackReal: checks.slice(0, 6).every((check) => check.pass),
    integration: checks.slice(6, 8).every((check) => check.pass),
    editConsistency: checks.find((check) => check.key === 'edit_todo_api')?.pass || false,
    sandboxRecoverySignals: checks.find((check) => check.key === 'env_and_deps')?.pass || false,
  }

  return {
    ok: failed.length === 0,
    source,
    fileCount: normalizedFiles.length,
    checks,
    scorecard,
    failedCount: failed.length,
    failedKeys: failed.map((check) => check.key),
    note: 'Refresh persistence, error-fixing behavior, and no-regeneration behavior still require runtime/manual verification.',
  }
}

function printReport(report) {
  if (jsonMode) {
    console.log(JSON.stringify(report, null, 2))
    return
  }

  console.log(`Source: ${report.source}`)
  console.log(`Files scanned: ${report.fileCount}`)
  console.log('')
  for (const check of report.checks) {
    console.log(`${check.pass ? 'PASS' : 'FAIL'} - ${check.label}`)
    if (check.evidence.length > 0) {
      console.log(`  evidence: ${check.evidence.join(', ')}`)
    }
  }
  console.log('')
  console.log('Scorecard:')
  console.log(`- Full-stack real: ${report.scorecard.fullStackReal ? 'PASS' : 'FAIL'}`)
  console.log(`- Integration: ${report.scorecard.integration ? 'PASS' : 'FAIL'}`)
  console.log(`- Edit consistency signal: ${report.scorecard.editConsistency ? 'PASS' : 'FAIL'}`)
  console.log(`- Sandbox recovery signal: ${report.scorecard.sandboxRecoverySignals ? 'PASS' : 'FAIL'}`)
  console.log('')
  console.log(report.note)
}

async function main() {
  const dir = readArg('--dir')
  const historyMode = args.includes('--history')

  let source = ''
  let files = []

  if (dir) {
    source = `dir:${path.resolve(dir)}`
    files = walkFiles(dir)
  } else if (historyMode) {
    const loaded = await loadHistoryFiles()
    source = loaded.source
    files = loaded.files
  } else {
    throw new Error('Usage: npm run audit:fullstack -- --dir ./exported-project OR --history latest [--project-id id]')
  }

  const report = audit(files, source)
  printReport(report)

  if (strictMode && !report.ok) {
    process.exitCode = 2
  }
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})

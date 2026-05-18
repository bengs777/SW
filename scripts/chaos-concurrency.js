const { PrismaClient } = require("@prisma/client")
const crypto = require("node:crypto")

function loadEnvFile(path) {
  const fs = require("node:fs")
  if (!fs.existsSync(path)) return
  for (const line of fs.readFileSync(path, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith("#")) continue
    const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/)
    if (!match) continue
    const key = match[1]
    if (process.env[key]) continue
    process.env[key] = match[2].trim().replace(/^['"]|['"]$/g, "")
  }
}

loadEnvFile(".env.production")
loadEnvFile(".env")

process.env.DATABASE_URL = process.env.SWIFT_LOCAL_DATABASE_URL || process.env.DATABASE_URL || ""

if (!/^postgres(?:ql)?:\/\//i.test(process.env.DATABASE_URL)) {
  throw new Error("DATABASE_URL or SWIFT_LOCAL_DATABASE_URL must be a PostgreSQL connection string")
}

const prisma = new PrismaClient({
  log: ["warn", "error"],
})

const runId = `chaos-${Date.now()}`
const cost = 3000
const concurrency = Math.min(100, Math.max(5, Math.round(Number(process.env.CHAOS_CONCURRENCY || 50))))

function normalizePath(value) {
  return String(value || "").replace(/\\/g, "/").replace(/^\/+/, "").replace(/^\.\//, "").trim()
}

function buildManifest(files) {
  const normalized = files
    .map((file) => ({
      path: normalizePath(file.path),
      content: String(file.content || ""),
      language: String(file.language || "tsx"),
    }))
    .sort((left, right) => left.path.localeCompare(right.path))
  const hash = crypto.createHash("sha256")
  const fileHashes = {}
  let totalBytes = 0

  for (const file of normalized) {
    const contentHash = crypto.createHash("sha256").update(file.content).digest("hex")
    const fileHash = crypto
      .createHash("sha256")
      .update(file.path)
      .update("\0")
      .update(file.language)
      .update("\0")
      .update(contentHash)
      .digest("hex")
    fileHashes[file.path] = fileHash
    totalBytes += Buffer.byteLength(file.content, "utf8")
    hash.update(file.path)
    hash.update("\0")
    hash.update(file.language)
    hash.update("\0")
    hash.update(fileHash)
    hash.update("\0")
  }

  return {
    count: normalized.length,
    totalBytes,
    sha256: hash.digest("hex"),
    paths: normalized.map((file) => file.path),
    fileHashes,
  }
}

async function syncProjectFiles(tx, projectId, files) {
  const normalized = files
    .map((file) => ({
      path: normalizePath(file.path),
      content: String(file.content || ""),
      language: String(file.language || "tsx"),
    }))
    .sort((left, right) => left.path.localeCompare(right.path))
  const nextPaths = normalized.map((file) => file.path)
  const existingFiles = await tx.projectFile.findMany({
    where: { projectId },
    select: { id: true, path: true, content: true, language: true },
  })
  const existingByPath = new Map(existingFiles.map((file) => [file.path, file]))

  for (const file of normalized) {
    const existing = existingByPath.get(file.path)
    if (!existing) {
      await tx.projectFile.create({
        data: {
          projectId,
          path: file.path,
          content: file.content,
          language: file.language,
        },
      })
      continue
    }

    if (existing.content !== file.content || existing.language !== file.language) {
      await tx.projectFile.update({
        where: { id: existing.id },
        data: {
          content: file.content,
          language: file.language,
        },
      })
    }
  }

  const stalePaths = existingFiles.map((file) => file.path).filter((filePath) => !nextPaths.includes(filePath))
  if (stalePaths.length > 0) {
    await tx.projectFile.deleteMany({
      where: {
        projectId,
        path: { in: stalePaths },
      },
    })
  }

  const persisted = await tx.projectFile.findMany({
    where: { projectId },
    orderBy: { path: "asc" },
  })
  const expectedManifest = buildManifest(normalized)
  const actualManifest = buildManifest(persisted)
  if (expectedManifest.sha256 !== actualManifest.sha256) {
    throw new Error(`MANIFEST_MISMATCH expected=${expectedManifest.sha256} actual=${actualManifest.sha256}`)
  }
  return actualManifest
}

async function guardedPersist({ projectId, generationJobId, idempotencyKey, prompt, files }) {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${projectId}))`
    const currentJob = await tx.generationJob.findUnique({
      where: { id: generationJobId },
      select: { id: true, createdAt: true },
    })
    if (!currentJob) throw new Error("Generation job not found")

    const newerJob = await tx.generationJob.findFirst({
      where: {
        projectId,
        createdAt: { gt: currentJob.createdAt },
        status: { notIn: ["failed", "cancelled"] },
      },
      select: { id: true, status: true, stage: true },
    })
    if (newerJob) {
      throw new Error(`StaleGenerationRejected: newer generation ${newerJob.id} is ${newerJob.status}/${newerJob.stage}`)
    }

    const history = await tx.generationHistory.upsert({
      where: {
        projectId_idempotencyKey: {
          projectId,
          idempotencyKey,
        },
      },
      create: {
        projectId,
        idempotencyKey,
        prompt,
        result: JSON.stringify(files),
      },
      update: {
        prompt,
        result: JSON.stringify(files),
      },
    })
    const manifest = await syncProjectFiles(tx, projectId, files)
    return { historyId: history.id, manifest }
  })
}

async function reserveGeneration({ userId, projectId, modelConfigId, requestHash }) {
  return prisma.$transaction(async (tx) => {
    const job = await tx.generationJob.create({
      data: {
        userId,
        projectId,
        prompt: "chaos double-click prompt",
        model: "chaos-model",
        provider: "swift",
        requestHash,
        status: "queued",
        stage: "queued",
        label: "Prompt diterima",
        progress: 0,
        contextJson: JSON.stringify({ requestHash }),
      },
    })

    const user = await tx.user.findUnique({
      where: { id: userId },
      select: { balance: true },
    })

    if (!user) throw new Error("USER_NOT_FOUND")
    if (user.balance < cost) throw new Error("INSUFFICIENT_BALANCE")

    const claimed = await tx.user.updateMany({
      where: {
        id: userId,
        balance: { gte: cost },
      },
      data: {
        balance: { decrement: cost },
      },
    })

    if (claimed.count !== 1) throw new Error("INSUFFICIENT_BALANCE")

    const usageLog = await tx.usageLog.create({
      data: {
        userId,
        modelConfigId,
        model: "chaos-model",
        provider: "swift",
        cost,
        prompt: "chaos double-click prompt",
        status: "reserved",
      },
    })

    await tx.billingTransaction.create({
      data: {
        userId,
        kind: "usage",
        direction: "debit",
        amount: cost,
        balanceBefore: user.balance,
        balanceAfter: user.balance - cost,
        reference: `usage:${usageLog.id}`,
        provider: "swift",
        providerReference: usageLog.id,
        description: "Chaos reservation",
      },
    })

    await tx.generationEvent.create({
      data: {
        jobId: job.id,
        sequence: 1,
        type: "job.created",
        stage: "queued",
        status: "queued",
        message: "Generation job queued",
      },
    })

    return { job, usageLog }
  })
}

async function refundReservation({ usageLogId, userId }) {
  return prisma.$transaction(async (tx) => {
    const usageLog = await tx.usageLog.findUnique({
      where: { id: usageLogId },
      select: { id: true, status: true, userId: true, cost: true, refundedAt: true },
    })

    if (!usageLog) throw new Error("USAGE_NOT_FOUND")
    if (usageLog.userId !== userId) throw new Error("USAGE_USER_MISMATCH")
    if (usageLog.status === "completed" || usageLog.status === "refunded") return false

    const claimed = await tx.usageLog.updateMany({
      where: {
        id: usageLogId,
        status: { in: ["reserved", "pending", "failed"] },
        refundedAt: null,
      },
      data: {
        status: "refunding",
        errorMessage: "Chaos refund",
      },
    })

    if (claimed.count !== 1) return false

    const user = await tx.user.findUnique({
      where: { id: userId },
      select: { balance: true },
    })
    if (!user) throw new Error("USER_NOT_FOUND")

    await tx.user.update({
      where: { id: userId },
      data: { balance: { increment: usageLog.cost } },
    })

    await tx.billingTransaction.create({
      data: {
        userId,
        kind: "refund",
        direction: "credit",
        amount: usageLog.cost,
        balanceBefore: user.balance,
        balanceAfter: user.balance + usageLog.cost,
        reference: `refund:${usageLogId}`,
        provider: "internal",
        providerReference: usageLogId,
        description: "Chaos refund",
      },
    })

    await tx.usageLog.update({
      where: { id: usageLogId },
      data: {
        status: "refunded",
        refundedAt: new Date(),
        errorMessage: "Chaos refund",
      },
    })

    return true
  })
}

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

async function main() {
  const user = await prisma.user.create({
    data: {
      email: `${runId}@swift-chaos.local`,
      name: "Chaos User",
      balance: cost * concurrency,
    },
  })
  const workspace = await prisma.workspace.create({
    data: {
      name: "Chaos Workspace",
      slug: runId,
      createdBy: user.id,
    },
  })
  await prisma.workspaceMember.create({
    data: {
      userId: user.id,
      workspaceId: workspace.id,
      role: "admin",
    },
  })
  const project = await prisma.project.create({
    data: {
      workspaceId: workspace.id,
      name: "Chaos Project",
    },
  })
  const modelConfig = await prisma.modelConfig.upsert({
    where: { key: "chaos-model" },
    create: {
      key: "chaos-model",
      provider: "swift",
      modelName: "chaos-model",
      price: cost,
      isActive: true,
    },
    update: {
      price: cost,
      isActive: true,
    },
  })

  const requestHash = `${runId}:same-request`
  const reservations = await Promise.allSettled(
    Array.from({ length: concurrency }, () =>
      reserveGeneration({ userId: user.id, projectId: project.id, modelConfigId: modelConfig.id, requestHash })
    )
  )
  const fulfilled = reservations.filter((item) => item.status === "fulfilled")
  const rejected = reservations.filter((item) => item.status === "rejected")

  assert(fulfilled.length === 1, `Expected one reservation, got ${fulfilled.length}`)
  assert(rejected.length === concurrency - 1, `Expected ${concurrency - 1} deduped rejections, got ${rejected.length}`)

  const [reservation] = fulfilled.map((item) => item.value)
  const afterReserve = await prisma.user.findUnique({ where: { id: user.id }, select: { balance: true } })
  assert(afterReserve?.balance === cost * (concurrency - 1), `Expected one debit, balance=${afterReserve?.balance}`)

  await Promise.allSettled([
    refundReservation({ usageLogId: reservation.usageLog.id, userId: user.id }),
    refundReservation({ usageLogId: reservation.usageLog.id, userId: user.id }),
  ])
  const afterRefund = await prisma.user.findUnique({ where: { id: user.id }, select: { balance: true } })
  assert(afterRefund?.balance === cost * concurrency, `Expected exactly one refund, balance=${afterRefund?.balance}`)

  const refundCount = await prisma.billingTransaction.count({
    where: {
      userId: user.id,
      kind: "refund",
      reference: `refund:${reservation.usageLog.id}`,
    },
  })
  assert(refundCount === 1, `Expected one refund transaction, got ${refundCount}`)

  const persistenceKey = `${runId}:persistence`
  const persistenceAttempts = await Promise.allSettled([
    prisma.generationHistory.upsert({
      where: {
        projectId_idempotencyKey: {
          projectId: project.id,
          idempotencyKey: persistenceKey,
        },
      },
      create: {
        projectId: project.id,
        idempotencyKey: persistenceKey,
        prompt: "chaos persistence",
        result: "[]",
      },
      update: {
        result: "[]",
      },
    }),
    prisma.generationHistory.upsert({
      where: {
        projectId_idempotencyKey: {
          projectId: project.id,
          idempotencyKey: persistenceKey,
        },
      },
      create: {
        projectId: project.id,
        idempotencyKey: persistenceKey,
        prompt: "chaos persistence",
        result: "[]",
      },
      update: {
        result: "[]",
      },
    }),
  ])
  const persistenceFulfilled = persistenceAttempts.filter((item) => item.status === "fulfilled")
  assert(persistenceFulfilled.length >= 1, "Expected at least one persistence replay attempt to succeed")

  const historyCount = await prisma.generationHistory.count({
    where: {
      projectId: project.id,
      idempotencyKey: persistenceKey,
    },
  })
  assert(historyCount === 1, `Expected one generation history replay record, got ${historyCount}`)

  await prisma.$transaction(async (tx) => {
    await tx.projectFile.create({
      data: {
        projectId: project.id,
        path: "app/partial-write-should-rollback.tsx",
        content: "export default function Broken(){return null}",
        language: "tsx",
      },
    })
    throw new Error("SIMULATED_DB_TIMEOUT_AFTER_HALF_WRITE")
  }).catch((error) => {
    assert(/SIMULATED_DB_TIMEOUT/.test(error.message), `Unexpected rollback simulation error: ${error.message}`)
  })
  const partialWriteCount = await prisma.projectFile.count({
    where: {
      projectId: project.id,
      path: "app/partial-write-should-rollback.tsx",
    },
  })
  assert(partialWriteCount === 0, `Expected interrupted persistence transaction rollback, got ${partialWriteCount} partial files`)

  await prisma.generationJob.updateMany({
    where: { projectId: project.id },
    data: {
      status: "failed",
      stage: "failed",
      error: "Chaos setup job closed before stale-generation race",
      failedAt: new Date(),
    },
  })

  const olderJob = await prisma.generationJob.create({
    data: {
      userId: user.id,
      projectId: project.id,
      prompt: "older marketplace prompt",
      model: "chaos-model",
      provider: "swift",
      requestHash: `${runId}:older`,
      status: "running",
      stage: "persisting",
      label: "Persisting older generation",
      progress: 94,
      createdAt: new Date(Date.now() - 2_000),
    },
  })
  const newerJob = await prisma.generationJob.create({
    data: {
      userId: user.id,
      projectId: project.id,
      prompt: "newer news portal prompt",
      model: "chaos-model",
      provider: "swift",
      requestHash: `${runId}:newer`,
      status: "running",
      stage: "persisting",
      label: "Persisting newer generation",
      progress: 94,
      createdAt: new Date(Date.now() - 1_000),
    },
  })
  const olderFiles = [
    { path: "app/page.tsx", content: "export default function Page(){return <main>older</main>}", language: "tsx" },
  ]
  const newerFiles = [
    { path: "app/page.tsx", content: "export default function Page(){return <main>newer</main>}", language: "tsx" },
    { path: "components/Header.tsx", content: "export function Header(){return <header>newer</header>}", language: "tsx" },
  ]
  const persistenceRace = await Promise.allSettled([
    guardedPersist({
      projectId: project.id,
      generationJobId: olderJob.id,
      idempotencyKey: `${runId}:older-persist`,
      prompt: olderJob.prompt,
      files: olderFiles,
    }),
    guardedPersist({
      projectId: project.id,
      generationJobId: newerJob.id,
      idempotencyKey: `${runId}:newer-persist`,
      prompt: newerJob.prompt,
      files: newerFiles,
    }),
  ])
  const staleRejected = persistenceRace.some(
    (item) => item.status === "rejected" && /StaleGenerationRejected/.test(item.reason?.message || "")
  )
  const newerPersisted = persistenceRace.some(
    (item) => item.status === "fulfilled" && item.value.manifest.sha256 === buildManifest(newerFiles).sha256
  )
  assert(staleRejected, "Expected stale older generation to be rejected")
  assert(
    newerPersisted,
    `Expected newer generation to persist successfully: ${JSON.stringify(
      persistenceRace.map((item) =>
        item.status === "fulfilled"
          ? { status: item.status, manifest: item.value.manifest.sha256 }
          : { status: item.status, reason: item.reason?.message || String(item.reason) }
      )
    )}`
  )

  const finalFiles = await prisma.projectFile.findMany({
    where: { projectId: project.id },
    orderBy: { path: "asc" },
  })
  const finalManifest = buildManifest(finalFiles)
  assert(
    finalManifest.sha256 === buildManifest(newerFiles).sha256,
    `Expected final manifest to match newer job, got ${finalManifest.sha256}`
  )

  console.log(`[chaos] concurrency safety checks passed (${concurrency} simultaneous duplicate prompts)`)
  console.log("[chaos] persistence rollback and stale-generation race checks passed")
}

main()
  .finally(async () => {
    await prisma.user.deleteMany({ where: { email: `${runId}@swift-chaos.local` } }).catch(() => null)
    await prisma.modelConfig.deleteMany({ where: { key: "chaos-model" } }).catch(() => null)
    await prisma.$disconnect()
  })
  .catch((error) => {
    console.error("[chaos] concurrency safety checks failed")
    console.error(error)
    process.exit(1)
  })

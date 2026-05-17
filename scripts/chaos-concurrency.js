const { PrismaClient } = require("@prisma/client")

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
const concurrency = Math.min(10, Math.max(5, Math.round(Number(process.env.CHAOS_CONCURRENCY || 10))))

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

  console.log(`[chaos] concurrency safety checks passed (${concurrency} simultaneous duplicate prompts)`)
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

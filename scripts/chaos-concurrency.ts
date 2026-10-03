import fs from "node:fs"
import path from "node:path"
import crypto from "node:crypto"
import assert from "node:assert/strict"
import { createClient, type Client } from "@libsql/client"
import { drizzle, type LibSQLDatabase } from "drizzle-orm/libsql"
import { and, asc, desc, eq, gt, gte, inArray, isNull, notInArray, sql } from "drizzle-orm"
import {
  billingTransactions,
  generationEvents,
  generationHistory,
  generationJobs,
  modelConfigs,
  projectFiles,
  projects,
  usageLogs,
  users,
  workspaceMembers,
  workspaces,
} from "@/lib/db/schema"

type ChaosFile = { path: string; content: string; language?: string }

type Manifest = {
  count: number
  totalBytes: number
  sha256: string
  paths: string[]
  fileHashes: Record<string, string>
}

type Db = LibSQLDatabase<Record<string, never>>
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0]
type DbLike = Db | Tx

const root = process.cwd()
const runId = `chaos-${Date.now()}`
const cost = 3000
const concurrency = Math.min(100, Math.max(5, Number(process.env.CHAOS_CONCURRENCY || 50) || 50))

const dbFile = path.join(root, ".tmp", "chaos-concurrency.db")
const dbUrl = `file:///${dbFile.replace(/\\/g, "/").replace(/^\/+/, "")}`

let db: Db
let activeClient: Client | null = null

function normalizePath(value: string) {
  return String(value || "").replace(/\\/g, "/").replace(/^\/+/, "").replace(/^\.\//, "").trim()
}

function buildManifest(files: ChaosFile[]): Manifest {
  const normalized = files
    .map((file) => ({
      path: normalizePath(file.path),
      content: String(file.content || ""),
      language: String(file.language || "tsx"),
    }))
    .sort((left, right) => left.path.localeCompare(right.path))
  const hash = crypto.createHash("sha256")
  const fileHashes: Record<string, string> = {}
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

function isBusyError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error || "")
  return /SQLITE_BUSY|SQLITE_LOCKED|database is locked|database table is locked|database schema is locked/i.test(message)
}

async function withBusyRetry<T>(label: string, operation: () => Promise<T>): Promise<T> {
  let lastError: unknown
  for (let attempt = 0; attempt < 8; attempt += 1) {
    try {
      return await operation()
    } catch (error) {
      if (!isBusyError(error)) throw error
      lastError = error
      await new Promise((resolve) => setTimeout(resolve, 60 * (attempt + 1) + Math.round(Math.random() * 80)))
    }
  }
  throw new Error(`${label} still busy after retries: ${lastError instanceof Error ? lastError.message : String(lastError)}`)
}

async function migrate(client: Client) {
  const journalPath = path.join(root, "drizzle", "meta", "_journal.json")
  const journal = JSON.parse(fs.readFileSync(journalPath, "utf8")) as { entries: Array<{ tag: string }> }
  for (const entry of journal.entries) {
    const migrationFile = path.join(root, "drizzle", `${entry.tag}.sql`)
    if (!fs.existsSync(migrationFile)) {
      throw new Error(`Missing migration file for ${entry.tag}`)
    }
    const sqlText = fs.readFileSync(migrationFile, "utf8")
    for (const chunk of sqlText.split("--> statement-breakpoint")) {
      const trimmed = chunk.trim()
      if (trimmed) await client.executeMultiple(trimmed)
    }
  }
}

async function syncProjectFiles(tx: DbLike, projectId: string, files: ChaosFile[]) {
  const normalized = files
    .map((file) => ({
      path: normalizePath(file.path),
      content: String(file.content || ""),
      language: String(file.language || "tsx"),
    }))
    .sort((left, right) => left.path.localeCompare(right.path))
  const nextPaths = normalized.map((file) => file.path)
  const existingFiles = await tx
    .select({ id: projectFiles.id, path: projectFiles.path, content: projectFiles.content, language: projectFiles.language })
    .from(projectFiles)
    .where(eq(projectFiles.projectId, projectId))
  const existingByPath = new Map(existingFiles.map((file) => [file.path, file]))

  for (const file of normalized) {
    const existing = existingByPath.get(file.path)
    if (!existing) {
      await tx.insert(projectFiles).values({
        id: crypto.randomUUID(),
        projectId,
        path: file.path,
        content: file.content,
        language: file.language,
      })
      continue
    }

    if (existing.content !== file.content || existing.language !== file.language) {
      await tx
        .update(projectFiles)
        .set({ content: file.content, language: file.language, updatedAt: new Date() })
        .where(eq(projectFiles.id, existing.id))
    }
  }

  const stalePaths = existingFiles.map((file) => file.path).filter((filePath) => !nextPaths.includes(filePath))
  if (stalePaths.length > 0) {
    await tx
      .delete(projectFiles)
      .where(and(eq(projectFiles.projectId, projectId), inArray(projectFiles.path, stalePaths)))
  }

  const persisted = await tx.select().from(projectFiles).where(eq(projectFiles.projectId, projectId)).orderBy(asc(projectFiles.path))
  const expectedManifest = buildManifest(normalized)
  const actualManifest = buildManifest(persisted)
  if (expectedManifest.sha256 !== actualManifest.sha256) {
    throw new Error(`MANIFEST_MISMATCH expected=${expectedManifest.sha256} actual=${actualManifest.sha256}`)
  }
  return actualManifest
}

async function assertLatestProjectGeneration(tx: DbLike, projectId: string, generationJobId: string) {
  const currentJobResult = await tx
    .select({ id: generationJobs.id, createdAt: generationJobs.createdAt })
    .from(generationJobs)
    .where(eq(generationJobs.id, generationJobId))
    .limit(1)

  const currentJob = currentJobResult[0]
  if (!currentJob) throw new Error("Generation job not found")

  const newerJobResult = await tx
    .select({ id: generationJobs.id, status: generationJobs.status, stage: generationJobs.stage })
    .from(generationJobs)
    .where(
      and(
        eq(generationJobs.projectId, projectId),
        gt(generationJobs.createdAt, currentJob.createdAt),
        notInArray(generationJobs.status, ["failed", "cancelled"])
      )
    )
    .orderBy(desc(generationJobs.createdAt))
    .limit(1)

  const newerJob = newerJobResult[0]
  if (newerJob) {
    throw new Error(`StaleGenerationRejected: newer generation ${newerJob.id} is ${newerJob.status}/${newerJob.stage}`)
  }
}

async function guardedPersist(input: {
  projectId: string
  generationJobId: string
  idempotencyKey: string
  prompt: string
  files: ChaosFile[]
}) {
  return withBusyRetry("guardedPersist", () =>
    db.transaction(async (tx) => {
      await assertLatestProjectGeneration(tx, input.projectId, input.generationJobId)

      const historyData = {
        prompt: input.prompt,
        result: JSON.stringify(input.files),
      }

      const existing = await tx
        .select({ id: generationHistory.id })
        .from(generationHistory)
        .where(and(eq(generationHistory.projectId, input.projectId), eq(generationHistory.idempotencyKey, input.idempotencyKey)))
        .limit(1)

      let historyId: string
      if (existing.length > 0) {
        await tx.update(generationHistory).set(historyData).where(eq(generationHistory.id, existing[0].id))
        historyId = existing[0].id
      } else {
        const inserted = await tx
          .insert(generationHistory)
          .values({
            id: crypto.randomUUID(),
            projectId: input.projectId,
            idempotencyKey: input.idempotencyKey,
            ...historyData,
          })
          .returning({ id: generationHistory.id })
        historyId = inserted[0].id
      }

      const manifest = await syncProjectFiles(tx, input.projectId, input.files)
      return { historyId, manifest }
    })
  )
}

async function persistHistoryReplay(input: { projectId: string; idempotencyKey: string; prompt: string }) {
  return withBusyRetry("persistHistoryReplay", () =>
    db.transaction(async (tx) => {
      const existing = await tx
        .select({ id: generationHistory.id })
        .from(generationHistory)
        .where(and(eq(generationHistory.projectId, input.projectId), eq(generationHistory.idempotencyKey, input.idempotencyKey)))
        .limit(1)

      if (existing.length > 0) {
        await tx
          .update(generationHistory)
          .set({ prompt: input.prompt, result: "[]" })
          .where(eq(generationHistory.id, existing[0].id))
        return existing[0].id
      }

      const inserted = await tx
        .insert(generationHistory)
        .values({
          id: crypto.randomUUID(),
          projectId: input.projectId,
          idempotencyKey: input.idempotencyKey,
          prompt: input.prompt,
          result: "[]",
        })
        .returning({ id: generationHistory.id })
      return inserted[0].id
    })
  )
}

async function reserveGeneration(input: { userId: string; projectId: string; modelConfigId: string; requestHash: string }) {
  return withBusyRetry("reserveGeneration", () =>
    db.transaction(async (tx) => {
      const job = await tx
        .insert(generationJobs)
        .values({
          id: crypto.randomUUID(),
          userId: input.userId,
          projectId: input.projectId,
          prompt: "chaos double-click prompt",
          model: "chaos-model",
          provider: "swift",
          requestHash: input.requestHash,
          status: "queued",
          stage: "queued",
          label: "Prompt diterima",
          progress: 0,
          contextJson: JSON.stringify({ requestHash: input.requestHash }),
        })
        .returning()

      const user = await tx
        .select({ balance: users.balance })
        .from(users)
        .where(eq(users.id, input.userId))
        .limit(1)

      if (!user[0]) throw new Error("USER_NOT_FOUND")
      if (user[0].balance < cost) throw new Error("INSUFFICIENT_BALANCE")

      const claimed = await tx
        .update(users)
        .set({ balance: sql`${users.balance} - ${cost}` })
        .where(and(eq(users.id, input.userId), gte(users.balance, cost)))
        .returning({ id: users.id })

      if (claimed.length !== 1) throw new Error("INSUFFICIENT_BALANCE")

      const usageLog = await tx
        .insert(usageLogs)
        .values({
          id: crypto.randomUUID(),
          userId: input.userId,
          modelConfigId: input.modelConfigId,
          model: "chaos-model",
          provider: "swift",
          cost,
          prompt: "chaos double-click prompt",
          status: "reserved",
        })
        .returning()

      await tx.insert(billingTransactions).values({
        id: crypto.randomUUID(),
        userId: input.userId,
        kind: "usage",
        direction: "debit",
        amount: cost,
        balanceBefore: user[0].balance,
        balanceAfter: user[0].balance - cost,
        reference: `usage:${usageLog[0].id}`,
        provider: "swift",
        providerReference: usageLog[0].id,
        description: "Chaos reservation",
      })

      await tx.insert(generationEvents).values({
        id: crypto.randomUUID(),
        jobId: job[0].id,
        sequence: 1,
        type: "job.created",
        stage: "queued",
        status: "queued",
        message: "Generation job queued",
      })

      return { job: job[0], usageLog: usageLog[0] }
    })
  )
}

async function refundReservation(input: { usageLogId: string; userId: string }) {
  return withBusyRetry("refundReservation", () =>
    db.transaction(async (tx) => {
      const usageLog = await tx
        .select({
          id: usageLogs.id,
          status: usageLogs.status,
          userId: usageLogs.userId,
          cost: usageLogs.cost,
          refundedAt: usageLogs.refundedAt,
        })
        .from(usageLogs)
        .where(eq(usageLogs.id, input.usageLogId))
        .limit(1)

      const row = usageLog[0]
      if (!row) throw new Error("USAGE_NOT_FOUND")
      if (row.userId !== input.userId) throw new Error("USAGE_USER_MISMATCH")
      if (row.status === "completed" || row.status === "refunded") return false

      const claimed = await tx
        .update(usageLogs)
        .set({ status: "refunding", errorMessage: "Chaos refund", updatedAt: new Date() })
        .where(
          and(
            eq(usageLogs.id, input.usageLogId),
            inArray(usageLogs.status, ["reserved", "pending", "failed"]),
            isNull(usageLogs.refundedAt)
          )
        )
        .returning({ id: usageLogs.id })

      if (claimed.length !== 1) return false

      const user = await tx
        .select({ balance: users.balance })
        .from(users)
        .where(eq(users.id, input.userId))
        .limit(1)
      if (!user[0]) throw new Error("USER_NOT_FOUND")

      await tx
        .update(users)
        .set({ balance: sql`${users.balance} + ${row.cost}` })
        .where(eq(users.id, input.userId))

      await tx.insert(billingTransactions).values({
        id: crypto.randomUUID(),
        userId: input.userId,
        kind: "refund",
        direction: "credit",
        amount: row.cost,
        balanceBefore: user[0].balance,
        balanceAfter: user[0].balance + row.cost,
        reference: `refund:${input.usageLogId}`,
        provider: "internal",
        providerReference: input.usageLogId,
        description: "Chaos refund",
      })

      await tx
        .update(usageLogs)
        .set({ status: "refunded", refundedAt: new Date(), errorMessage: "Chaos refund", updatedAt: new Date() })
        .where(eq(usageLogs.id, input.usageLogId))

      return true
    })
  )
}

async function readBalance(userId: string) {
  const rows = await db.select({ balance: users.balance }).from(users).where(eq(users.id, userId)).limit(1)
  return rows[0]?.balance ?? null
}

async function cleanup(removeDatabase: boolean) {
  if (activeClient) {
    try {
      await activeClient.close()
    } catch {
      // ignore close failures
    }
    activeClient = null
  }
  if (!removeDatabase) return
  for (const suffix of ["", "-wal", "-shm"]) {
    const target = `${dbFile}${suffix}`
    try {
      fs.rmSync(target, { force: true })
    } catch (error) {
      console.warn(
        `[chaos] cleanup could not remove ${path.basename(target)}: ${
          error instanceof Error ? error.message : String(error)
        }`
      )
      try {
        fs.rmSync(target, { force: true, maxRetries: 3, retryDelay: 100 })
      } catch (retryError) {
        console.warn(
          `[chaos] retry failed for ${path.basename(target)}: ${
            retryError instanceof Error ? retryError.message : String(retryError)
          }`
        )
      }
    }
  }
}

async function main() {
  fs.mkdirSync(path.dirname(dbFile), { recursive: true })
  await cleanup(true)

  const client = createClient({ url: dbUrl })
  activeClient = client
  await client.execute("PRAGMA busy_timeout = 20000")
  await migrate(client)

  db = drizzle(client)

  const existingModel = await db
    .select({ id: modelConfigs.id })
    .from(modelConfigs)
    .where(eq(modelConfigs.key, "chaos-model"))
    .limit(1)

  const modelConfig =
    existingModel.length > 0
      ? (
          await db
            .update(modelConfigs)
            .set({ price: cost, isActive: true, updatedAt: new Date() })
            .where(eq(modelConfigs.id, existingModel[0].id))
            .returning({ id: modelConfigs.id })
        )[0]
      : (
          await db
            .insert(modelConfigs)
            .values({
              id: crypto.randomUUID(),
              key: "chaos-model",
              provider: "swift",
              modelName: "chaos-model",
              price: cost,
              isActive: true,
            })
            .returning({ id: modelConfigs.id })
        )[0]

  const user = (
    await db
      .insert(users)
      .values({
        id: crypto.randomUUID(),
        email: `${runId}@swift-chaos.local`,
        name: "Chaos User",
        balance: cost * concurrency,
      })
      .returning()
  )[0]

  const workspace = (
    await db
      .insert(workspaces)
      .values({
        id: crypto.randomUUID(),
        name: "Chaos Workspace",
        slug: runId,
        createdBy: user.id,
      })
      .returning()
  )[0]

  await db.insert(workspaceMembers).values({
    id: crypto.randomUUID(),
    userId: user.id,
    workspaceId: workspace.id,
    role: "admin",
  })

  const project = (
    await db
      .insert(projects)
      .values({
        id: crypto.randomUUID(),
        workspaceId: workspace.id,
        name: "Chaos Project",
      })
      .returning()
  )[0]

  const requestHash = `${runId}:same-request`
  const reservations = await Promise.allSettled(
    Array.from({ length: concurrency }, () =>
      reserveGeneration({ userId: user.id, projectId: project.id, modelConfigId: modelConfig.id, requestHash })
    )
  )
  const fulfilled = reservations.filter(
    (item): item is PromiseFulfilledResult<Awaited<ReturnType<typeof reserveGeneration>>> => item.status === "fulfilled"
  )
  const rejected = reservations.filter((item) => item.status === "rejected")

  assert.equal(fulfilled.length, 1, `Expected one reservation, got ${fulfilled.length}`)
  assert.equal(rejected.length, concurrency - 1, `Expected ${concurrency - 1} deduped rejections, got ${rejected.length}`)

  const reservation = fulfilled[0].value
  const afterReserve = await readBalance(user.id)
  assert.equal(afterReserve, cost * (concurrency - 1), `Expected one debit, balance=${afterReserve}`)

  await Promise.allSettled([
    refundReservation({ usageLogId: reservation.usageLog.id, userId: user.id }),
    refundReservation({ usageLogId: reservation.usageLog.id, userId: user.id }),
  ])
  const afterRefund = await readBalance(user.id)
  assert.equal(afterRefund, cost * concurrency, `Expected exactly one refund, balance=${afterRefund}`)

  const refundRows = await db
    .select({ id: billingTransactions.id })
    .from(billingTransactions)
    .where(
      and(
        eq(billingTransactions.userId, user.id),
        eq(billingTransactions.kind, "refund"),
        eq(billingTransactions.reference, `refund:${reservation.usageLog.id}`)
      )
    )
  assert.equal(refundRows.length, 1, `Expected one refund transaction, got ${refundRows.length}`)

  const persistenceKey = `${runId}:persistence`
  const persistenceAttempts = await Promise.allSettled([
    persistHistoryReplay({ projectId: project.id, idempotencyKey: persistenceKey, prompt: "chaos persistence" }),
    persistHistoryReplay({ projectId: project.id, idempotencyKey: persistenceKey, prompt: "chaos persistence" }),
  ])
  const persistenceFulfilled = persistenceAttempts.filter((item) => item.status === "fulfilled")
  assert.ok(persistenceFulfilled.length >= 1, "Expected at least one persistence replay attempt to succeed")

  const historyRows = await db
    .select({ id: generationHistory.id })
    .from(generationHistory)
    .where(and(eq(generationHistory.projectId, project.id), eq(generationHistory.idempotencyKey, persistenceKey)))
  assert.equal(historyRows.length, 1, `Expected one generation history replay record, got ${historyRows.length}`)

  let rollbackError: unknown = null
  await withBusyRetry("rollbackSimulation", async () => {
    rollbackError = null
    try {
      await db.transaction(async (tx) => {
        await tx.insert(projectFiles).values({
          id: crypto.randomUUID(),
          projectId: project.id,
          path: "app/partial-write-should-rollback.tsx",
          content: "export default function Broken(){return null}",
          language: "tsx",
        })
        throw new Error("SIMULATED_DB_TIMEOUT_AFTER_HALF_WRITE")
      })
    } catch (error) {
      rollbackError = error
    }
  })
  assert.ok(rollbackError, "Expected interrupted persistence transaction to fail")
  assert.match(
    rollbackError instanceof Error ? rollbackError.message : String(rollbackError),
    /SIMULATED_DB_TIMEOUT/,
    "Unexpected rollback simulation error"
  )

  const partialWriteRows = await db
    .select({ id: projectFiles.id })
    .from(projectFiles)
    .where(and(eq(projectFiles.projectId, project.id), eq(projectFiles.path, "app/partial-write-should-rollback.tsx")))
  assert.equal(partialWriteRows.length, 0, `Expected interrupted persistence transaction rollback, got ${partialWriteRows.length} partial files`)

  await db
    .update(generationJobs)
    .set({
      status: "failed",
      stage: "failed",
      error: "Chaos setup job closed before stale-generation race",
      failedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(generationJobs.projectId, project.id))

  const olderJob = (
    await db
      .insert(generationJobs)
      .values({
        id: crypto.randomUUID(),
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
        createdAt: new Date(Date.now() - 5_000),
      })
      .returning()
  )[0]

  const newerJob = (
    await db
      .insert(generationJobs)
      .values({
        id: crypto.randomUUID(),
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
        createdAt: new Date(Date.now() - 3_000),
      })
      .returning()
  )[0]

  const olderFiles: ChaosFile[] = [
    { path: "app/page.tsx", content: "export default function Page(){return <main>older</main>}", language: "tsx" },
  ]
  const newerFiles: ChaosFile[] = [
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
    (item) => item.status === "rejected" && /StaleGenerationRejected/.test(String(item.reason?.message || item.reason))
  )
  const newerPersisted = persistenceRace.some(
    (item) => item.status === "fulfilled" && item.value.manifest.sha256 === buildManifest(newerFiles).sha256
  )

  assert.ok(staleRejected, "Expected stale older generation to be rejected")
  assert.ok(
    newerPersisted,
    `Expected newer generation to persist successfully: ${JSON.stringify(
      persistenceRace.map((item) =>
        item.status === "fulfilled"
          ? { status: item.status, manifest: item.value.manifest.sha256 }
          : { status: item.status, reason: item.status === "rejected" ? String(item.reason?.message || item.reason) : "" }
      )
    )}`
  )

  const finalFiles = await db.select().from(projectFiles).where(eq(projectFiles.projectId, project.id)).orderBy(asc(projectFiles.path))
  const finalManifest = buildManifest(finalFiles)
  assert.equal(
    finalManifest.sha256,
    buildManifest(newerFiles).sha256,
    `Expected final manifest to match newer job, got ${finalManifest.sha256}`
  )

  console.log(`[chaos] concurrency safety checks passed (${concurrency} simultaneous duplicate prompts)`)
  console.log("[chaos] persistence rollback and stale-generation race checks passed")
}

main()
  .then(async () => {
    await cleanup(true)
  })
  .catch(async (error) => {
    console.error("[chaos] concurrency safety checks failed")
    console.error(error)
    await cleanup(false)
    process.exit(1)
  })

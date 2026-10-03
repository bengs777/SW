import nextEnv from "@next/env"
import { createClient } from "@libsql/client"

const { loadEnvConfig } = nextEnv

loadEnvConfig(process.cwd())

const normalizeEmail = (value) => value.trim().toLowerCase()

const devOwnerEmail = normalizeEmail(process.env.DEV_OWNER_EMAIL || "ibnualmugni1933@gmail.com")
const seedReference = `developer-seed:${devOwnerEmail}`
const seedAmount = 1_000_000

const databaseUrl = process.env.TURSO_DATABASE_URL

if (!/^(libsql|https?):\/\//i.test(databaseUrl || "")) {
  throw new Error("TURSO_DATABASE_URL must be a libsql:// or https:// connection string")
}

const client = createClient({
  url: databaseUrl,
  authToken: process.env.TURSO_AUTH_TOKEN || undefined,
})

const nowSeconds = () => Math.floor(Date.now() / 1000)
const newId = () => crypto.randomUUID()

async function main() {
  const existingSeed = await client.execute({
    sql: "SELECT id FROM billing_transactions WHERE reference = ?",
    args: [seedReference],
  })

  if (existingSeed.rows.length > 0) {
    console.log(`Developer treasury already seeded for ${devOwnerEmail}`)
    return
  }

  const seedAt = nowSeconds()

  const existingUser = await client.execute({
    sql: "SELECT id, balance FROM users WHERE email = ?",
    args: [devOwnerEmail],
  })

  const row = existingUser.rows[0]
  const userId = row ? String(row.id) : newId()
  const balanceBefore = row ? Number(row.balance) : 0

  const statements = []

  if (row) {
    statements.push({
      sql: "UPDATE users SET balance = ?, is_developer_account = 1, welcome_bonus_granted_at = ?, updated_at = ? WHERE id = ?",
      args: [seedAmount, seedAt, seedAt, userId],
    })
  } else {
    statements.push({
      sql: "INSERT INTO users (id, email, name, balance, is_developer_account, welcome_bonus_granted_at, created_at, updated_at) VALUES (?, ?, ?, ?, 1, ?, ?, ?)",
      args: [userId, devOwnerEmail, "Swift Developer", seedAmount, seedAt, seedAt, seedAt],
    })
  }

  const membership = await client.execute({
    sql: `SELECT
      (SELECT COUNT(*) FROM workspaces WHERE created_by = ?) AS workspace_count,
      (SELECT COUNT(*) FROM workspace_members WHERE user_id = ?) AS membership_count`,
    args: [userId, userId],
  })

  const workspaceCount = Number(membership.rows[0].workspace_count)
  const membershipCount = Number(membership.rows[0].membership_count)

  if (workspaceCount === 0 && membershipCount === 0) {
    const workspaceId = newId()

    statements.push({
      sql: "INSERT INTO workspaces (id, name, slug, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
      args: [workspaceId, "Developer Treasury Workspace", `developer-${userId.slice(0, 8)}`, userId, seedAt, seedAt],
    })

    statements.push({
      sql: "INSERT INTO workspace_members (id, workspace_id, user_id, role, joined_at) VALUES (?, ?, ?, 'admin', ?)",
      args: [newId(), workspaceId, userId, seedAt],
    })

    statements.push({
      sql: "INSERT INTO subscriptions (id, workspace_id, plan, status, created_at, updated_at) VALUES (?, ?, 'free', 'active', ?, ?)",
      args: [newId(), workspaceId, seedAt, seedAt],
    })
  }

  statements.push({
    sql: `INSERT INTO billing_transactions
      (id, user_id, kind, direction, amount, balance_before, balance_after, reference, provider, description, metadata, created_at)
      VALUES (?, ?, 'developer_seed', 'credit', ?, ?, ?, ?, 'internal', ?, ?, ?)`,
    args: [
      newId(),
      userId,
      seedAmount,
      balanceBefore,
      seedAmount,
      seedReference,
      "Developer treasury seed",
      JSON.stringify({ source: "seed-script", email: devOwnerEmail, amount: seedAmount }),
      seedAt,
    ],
  })

  await client.batch(statements, "write")

  console.log(`Seeded developer treasury for ${devOwnerEmail} with ${seedAmount} credits`)
}

main()
  .catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
  .finally(() => {
    try {
      client.close()
    } catch {
      // ignore close errors
    }
  })

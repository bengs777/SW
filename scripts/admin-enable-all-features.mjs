import nextEnv from "@next/env"
import { createClient } from "@libsql/client"

const { loadEnvConfig } = nextEnv

loadEnvConfig(process.cwd())

const databaseUrl = process.env.TURSO_DATABASE_URL

if (!/^(libsql|https?):\/\//i.test(databaseUrl || "")) {
  throw new Error("TURSO_DATABASE_URL must be a libsql:// or https:// connection string")
}

const client = createClient({
  url: databaseUrl,
  authToken: process.env.TURSO_AUTH_TOKEN || undefined,
})

async function main() {
  const email = "ibnualmugni1933@gmail.com"
  const tokenCredit = 100000

  console.log(`\n🔧 Admin: Enabling all features and adding credits for ${email}...`)

  const found = await client.execute({
    sql: "SELECT id, email, balance, is_developer_account, updated_at FROM users WHERE email = ?",
    args: [email],
  })

  const user = found.rows[0]

  if (!user) {
    console.error(`❌ User not found: ${email}`)
    process.exit(1)
  }

  console.log(`✅ User found:`)
  console.log(`   ID: ${user.id}`)
  console.log(`   Email: ${user.email}`)
  console.log(`   Current balance: ${user.balance}`)
  console.log(`   Developer account: ${Boolean(user.is_developer_account)}`)

  const updated = await client.execute({
    sql: "UPDATE users SET balance = ?, is_developer_account = 1, updated_at = ? WHERE id = ?",
    args: [tokenCredit, Math.floor(Date.now() / 1000), String(user.id)],
  })

  if (updated.rowsAffected === 0) {
    console.error("❌ Update failed: user row not found")
    process.exit(1)
  }

  console.log(`\n✅ User updated successfully:`)
  console.log(`   Balance: ${tokenCredit} (target ${tokenCredit})`)
  console.log(`   Developer account: true`)

  console.log(`\n✨ All features enabled for ${email}!\n`)
}

main()
  .catch((e) => {
    console.error("❌ Error:", e.message)
    process.exit(1)
  })
  .finally(() => {
    try {
      client.close()
    } catch {
      // ignore close errors
    }
  })

import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()

async function main() {
  const email = 'ibnualmugni1933@gmail.com'
  const tokenCredit = 100000

  console.log(`\n🔧 Admin: Enabling all features and adding credits for ${email}...`)

  // Find user
  const user = await prisma.user.findUnique({
    where: { email },
  })

  if (!user) {
    console.error(`❌ User not found: ${email}`)
    process.exit(1)
  }

  console.log(`✅ User found:`)
  console.log(`   ID: ${user.id}`)
  console.log(`   Email: ${user.email}`)
  console.log(`   Current balance: ${user.balance}`)
  console.log(`   Developer account: ${user.isDeveloperAccount}`)

  // Update user: set balance + enable developer account
  const updated = await prisma.user.update({
    where: { id: user.id },
    data: {
      balance: tokenCredit,
      isDeveloperAccount: true,
    },
  })

  console.log(`\n✅ User updated successfully:`)
  console.log(`   Balance: ${updated.balance} (added ${tokenCredit})`)
  console.log(`   Developer account: ${updated.isDeveloperAccount}`)
  console.log(`   Updated at: ${updated.updatedAt}`)

  console.log(`\n✨ All features enabled for ${email}!\n`)
}

main()
  .catch((e) => {
    console.error('❌ Error:', e.message)
    process.exit(1)
  })
  .finally(async () => {
    await prisma.$disconnect()
  })

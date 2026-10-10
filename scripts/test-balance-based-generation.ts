import { db } from "@/lib/db/client"
import { users, projects, usageLogs, billingTransactions, subscriptions, generationJobs } from "@/lib/db/schema"
import { eq, and, sql } from "drizzle-orm"
import { enforceAiUsageRateLimit } from "@/lib/security/rate-limit"
import { BillingService } from "@/lib/services/billing.service"
import { calculateModelRequestPrice } from "@/lib/ai/pricing"
import { publicGenerationRuntimeErrorMessage } from "@/lib/ai/runtime-contracts"

async function runTests() {
  console.log("=== STARTING BALANCE-BASED GENERATION ACCESS VERIFICATION ===")

  const timestamp = Date.now()
  const testEmailFree = `test_free_quota_${timestamp}@example.com`
  const testEmailBroke = `test_broke_${timestamp}@example.com`
  const testEmailConcurrent = `test_concurrent_${timestamp}@example.com`
  const testEmailRefund = `test_refund_${timestamp}@example.com`

  try {
    // -------------------------------------------------------------
    // TEST 1: Free user with >3 generations in 24 hours CAN still generate if balance is sufficient
    // -------------------------------------------------------------
    console.log("\n[TEST 1] Verifying removal of 3/day free quota for users with balance...")

    const [userFree] = await db.insert(users).values({
      id: `usr_free_${timestamp}`,
      email: testEmailFree,
      name: "Free User With Balance",
      balance: 15_000,
      isDeveloperAccount: false,
    }).returning()

    // Create a dummy project for userFree
    const [projectFree] = await db.insert(projects).values({
      id: `prj_free_${timestamp}`,
      workspaceId: "ws_default",
      name: "Test Free Project",
    }).returning()

    // Insert 5 past generations in the last 2 hours to exceed old 3/day limit
    const pastHour = new Date(Date.now() - 3600 * 1000)
    for (let i = 0; i < 5; i++) {
      await db.insert(usageLogs).values({
        id: `usg_past_${timestamp}_${i}`,
        userId: userFree.id,
        modelConfigId: "cfg_test_past",
        model: "swift-build",
        provider: "swift",
        prompt: "Past generation prompt",
        cost: 3_000,
        status: "completed",
        createdAt: pastHour,
      })
    }

    // Call enforceAiUsageRateLimit
    let rateLimitPassed = false
    try {
      await enforceAiUsageRateLimit(userFree.id)
      rateLimitPassed = true
      console.log("  ✓ enforceAiUsageRateLimit passed for free user with 5 past generations within 24h (daily limit restriction REMOVED)")
    } catch (err) {
      console.error("  ✗ enforceAiUsageRateLimit failed:", err)
      throw new Error(`TEST 1 FAILED: Daily quota blocked free user with balance: ${(err as Error).message}`)
    }

    // Verify user can reserve a generation
    const reservation1 = await BillingService.reserveGenerationJob({
      userId: userFree.id,
      projectId: projectFree.id,
      prompt: "Create a modern portfolio app",
      modelConfigId: "cfg_test_1",
      model: "swift-build",
      provider: "swift",
      cost: 3_000,
    })

    const updatedUserFree = await db.query.users.findFirst({ where: eq(users.id, userFree.id) })
    if (updatedUserFree?.balance !== 12_000) {
      throw new Error(`TEST 1 FAILED: Expected balance 12000, got ${updatedUserFree?.balance}`)
    }
    console.log("  ✓ Generation reserved successfully! Balance decremented from 15,000 to 12,000 IDR.")

    // -------------------------------------------------------------
    // TEST 2: User with insufficient balance is strictly rejected with 402 / top-up message
    // -------------------------------------------------------------
    console.log("\n[TEST 2] Verifying rejection and clear message when balance is insufficient...")

    const [userBroke] = await db.insert(users).values({
      id: `usr_broke_${timestamp}`,
      email: testEmailBroke,
      name: "User With Low Balance",
      balance: 1_000, // Only 1,000 IDR, whereas generation costs 3,000 IDR
      isDeveloperAccount: false,
    }).returning()

    const [projectBroke] = await db.insert(projects).values({
      id: `prj_broke_${timestamp}`,
      workspaceId: "ws_default",
      name: "Test Broke Project",
    }).returning()

    const pricing = calculateModelRequestPrice({
      modelKey: "swift-build",
      prompt: "Build an inventory app",
    })
    console.log(`  Model estimated cost: Rp ${pricing.estimatedCost.toLocaleString("id-ID")}, user balance: Rp ${userBroke.balance.toLocaleString("id-ID")}`)

    let brokeRejected = false
    try {
      await BillingService.reserveGenerationJob({
        userId: userBroke.id,
        projectId: projectBroke.id,
        prompt: "Build an inventory app",
        modelConfigId: "cfg_test_broke",
        model: "swift-build",
        provider: "swift",
        cost: pricing.estimatedCost,
      })
    } catch (err) {
      if (/insufficient balance/i.test((err as Error).message)) {
        brokeRejected = true
        console.log("  ✓ Atomic reservation threw 'Insufficient balance' as required.")
      } else {
        throw err
      }
    }

    if (!brokeRejected) {
      throw new Error("TEST 2 FAILED: User with low balance was not rejected!")
    }

    // Verify error translation gives clear Indonesian top-up instructions
    const userFacingMsg = publicGenerationRuntimeErrorMessage(new Error("Insufficient balance"))
    if (!userFacingMsg.includes("top up") && !userFacingMsg.includes("Billing")) {
      throw new Error(`TEST 2 FAILED: Error message does not guide to Billing top up: "${userFacingMsg}"`)
    }
    console.log(`  ✓ Public runtime error message verified: "${userFacingMsg}"`)

    // -------------------------------------------------------------
    // TEST 3: Concurrency double-spend prevention
    // -------------------------------------------------------------
    console.log("\n[TEST 3] Verifying atomic reservation prevents double-spend under concurrency...")

    // User has exactly 3,000 IDR (enough for only 1 generation)
    const [userConcurrent] = await db.insert(users).values({
      id: `usr_conc_${timestamp}`,
      email: testEmailConcurrent,
      name: "Concurrent User",
      balance: 3_000,
      isDeveloperAccount: false,
    }).returning()

    const [projectConcurrent] = await db.insert(projects).values({
      id: `prj_conc_${timestamp}`,
      workspaceId: "ws_default",
      name: "Test Concurrent Project",
    }).returning()

    // Fire 2 simultaneous reservation requests
    const results = await Promise.allSettled([
      BillingService.reserveGenerationJob({
        userId: userConcurrent.id,
        projectId: projectConcurrent.id,
        prompt: "Concurrent prompt A",
        modelConfigId: "cfg_test_conc",
        model: "swift-build",
        provider: "swift",
        cost: 3_000,
      }),
      BillingService.reserveGenerationJob({
        userId: userConcurrent.id,
        projectId: projectConcurrent.id,
        prompt: "Concurrent prompt B",
        modelConfigId: "cfg_test_conc",
        model: "swift-build",
        provider: "swift",
        cost: 3_000,
      }),
    ])

    const fulfilled = results.filter((r) => r.status === "fulfilled")
    const rejected = results.filter((r) => r.status === "rejected")

    console.log(`  Concurrent results: ${fulfilled.length} succeeded, ${rejected.length} rejected.`)
    if (fulfilled.length !== 1 || rejected.length !== 1) {
      throw new Error(`TEST 3 FAILED: Expected exactly 1 success and 1 rejection! Got ${fulfilled.length} success and ${rejected.length} rejected.`)
    }

    const checkUserConc = await db.query.users.findFirst({ where: eq(users.id, userConcurrent.id) })
    if (checkUserConc?.balance !== 0) {
      throw new Error(`TEST 3 FAILED: Expected final balance 0, got ${checkUserConc?.balance}`)
    }
    console.log("  ✓ Atomic DB transaction guaranteed zero double-spend: final balance is exactly Rp 0.")

    // -------------------------------------------------------------
    // TEST 4: Single safe refund and idempotency (no double refund)
    // -------------------------------------------------------------
    console.log("\n[TEST 4] Verifying single safe refund on failure and idempotency...")

    const [userRefund] = await db.insert(users).values({
      id: `usr_ref_${timestamp}`,
      email: testEmailRefund,
      name: "Refund User",
      balance: 10_000,
      isDeveloperAccount: false,
    }).returning()

    const [projectRefund] = await db.insert(projects).values({
      id: `prj_ref_${timestamp}`,
      workspaceId: "ws_default",
      name: "Test Refund Project",
    }).returning()

    // 1. Reserve 3,000 IDR
    const reservationRefund = await BillingService.reserveGenerationJob({
      userId: userRefund.id,
      projectId: projectRefund.id,
      prompt: "Failing generation prompt",
      modelConfigId: "cfg_test_ref",
      model: "swift-build",
      provider: "swift",
      cost: 3_000,
    })

    const userAfterReserve = await db.query.users.findFirst({ where: eq(users.id, userRefund.id) })
    if (userAfterReserve?.balance !== 7_000) {
      throw new Error(`Expected balance 7000 after reserve, got ${userAfterReserve?.balance}`)
    }

    // 2. Refund reservation on failure
    await BillingService.refundReservation(
      reservationRefund.usageLog.id,
      userRefund.id,
      3_000,
      "Simulated provider timeout"
    )

    const userAfterRefund1 = await db.query.users.findFirst({ where: eq(users.id, userRefund.id) })
    if (userAfterRefund1?.balance !== 10_000) {
      throw new Error(`Expected balance 10000 after refund, got ${userAfterRefund1?.balance}`)
    }
    console.log("  ✓ First refund succeeded: balance restored to Rp 10,000.")

    // 3. Attempt second refund (e.g. worker retry or timeout race)
    await BillingService.refundReservation(
      reservationRefund.usageLog.id,
      userRefund.id,
      3_000,
      "Second refund attempt should be no-op"
    )

    const userAfterRefund2 = await db.query.users.findFirst({ where: eq(users.id, userRefund.id) })
    if (userAfterRefund2?.balance !== 10_000) {
      throw new Error(`TEST 4 FAILED: Second refund resulted in double refund! Balance is ${userAfterRefund2?.balance}`)
    }
    console.log("  ✓ Idempotent refund verified: second refund attempt was safely ignored, balance remains Rp 10,000.")

    // -------------------------------------------------------------
    // TEST 5: Verify usage logs & transaction ledger records
    // -------------------------------------------------------------
    console.log("\n[TEST 5] Verifying transaction ledger entries...")

    const txRecords = await db.select().from(billingTransactions).where(eq(billingTransactions.userId, userRefund.id))
    console.log(`  Found ${txRecords.length} billing transactions for test user:`)
    for (const t of txRecords) {
      console.log(`    - kind: ${t.kind}, direction: ${t.direction}, amount: Rp ${t.amount}, before: Rp ${t.balanceBefore}, after: Rp ${t.balanceAfter}`)
    }

    const hasDebit = txRecords.some((t) => t.kind === "usage" && t.direction === "debit" && t.amount === 3000)
    const hasCredit = txRecords.some((t) => t.kind === "refund" && t.direction === "credit" && t.amount === 3000)
    if (!hasDebit || !hasCredit) {
      throw new Error("TEST 5 FAILED: Missing debit or credit ledger record in billingTransactions!")
    }
    console.log("  ✓ Double-entry ledger verified: both debit and credit transactions recorded accurately.")

    console.log("\n=== ALL BALANCE-BASED ACCESS VERIFICATION TESTS PASSED! ===")
    process.exit(0)
  } catch (error) {
    console.error("\n❌ VERIFICATION TEST FAILED:", error)
    process.exit(1)
  }
}

runTests().catch((e) => {
  console.error("Unhandled error:", e)
  process.exit(1)
})

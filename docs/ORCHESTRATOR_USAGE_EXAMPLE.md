# Orchestrator - Usage Examples

## Frontend Integration

### Example 1: Basic Generation

```typescript
// In your component or API client
async function generateWithOrchestrator(prompt: string, projectId: string) {
  try {
    const response = await fetch("/api/generate/orchestrator", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        prompt,
        projectId,
        mode: "CREATE",
      }),
    })

    if (!response.ok) {
      const error = await response.json()
      
      if (response.status === 402) {
        // Handle insufficient balance
        throw new Error(`Insufficient balance. Need 2000 IDR, have ${error.currentBalance}`)
      } else if (response.status === 503) {
        throw new Error("Orchestrator not configured")
      }
      
      throw new Error(error.error || "Generation failed")
    }

    const data = await response.json()
    return data
  } catch (error) {
    console.error("Generation error:", error)
    throw error
  }
}

// Usage
try {
  const result = await generateWithOrchestrator(
    "Create a React dashboard with charts using Tailwind CSS",
    "my-project-123"
  )
  
  console.log("Generated files:", result.files)
  console.log("New balance:", result.newBalance)
  
  // Update UI with generated files
  updateEditorWithFiles(result.files)
} catch (error) {
  showErrorToast(error.message)
}
```

### Example 2: With Existing Files (EXTEND Mode)

```typescript
async function extendProjectWithOrchestrator(
  prompt: string,
  projectId: string,
  existingFiles: GeneratedFile[]
) {
  const response = await fetch("/api/generate/orchestrator", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      prompt,
      projectId,
      mode: "EXTEND",
      existingFiles,
    }),
  })

  if (!response.ok) {
    throw new Error("Failed to extend project")
  }

  return await response.json()
}

// Usage
const result = await extendProjectWithOrchestrator(
  "Add dark mode support to the dashboard",
  projectId,
  currentProjectFiles
)
```

### Example 3: In React Component

```tsx
"use client"

import { useState } from "react"
import { OrchestratorBadge } from "@/components/editor/orchestrator-badge"
import { Button } from "@/components/ui/button"

export function OrchestratorGenerator() {
  const [prompt, setPrompt] = useState("")
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [balance, setBalance] = useState<number | null>(null)

  const handleGenerate = async () => {
    setLoading(true)
    setError(null)

    try {
      const response = await fetch("/api/generate/orchestrator", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          prompt,
          projectId: "current-project",
          mode: "CREATE",
        }),
      })

      if (!response.ok) {
        const data = await response.json()
        
        if (response.status === 402) {
          setError(
            `Insufficient balance (have: ${data.currentBalance}, need: 5000)`
          )
        } else {
          setError(data.error || "Generation failed")
        }
        return
      }

      const data = await response.json()
      setBalance(data.newBalance)
      
      // Handle success
      console.log("Generated files:", data.files)
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <h3>Generate with Orchestrator</h3>
        <OrchestratorBadge size="sm" showCost={true} />
      </div>

      <textarea
        value={prompt}
        onChange={(e) => setPrompt(e.target.value)}
        placeholder="Describe what you want to generate..."
        className="w-full border rounded p-2"
        rows={4}
      />

      {balance !== null && (
        <p className="text-sm text-gray-600">Balance: {balance.toLocaleString()} IDR</p>
      )}

      {error && (
        <div className="bg-red-50 border border-red-200 rounded p-2 text-red-700 text-sm">
          {error}
        </div>
      )}

      <Button
        onClick={handleGenerate}
        disabled={loading || !prompt.trim()}
        className="w-full"
      >
        {loading ? "Generating..." : "Generate (2000 IDR)"}
      </Button>
    </div>
  )
}
```

## Backend Integration

### Example 4: Direct Provider Usage

```typescript
// lib/your-service.ts
import { orchestratorProvider } from "@/lib/ai/providers/orchestrator-provider"
import { GenerateBillingService } from "@/lib/services/generate-billing.service"

export async function generateCodeWithOrchestrator(
  userId: string,
  prompt: string,
  projectId: string
) {
  // Check if configured
  if (!orchestratorProvider.isConfigured()) {
    throw new Error("Orchestrator not configured")
  }

  // Check balance
  const balance = await GenerateBillingService.checkBalance(userId, 2000)
  if (!balance.hasBalance) {
    throw new Error(`Insufficient balance: ${balance.shortfall} IDR short`)
  }

  // Generate
  const result = await orchestratorProvider.generate({
    prompt,
    mode: "CREATE",
  })

  if (!result.success) {
    throw new Error(`Generation failed: ${result.error}`)
  }

  // Charge user
  const chargeResult = await GenerateBillingService.chargeUser(
    userId,
    5000,
    "orchestrator",
    "Swift AI",
    projectId
  )

  return {
    files: result.files,
    newBalance: chargeResult.newBalance,
  }
}

// Usage
const result = await generateCodeWithOrchestrator(
  userId,
  userPrompt,
  projectId
)
```

### Example 5: With Error Recovery

```typescript
async function generateWithRetry(
  userId: string,
  prompt: string,
  projectId: string,
  maxRetries = 3
) {
  let lastError: Error | null = null

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      console.log(`[Orchestrator] Attempt ${attempt}/${maxRetries}`)

      const result = await generateCodeWithOrchestrator(
        userId,
        prompt,
        projectId
      )

      console.log("[Orchestrator] Success")
      return result
    } catch (error) {
      lastError = error as Error
      console.error(`[Orchestrator] Attempt ${attempt} failed:`, error)

      // Don't retry on balance error
      if (error instanceof Error && error.message.includes("balance")) {
        throw error
      }

      // Wait before retry
      if (attempt < maxRetries) {
        await new Promise((resolve) => setTimeout(resolve, 1000 * attempt))
      }
    }
  }

  throw lastError || new Error("Generation failed after retries")
}
```

## Admin Operations

### Example 6: Viewing Transaction History

```typescript
// pages/admin/billing.tsx
import { prisma } from "@/lib/db/client"

async function getOrchestratorTransactions(
  userId?: string,
  limit = 50
) {
  const logs = await prisma.billingLog.findMany({
    where: {
      provider: "orchestrator",
      ...(userId ? { userId } : {}),
    },
    orderBy: { createdAt: "desc" },
    take: limit,
  })

  return logs.map((log) => ({
    id: log.id,
    user: log.userId,
    model: log.model,
    cost: log.costAmount,
    status: log.status,
    date: log.createdAt,
    project: log.projectId,
    details: log.details,
  }))
}

// Usage
const transactions = await getOrchestratorTransactions()
```

### Example 7: Processing Refunds

```typescript
async function refundOrchestratorTransaction(
  transactionId: string,
  reason: string
) {
  const log = await prisma.billingLog.findUnique({
    where: { id: transactionId },
  })

  if (!log) {
    throw new Error("Transaction not found")
  }

  if (log.provider !== "orchestrator") {
    throw new Error("Not an Orchestrator transaction")
  }

  // Create refund
  const refund = await BillingService.refundUser(
    log.userId,
    log.costAmount,
    reason
  )

  // Log refund
  await prisma.billingLog.create({
    data: {
      userId: log.userId,
      provider: "orchestrator",
      model: log.model,
      costAmount: -log.costAmount, // Negative for refund
      costCurrency: "IDR",
      status: "REFUNDED",
      projectId: log.projectId,
      details: `Refund for transaction ${transactionId}: ${reason}`,
    },
  })

  return refund
}
```

## Monitoring & Analytics

### Example 8: Daily Usage Report

```typescript
async function getDailyOrchestratorUsage(date: Date) {
  const startOfDay = new Date(date)
  startOfDay.setHours(0, 0, 0, 0)
  const endOfDay = new Date(date)
  endOfDay.setHours(23, 59, 59, 999)

  const logs = await prisma.billingLog.findMany({
    where: {
      provider: "orchestrator",
      createdAt: {
        gte: startOfDay,
        lte: endOfDay,
      },
    },
  })

  const successful = logs.filter((l) => l.status === "SUCCESS")
  const failed = logs.filter((l) => l.status === "FAILED")

  return {
    date: date.toISOString().split("T")[0],
    totalRequests: logs.length,
    successfulRequests: successful.length,
    failedRequests: failed.length,
    totalRevenue: successful.reduce((sum, l) => sum + l.costAmount, 0),
    users: new Set(logs.map((l) => l.userId)).size,
  }
}

// Usage
const today = new Date()
const report = await getDailyOrchestratorUsage(today)
console.log(`Daily Orchestrator Usage:`)
console.log(`- Total requests: ${report.totalRequests}`)
console.log(`- Successful: ${report.successfulRequests}`)
console.log(`- Failed: ${report.failedRequests}`)
console.log(`- Revenue: ${report.totalRevenue.toLocaleString()} IDR`)
console.log(`- Active users: ${report.users}`)
```

### Example 9: User Usage Statistics

```typescript
async function getUserOrchestratorStats(userId: string) {
  const logs = await prisma.billingLog.findMany({
    where: {
      userId,
      provider: "orchestrator",
    },
  })

  const successful = logs.filter((l) => l.status === "SUCCESS")
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { balance: true },
  })

  return {
    totalGenerated: successful.length,
    totalSpent: successful.reduce((sum, l) => sum + l.costAmount, 0),
    remainingBalance: user?.balance || 0,
    costPerGeneration: 2000,
    estimatedGenerationsLeft: Math.floor((user?.balance || 0) / 2000),
    lastGeneration: successful.length > 0 ? successful[0].createdAt : null,
  }
}
```

## Error Handling Best Practices

### Example 10: Comprehensive Error Handler

```typescript
type OrchestratorError = 
  | { type: "INSUFFICIENT_BALANCE"; shortfall: number }
  | { type: "PROVIDER_NOT_CONFIGURED" }
  | { type: "GENERATION_FAILED"; details: string }
  | { type: "AUTH_REQUIRED" }
  | { type: "SERVER_ERROR"; details: string }

function parseOrchestratorError(response: Response, data: any): OrchestratorError {
  if (response.status === 402) {
    return {
      type: "INSUFFICIENT_BALANCE",
      shortfall: data.shortfall || 0,
    }
  }

  if (response.status === 503) {
    return { type: "PROVIDER_NOT_CONFIGURED" }
  }

  if (response.status === 401) {
    return { type: "AUTH_REQUIRED" }
  }

  if (response.status === 502) {
    return {
      type: "GENERATION_FAILED",
      details: data.error || "Unknown error",
    }
  }

  return {
    type: "SERVER_ERROR",
    details: data.error || "Internal server error",
  }
}

// Usage
try {
  const response = await fetch("/api/generate/orchestrator", {
    method: "POST",
    body: JSON.stringify({ prompt, projectId }),
  })

  if (!response.ok) {
    const error = parseOrchestratorError(response, await response.json())

    switch (error.type) {
      case "INSUFFICIENT_BALANCE":
        showToast(`Need ${error.shortfall} more IDR to generate`)
        navigateToTopup()
        break

      case "PROVIDER_NOT_CONFIGURED":
        showToast("Orchestrator is not available. Please contact support.")
        break

      case "AUTH_REQUIRED":
        redirectToLogin()
        break

      case "GENERATION_FAILED":
        showToast(`Generation failed: ${error.details}`)
        break

      case "SERVER_ERROR":
        showToast(`Server error: ${error.details}`)
        break
    }
  }
} catch (error) {
  showToast("Network error. Please try again.")
}
```

---

These examples cover common use cases for integrating Orchestrator into your application. For more details, refer to the main [ORCHESTRATOR_INTEGRATION.md](./ORCHESTRATOR_INTEGRATION.md) guide.

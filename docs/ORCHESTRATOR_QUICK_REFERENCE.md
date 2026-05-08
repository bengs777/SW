# Orchestrator - Quick Reference Guide

## Setup (5 minutes)

1. Get your Orchestrator API key
2. Add to `.env.local`:
   ```env
   ORCHESTRATOR_API_KEY=your_key_here
   ```
3. Restart your dev server
4. Orchestrator will appear in the model selector

## Using Orchestrator

### In the UI

1. Open the editor
2. In model selector dropdown, choose "Swift AI (2000/req)"
3. Write your prompt
4. Click "Generate"
5. 2,000 IDR will be deducted from balance

### Programmatically

```typescript
const response = await fetch("/api/generate/orchestrator", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    prompt: "Create a dashboard with charts",
    projectId: "my-project",
    mode: "CREATE",
  }),
})

const { files, newBalance } = await response.json()
```

## Pricing

| Item | Cost |
|------|------|
| Per Generation | 2,000 IDR |
| Failed Request | Free |
| Admin Refund | Custom |

## Status Codes

| Code | Meaning |
|------|---------|
| 200 | Success - code generated |
| 400 | Invalid request |
| 401 | Not authenticated |
| 402 | Insufficient balance |
| 503 | Provider not configured |
| 502 | Generation failed |
| 500 | Server error |

## Model Info

- **Name**: Swift AI
- **Specialization**: General-purpose code generation
- **Speed**: Fast
- **Timeout**: 30 seconds
- **Mode Support**: CREATE and EXTEND

## Files Generated

### CREATE mode
- app/page.tsx (main component)
- Additional files based on prompt

### EXTEND mode
- Modifies existing files
- Adds new files as needed
- Preserves unchanged files

## Balance Management

### Check Balance
```typescript
const response = await fetch("/api/user/balance")
const { balance } = await response.json()
```

### Low Balance Alert
- Automatically shows when balance < 50,000 IDR
- Button to navigate to top-up page

## Common Issues & Solutions

### "Provider not configured"
**Fix**: Set `ORCHESTRATOR_API_KEY` in environment

### "Insufficient balance"
**Fix**: User needs to top-up (need 2,000 IDR minimum)

### Generation timeout
**Fix**: Try again, or break prompt into smaller requests

### Invalid API key
**Fix**: Verify key format in Orchestrator dashboard

## Integration Points

### React Component
```tsx
import { OrchestratorBadge } from "@/components/editor/orchestrator-badge"

<OrchestratorBadge size="md" showCost={true} />
```

### Service
```typescript
import { orchestratorProvider } from "@/lib/ai/providers/orchestrator-provider"
import { GenerateBillingService } from "@/lib/services/generate-billing.service"

// Check if configured
if (orchestratorProvider.isConfigured()) {
  // Can use
}

// Get cost
const cost = orchestratorProvider.getCost() // 5000
```

### API Endpoint
```
POST /api/generate/orchestrator
Content-Type: application/json

{
  "prompt": "your prompt",
  "projectId": "project-123",
  "mode": "CREATE"
}
```

## Billing Details

### What Gets Logged
- User ID
- Provider name
- Model name
- Cost amount
- Generation status
- Timestamp
- Project ID
- Details/error message

### Transactions
View all Orchestrator transactions:
```typescript
const logs = await prisma.billingLog.findMany({
  where: { provider: "orchestrator" },
  orderBy: { createdAt: "desc" },
})
```

## Comparison with Other Providers

### vs V0
- Same cost (2,000 IDR)
- Different model (Swift AI vs v0-web-generator)
- Orchestrator for general code, V0 for web UI

### vs OpenAI/Others
- Fixed cost (no variable pricing)
- Optimized for code generation
- Simpler billing

## Support & Debugging

**Enable debug logs:**
```typescript
// In app/api/generate/orchestrator/route.ts
console.log("[v0] Orchestrator request:", { prompt, mode })
console.log("[v0] Generation result:", result)
```

**Check logs:**
- Browser console (client-side errors)
- Server logs (API errors)
- Database: `billingLog` table (transaction history)

## Next Steps

1. ✅ Set up environment variable
2. ✅ Verify in model selector
3. ✅ Test a generation
4. ✅ Monitor balance
5. ✅ Set up alerts for low balance

For detailed documentation, see [ORCHESTRATOR_INTEGRATION.md](./ORCHESTRATOR_INTEGRATION.md)

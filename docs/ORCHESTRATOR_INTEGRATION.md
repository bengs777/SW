# Orchestrator AI Provider Integration

## Overview

Orchestrator is an intelligent code generation provider using **OpenRouter API** with the **Swift AI** model. Each generation request costs **2,000 IDR**.

## How It Works

Orchestrator leverages OpenRouter's infrastructure to access the Swift AI model. This provides:
- Reliable, high-performance API endpoints
- Multi-model support through OpenRouter
- Proven infrastructure at scale
- No additional API key needed (uses your existing OpenRouter/OPENAI_API_KEY)

## Configuration

### 1. Environment Setup

Orchestrator uses your existing **OPENAI_API_KEY** configured for OpenRouter:

```env
# Your OpenRouter API key (used by both OpenAI and Orchestrator)
OPENAI_API_KEY=your_openrouter_api_key_here
OPENAI_API_URL=https://openrouter.ai/api/v1
```

If you don't have an OpenRouter key yet, get one from: https://openrouter.ai/keys

### 2. Verify Configuration

The Orchestrator provider will automatically appear in the model selector once your OpenRouter API key is configured and the URL is set to OpenRouter.

## Usage

### Client-Side

To use Orchestrator for code generation:

```typescript
// Call the Orchestrator API endpoint
const response = await fetch("/api/generate/orchestrator", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    prompt: "Create a landing page with React and Tailwind",
    projectId: "project-123",
    mode: "CREATE", // or "EXTEND"
    existingFiles: [], // If EXTEND mode, provide existing files
  }),
})

const data = await response.json()

if (!response.ok) {
  // Handle errors
  if (response.status === 402) {
    console.error("Insufficient balance:", data.shortfall)
  } else if (response.status === 503) {
    console.error("Provider not configured")
  }
  return
}

// Success - received generated files
console.log("Generated files:", data.files)
console.log("New balance:", data.newBalance)
```

### Model Details

| Property | Value |
|----------|-------|
| Provider | `orchestrator` |
| Model | `Swift AI` |
| Cost per Request | 2,000 IDR |
| Currency | IDR |
| Timeout | 30 seconds |

## API Response

### Success Response (200 OK)

```json
{
  "success": true,
  "files": [
    {
      "path": "app/page.tsx",
      "content": "export default function Home() { ... }",
      "language": "typescript"
    }
  ],
  "provider": "orchestrator",
  "model": "Swift AI",
  "cost": 2000,
  "newBalance": 45000
}
```

### Error Responses

#### Insufficient Balance (402 Payment Required)

```json
{
  "error": "Insufficient balance",
  "currentBalance": 3000,
  "requiredBalance": 2000,
  "shortfall": 2000
}
```

#### Provider Not Configured (503 Service Unavailable)

```json
{
  "error": "Orchestrator provider is not configured"
}
```

#### Generation Failed (502 Bad Gateway)

```json
{
  "error": "Failed to generate code with Orchestrator",
  "details": "API error details..."
}
```

## Billing Integration

### Cost Tracking

All Orchestrator generation requests are automatically logged in the billing system with:
- Provider: `orchestrator`
- Model: `Swift AI`
- Cost: 2,000 IDR per request
- Status: `SUCCESS` or `FAILED`

### Balance Management

1. **Pre-generation Check**: System verifies user has at least 2,000 IDR balance
2. **Post-generation Charge**: Upon successful generation, 2,000 IDR is deducted from user balance
3. **Failed Requests**: If generation fails, no charge is applied
4. **Refund Support**: Admins can refund failed requests using the billing service

## UI Components

### OrchestratorBadge

Display Orchestrator badge in model selector:

```tsx
import { OrchestratorBadge } from "@/components/editor/orchestrator-badge"

<OrchestratorBadge size="md" showCost={true} />
```

Props:
- `size`: "sm" | "md" (default: "md")
- `showCost`: boolean (default: true)

## API Structure

### Provider Service

Location: `lib/ai/providers/orchestrator-provider.ts`

```typescript
export class OrchestratorProvider {
  static getCost(): number // Returns 5000
  static getModel(): string // Returns "Swift AI"
  isConfigured(): boolean
  async generate(request: OrchestratorGenerateRequest): Promise<OrchestratorGenerateResponse>
}

export const orchestratorProvider = new OrchestratorProvider()
```

### Generate Endpoint

Location: `app/api/generate/orchestrator/route.ts`

- **Method**: POST
- **Auth**: Required (session user)
- **Body**:
  - `prompt`: string (required)
  - `projectId`: string (required)
  - `mode`: "CREATE" | "EXTEND" (optional, default: "CREATE")
  - `existingFiles`: GeneratedFile[] (optional)

### Billing Integration

Location: `lib/services/generate-billing.service.ts`

The service automatically:
1. Checks balance before generation
2. Charges user after successful generation
3. Logs all transactions to the database
4. Handles refunds for failed requests

## Debugging

### Check Provider Configuration

```typescript
import { orchestratorProvider } from "@/lib/ai/providers/orchestrator-provider"

console.log(orchestratorProvider.isConfigured()) // true/false
console.log(orchestratorProvider.getCost()) // 5000
```

### Check User Balance

```typescript
const balanceCheck = await GenerateBillingService.checkBalance(userId, 2000)
console.log(balanceCheck.hasBalance) // true/false
console.log(balanceCheck.currentBalance) // current balance amount
```

### View Transaction Logs

```typescript
const logs = await prisma.billingLog.findMany({
  where: { provider: "orchestrator" },
  orderBy: { createdAt: "desc" },
  take: 10,
})
```

## Troubleshooting

### Provider shows as "not configured"

**Solution**: Verify `ORCHESTRATOR_API_KEY` is set in environment variables.

```bash
# Check in development
echo $ORCHESTRATOR_API_KEY

# In production, verify in Vercel dashboard under Environment Variables
```

### Insufficient balance error

**Solution**: User needs to top up their balance before using Orchestrator.

### Generation timeout

**Solution**: The request timed out (30 second limit). This may indicate:
- Orchestrator API is slow
- Network connection issues
- Very large/complex generation request

Try again or contact support.

## Comparison with V0

| Feature | Orchestrator | V0 |
|---------|-------------|-----|
| Model | Swift AI | v0-web-generator |
| Cost | 2,000 IDR | 2,000 IDR |
| Speed | Fast | Very Fast |
| Specialization | General code generation | Web UI/Frontend |
| Provider | Swift AI-powered | V0 platform |

## Migration from V0 to Orchestrator

If you're migrating from V0:

1. Existing balances remain the same
2. Switch model in UI from "V0" to "Orchestrator - Swift AI V4 Flash"
3. API endpoints are separate (`/api/generate/orchestrator` vs `/api/generate/v0`)
4. Billing is tracked separately but costs are identical

## Support

For issues with Orchestrator integration:
1. Check the debugging section above
2. Verify API key configuration
3. Check user balance
4. Review billing logs for transaction details
5. Contact the development team with error messages

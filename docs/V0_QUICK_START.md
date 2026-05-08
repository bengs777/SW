# V0 Integration - Quick Start Guide

## Setup (5 minutes)

### 1. Add Environment Variable
```bash
V0_API_KEY=your_v0_api_key_from_v0_app_dashboard
```

### 2. Verify Configuration
- V0 API key is set
- User model has `balance` field (already exists)
- Database migrations are up to date

### 3. Test Endpoint
```bash
curl -X POST http://localhost:3000/api/generate/v0 \
  -H "Content-Type: application/json" \
  -d '{
    "prompt": "Create a login form",
    "projectId": "test-123",
    "mode": "CREATE"
  }'
```

Expected responses:
- **Success (200)**: Files generated + balance deducted
- **Insufficient Balance (402)**: User needs to top-up
- **API Error (502)**: V0 API issue

## Integration Checklist

### For Prompt Panel / Chat

```tsx
// 1. Import components
import { BalanceInfo } from "@/components/editor/balance-info"
import { V0ModelBadge } from "@/components/editor/v0-model-badge"

// 2. Add balance display
<BalanceInfo userId={userId} showAlert={true} />

// 3. Handle generation
const handleGenerate = async (prompt: string, model: string) => {
  if (model === "v0-web-generator") {
    const response = await fetch("/api/generate/v0", {
      method: "POST",
      body: JSON.stringify({
        prompt,
        projectId: projectId,
        mode: "CREATE", // or "EXTEND"
        existingFiles: currentFiles,
      }),
    })

    const data = await response.json()

    if (response.status === 402) {
      // Show: "Balance tidak cukup"
      // Show top-up button
      return
    }

    if (data.success) {
      // Update files
      setFiles(data.files)
      // Update balance
      setBalance(data.billing.newBalance)
      // Show: "Generated! Cost: 2000 IDR, New balance: X"
    } else {
      // Show error: data.error
    }
  }
}
```

### For Model Selector Dropdown

```tsx
import { ProviderBadge } from "@/components/editor/v0-model-badge"

// Display in model list
models.map(model => (
  <div key={model.key} className="flex items-center justify-between">
    <span>{model.label}</span>
    <ProviderBadge provider={model.provider} />
  </div>
))
```

## Cost Structure

| Item | Value |
|------|-------|
| Cost per generation | 2,000 IDR |
| Currency | IDR (Indonesian Rupiah) |
| Billing model | Pay-per-use |
| Minimum balance | 2,000 IDR |

## Pricing Examples

| Scenario | Balance | Generations Available | After 1 Gen |
|----------|---------|----------------------|-------------|
| New user | 100,000 | 20 | 95,000 |
| Low balance | 7,500 | 1 (with alert) | 2,500 |
| Insufficient | 3,000 | 0 (blocked) | 3,000 |

## API Response Format

### Success (200)
```json
{
  "success": true,
  "files": [
    { "path": "app/page.tsx", "content": "...", "language": "tsx" }
  ],
  "billing": {
    "provider": "v0",
    "cost": 2000,
    "currency": "IDR",
    "newBalance": 95000,
    "description": "V0 Generation - CREATE mode"
  }
}
```

### Insufficient Balance (402)
```json
{
  "error": "Insufficient balance",
  "currentBalance": 3000,
  "requiredAmount": 2000,
  "shortfall": 2000
}
```

### API Error (502)
```json
{
  "success": false,
  "error": "V0 API error: ...",
  "files": []
}
```

## Debugging

### Check V0 API Configuration
```bash
echo $V0_API_KEY
# Should output your API key
```

### Test User Balance
```bash
# Get user balance
curl http://localhost:3000/api/user/balance

# Response:
# { "userId": "123", "balance": 100000, "costPerGeneration": 2000 }
```

### Check Available Models
```bash
curl http://localhost:3000/api/models

# Should include:
# { "key": "v0-web-generator", "provider": "v0", "label": "V0 Web Generator (2000/req)" }
```

### View Transaction Logs
Check database for transactions:
```sql
-- View user balance history
SELECT * FROM billing_transactions WHERE userId = 'user-123' ORDER BY createdAt DESC;
```

## Common Issues

### "V0 API not configured"
- Set V0_API_KEY environment variable
- Verify key is correct
- Restart dev server

### "Insufficient balance" (402)
- Expected behavior
- Show user: "Balance tidak cukup. Diperlukan Rp 2.000"
- Link to top-up page

### "Generation succeeded but billing failed" (500)
- Rare edge case
- Manual refund needed
- Contact admin/support

### Balance not updating
- Component refreshes every 30s automatically
- Manual refresh: Click refresh button in BalanceInfo
- Force refresh API: `fetch("/api/user/balance")`

## Files to Modify

To integrate into your editor, update these files:

1. **Editor Page** (`app/dashboard/project/[id]/page.tsx`)
   - Add BalanceInfo component
   - Update generation handler

2. **Chat/Prompt Panel** (`components/editor/chat-panel.tsx` or similar)
   - Show V0 option in model selector
   - Display ProviderBadge
   - Handle V0 generation

3. **Header/Navigation** (optional)
   - Show balance in top bar
   - Quick access to top-up

## Testing Flow

1. **Create test user with balance = 100,000 IDR**
2. **Select V0 model from dropdown**
3. **Enter prompt: "Create a simple button component"**
4. **Click Generate**
5. **Verify**:
   - Files generated
   - Balance = 92,000 IDR (100,000 - 5,000)
   - Response includes billing info
6. **Test low balance** (set to 7,500):
   - Should show warning: "Saldo menipis"
7. **Test insufficient** (set to 2,000):
   - Should show error: "Saldo tidak cukup"
   - Cannot generate
   - Show top-up button

## Performance Notes

- V0 generation: ~3-10 seconds
- Balance check: ~100ms
- Model list refresh: ~200ms
- Balance auto-refresh: Every 30 seconds

## Security Notes

- All requests require authentication
- Balance validation happens server-side
- No client-side balance modifications
- All transactions logged for audit
- V0_API_KEY never exposed to client

## Next Steps

1. Integrate BalanceInfo component
2. Update generation handler
3. Test with sample prompts
4. Monitor error logs
5. Gather user feedback

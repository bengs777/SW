# V0.app AI Integration - 2000 IDR per Request

Dokumentasi lengkap integrasi V0.app sebagai AI code generator dengan sistem pricing 2000 IDR per request.

## Overview

Sistem ini mengintegrasikan V0.app sebagai provider AI untuk generate code dengan model pricing:
- **Cost**: 2000 IDR per request (1x generate/prompt)
- **Currency**: Indonesian Rupiah (IDR)
- **Billing**: Deduct from user balance
- **Refund**: Auto-refund jika generation gagal

## Architecture

### Components

1. **V0 Provider** (`lib/ai/providers/v0-provider.ts`)
   - Wrapper untuk V0 API
   - Handle request/response
   - Error handling & timeout management
   - Cost calculation (2000 IDR fixed)

2. **Generate Billing Service** (`lib/services/generate-billing.service.ts`)
   - Balance checking
   - Deduct balance for successful generation
   - Refund mechanism
   - Transaction logging

3. **V0 Generate Endpoint** (`app/api/generate/v0/route.ts`)
   - HTTP endpoint untuk V0 generation
   - Balance validation sebelum generation
   - Billing deduction setelah success
   - Response dengan cost breakdown

4. **Balance Info Component** (`components/editor/balance-info.tsx`)
   - Display user balance
   - Show cost per generation
   - Alert untuk low balance
   - Top-up button link

5. **Balance API** (`app/api/user/balance/route.ts`)
   - Get current user balance
   - Available generations count
   - User info

### Models API Enhancement

Updated `/app/api/models/route.ts` untuk include V0 model ketika V0_API_KEY configured.

## Setup Instructions

### 1. Environment Variables

```bash
# Add to .env atau environment configuration
V0_API_KEY=your_v0_api_key_here
```

### 2. Database

Balance field sudah ada di User model (via existing schema).

### 3. Configuration

Sistem sudah fully integrated, tidak perlu konfigurasi tambahan.

## API Endpoints

### Generate dengan V0 (POST /api/generate/v0)

**Request:**
```json
{
  "prompt": "Create a login form with validation",
  "projectId": "project-123",
  "mode": "CREATE",
  "existingFiles": []
}
```

**Success Response (200):**
```json
{
  "success": true,
  "files": [
    {
      "path": "app/page.tsx",
      "content": "...",
      "language": "tsx"
    }
  ],
  "billing": {
    "provider": "v0",
    "cost": 2000,
    "currency": "IDR",
    "newBalance": 95000,
    "description": "V0 Generation - CREATE mode"
  },
  "usage": {
    "tokens": 1500,
    "cost": 2000
  }
}
```

**Insufficient Balance (402):**
```json
{
  "error": "Insufficient balance",
  "currentBalance": 3000,
  "requiredAmount": 2000,
  "shortfall": 2000,
  "message": "Balance tidak cukup. Diperlukan Rp 2.000, saldo Anda: Rp 3.000"
}
```

**API Error (502):**
```json
{
  "success": false,
  "error": "V0 API error: ...",
  "files": []
}
```

### Get Balance (GET /api/user/balance)

**Response:**
```json
{
  "userId": "user-123",
  "balance": 100000,
  "email": "user@example.com",
  "costPerGeneration": 2000,
  "generationsAvailable": 20
}
```

## Workflow

### 1. User Input Prompt

User mengetik prompt di PromptInputPanel atau ChatPanel dan memilih model "V0 Web Generator".

### 2. Balance Check

Sebelum generate, sistem check:
- User authentication
- Available balance >= 2000 IDR
- V0 API configuration

### 3. API Call

POST ke `/api/generate/v0` dengan:
- Prompt
- Project ID
- Existing files (jika EXTEND mode)
- Mode (CREATE/EXTEND)

### 4. V0 Generation

V0 API generate code berdasarkan prompt dan context.

### 5. Billing

Jika generation succeed:
1. Deduct 2000 IDR dari user balance
2. Log transaction dengan metadata
3. Return files + billing info

Jika gagal:
- Return error
- TIDAK deduct balance
- Suggest top-up jika insufficient balance

### 6. UI Update

BalanceInfo component:
- Refresh balance setiap 30 detik
- Show alert jika low balance
- Show error jika insufficient

## Integration Points

### Editor Page

Tambahkan BalanceInfo component ke prompt panel atau header:

```tsx
import { BalanceInfo } from "@/components/editor/balance-info"

// In editor component
<BalanceInfo userId={userId} showAlert={true} />
```

### Model Selection

V0 model otomatis appear di model dropdown jika V0_API_KEY configured.

### Generation Handler

Update existing generate handler untuk:
1. Detect selected model
2. Route ke `/api/generate/v0` jika model = "v0-web-generator"
3. Handle billing response
4. Update UI dengan cost info

## Cost Calculation

```
Cost per generation = 2000 IDR (fixed)

Example:
- User balance: 100,000 IDR
- Available generations: 100,000 / 5,000 = 20 generations
- After 1 generation: 100,000 - 5,000 = 92,000 IDR
```

## Error Handling

### Insufficient Balance
- Status: 402 Payment Required
- Message: "Balance tidak cukup"
- UI: Show top-up button
- Action: User must top-up

### API Error
- Status: 502 Bad Gateway
- Message: "V0 API error: ..."
- Action: Retry atau contact support

### Charging Failure
- Status: 500 Internal Server Error
- Message: "Generation succeeded but billing failed"
- Action: Manual refund via admin panel

## Logging & Transactions

Setiap generation transaction di-log dengan:
- User ID
- Amount (2000 IDR)
- Provider (v0)
- Mode (CREATE/EXTEND)
- File count
- Timestamp

Transaction history bisa dilihat via BillingService API.

## Admin Features

### Manual Top-Up

Via existing `/api/billing/topup` endpoint atau admin panel.

### Refund

Gunakan `GenerateBillingService.refundBalance()`:
```ts
await GenerateBillingService.refundBalance(
  userId,
  5000,
  "Generation failed - API error"
)
```

### Transaction History

Access via `GenerateBillingService.getGenerationHistory()`.

## Testing

### Test Insufficient Balance
1. Create test user dengan balance = 0
2. Try generate
3. Expect 402 response

### Test Successful Generation
1. Create test user dengan balance = 10,000
2. Try generate
3. Expect 200 response + balance deducted to 5,000

### Test Low Balance Alert
1. User balance = 7,500 (< 50,000 threshold)
2. BalanceInfo component shows warning

## Security Considerations

1. **Rate Limiting**: Protected by existing rate limit middleware
2. **Authentication**: Require user session
3. **Balance Validation**: Check before every generation
4. **Billing Audit**: All transactions logged
5. **API Key**: Secure V0_API_KEY in environment

## Future Enhancements

1. **Bulk Discount**: Discounted cost for larger topups
2. **Subscription Plans**: Monthly allowance of generations
3. **Usage Analytics**: Dashboard showing cost/usage trends
4. **Refund Policy**: Auto-refund untuk failed generations
5. **Multi-Currency**: Support USD, EUR, SGD, etc.

## Support

Untuk issues atau pertanyaan:
1. Check error logs di `/app/api/generate/v0/route.ts`
2. Verify V0_API_KEY configuration
3. Check BillingService logs
4. Contact support dengan transaction ID
